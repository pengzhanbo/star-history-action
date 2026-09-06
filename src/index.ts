import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { info, setFailed } from '@actions/core'
import { renderRadarSvg } from './charts/radar-svg.js'
import { DEFAULT_MAX_REQUEST_AMOUNT } from './common/constants.js'
import { writeOutput } from './common/output.js'
import { rasterizeSvg } from './common/raster.js'
import { renderStarHistorySvg } from './render.js'
import { getRepoLogo, getRepoStarRecords, toBase64 } from './services/api.js'
import { getChartFilePaths, getRadarFilePaths, parseInputs } from './services/config.js'
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
  // 运行器总是导出 GITHUB_WORKSPACE；在此快速失败（而非回退到 cwd）可以防止
  // 图表写入意外的位置。
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

  // Rasterize via resvg, which loads the xkcd font from assets/xkcd.ttf so the
  // PNG text style matches the SVG (librsvg ignores the inlined @font-face).
  const chartPaths: string[] = []
  for (const { theme, svgFile, pngFile } of getChartFilePaths(config)) {
    const svg = await renderStarHistorySvg({ datasets, theme, width: config.svgWidth })
    if (config.outputFormat !== 'png') {
      chartPaths.push(await writeOutput({ outDir, workspace, file: svgFile, content: svg }))
    }
    if (pngFile) {
      chartPaths.push(
        await writeOutput({ outDir, workspace, file: pngFile, content: await rasterizeSvg(svg) }),
      )
    }
  }

  if (config.radar) {
    for (const { repo, records } of datasets) {
      const attributes = await getRepoRadarAttributes(repo, config.token, records)
      // Radar follows the same output-format rules as the history chart: `svg`
      // writes SVGs only, `png` only PNGs, `both` both — named per theme/repo.
      // 雷达图遵循与历史图相同的 output-format 规则：`svg` 仅写 SVG，`png`
      // 仅写 PNG，`both` 两者都写——按主题/仓库分别命名。
      for (const { theme, svgFile, pngFile } of getRadarFilePaths(config, repo)) {
        const svg = await renderRadarSvg(attributes, { theme })
        if (config.outputFormat !== 'png') {
          chartPaths.push(await writeOutput({ outDir, workspace, file: svgFile, content: svg }))
        }
        if (pngFile) {
          chartPaths.push(
            await writeOutput({
              outDir,
              workspace,
              file: pngFile,
              content: await rasterizeSvg(svg),
            }),
          )
        }
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
    // setFailed 记录错误信息并将运行标记为失败（退出码 1）。
    setFailed(error instanceof Error ? error.message : String(error))
  }
}

void main()
