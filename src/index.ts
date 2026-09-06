import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { info, setFailed } from '@actions/core'
import sharp from 'sharp'
import { renderRadarSvg } from './charts/radar-svg.js'
import { DEFAULT_MAX_REQUEST_AMOUNT } from './common/constants.js'
import { renderStarHistorySvg } from './render.js'
import { getRepoLogo, getRepoStarRecords, toBase64 } from './services/api.js'
import { getChartFilePaths, getRadarFileName, parseInputs } from './services/config.js'
import { GITHUB_WORKSPACE } from './services/env.js'
import { commitAndPush } from './services/git.js'
import { getRepoRadarAttributes } from './services/radar.js'

/**
 * Runs the full action pipeline: parse → fetch → render → write → commit/push.
 *
 * 运行动作的完整流水线：解析 → 抓取 → 渲染 → 写入 → 提交/推送。
 *
 * @throws {Error} When any pipeline step fails / 当流水线任一步骤失败时抛出
 * @example
 * // Entry of the composite action; failures are reported via setFailed.
 * void main()
 */
async function run(): Promise<void> {
  const config = parseInputs()

  // The runner always exports GITHUB_WORKSPACE; failing fast here (instead of
  // falling back to cwd) keeps the chart from landing in an unexpected spot.
  if (!GITHUB_WORKSPACE) {
    throw new Error('GITHUB_WORKSPACE is not set: the action must run on a GitHub runner')
  }
  const workspace = GITHUB_WORKSPACE
  const outDir = resolve(workspace, config.outputDirectory)
  const isInsideWorkspace = outDir === workspace || outDir.startsWith(`${workspace}${sep}`)
  if (!isAbsolute(outDir) || !isInsideWorkspace) {
    throw new Error('output-directory must point inside the workspace')
  }

  // Fetch records + logo for every repo in parallel; each repo keeps its own
  // request budget so comparing repos never starves one another.
  // 并行抓取每个仓库的记录与 logo；每个仓库独立使用请求预算，互不挤占。
  const datasets = await Promise.all(
    config.repos.map(async (repo) => ({
      repo,
      records: await getRepoStarRecords(repo, config.token, DEFAULT_MAX_REQUEST_AMOUNT),
      logo: await toBase64(await getRepoLogo(repo, config.token)),
    })),
  )

  await mkdir(outDir, { recursive: true })

  const chartFiles = getChartFilePaths(config)
  for (const { theme, svgFile, pngFile } of chartFiles) {
    const svg = await renderStarHistorySvg({
      datasets,
      theme,
      width: config.svgWidth,
    })
    if (config.outputFormat !== 'png') {
      const svgPath = join(outDir, svgFile)
      await writeFile(svgPath, svg, 'utf8')
      info(`wrote ${relative(workspace, svgPath)}`)
    }
    if (pngFile) {
      // Rasterize via sharp; the embedded xkcd font falls back to a system
      // font under librsvg, so the PNG is a raster preview, not a pixel-perfect
      // copy of the SVG.
      const pngPath = join(outDir, pngFile)
      const png = await sharp(Buffer.from(svg)).png().toBuffer()
      await writeFile(pngPath, png)
      info(`wrote ${relative(workspace, pngPath)}`)
    }
  }

  const chartPaths = chartFiles.flatMap(({ svgFile, pngFile }) => {
    const files: string[] = []
    if (config.outputFormat !== 'png') {
      files.push(svgFile)
    }
    if (pngFile) {
      files.push(pngFile)
    }
    return files.map((file) => relative(workspace, join(outDir, file)))
  })

  if (config.radar) {
    for (const { repo, records } of datasets) {
      const attributes = await getRepoRadarAttributes(repo, config.token, records)
      for (const theme of config.themes) {
        const file = getRadarFileName(config, repo, theme)
        const filePath = join(outDir, file)
        const svg = await renderRadarSvg(attributes, { theme })
        await writeFile(filePath, svg, 'utf8')
        info(`wrote ${relative(workspace, filePath)}`)
        chartPaths.push(relative(workspace, filePath))
      }
    }
  }

  commitAndPush({ cwd: workspace, files: chartPaths, token: config.token })
  info('done')
}

async function main(): Promise<void> {
  try {
    await run()
  } catch (error) {
    // setFailed logs the message and marks the run failed (exit code 1).
    setFailed(error instanceof Error ? error.message : String(error))
  }
}

void main()
