import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { info, setFailed } from '@actions/core'
import { Resvg } from '@resvg/resvg-js'
import { renderRadarSvg } from './charts/radar-svg.js'
import { DEFAULT_MAX_REQUEST_AMOUNT } from './common/constants.js'
import { renderStarHistorySvg } from './render.js'
import { getRepoLogo, getRepoStarRecords, toBase64 } from './services/api.js'
import { getChartFilePaths, getRadarFileName, parseInputs } from './services/config.js'
import { GITHUB_WORKSPACE } from './services/env.js'
import { commitAndPush } from './services/git.js'
import { getRepoRadarAttributes } from './services/radar.js'

/**
 * Extracts the CSS background color from a generated SVG (`style="background:…"`),
 * so the rasterizer can paint the same backdrop as the browser would.
 *
 * 从生成的 SVG 中提取 CSS 背景色（`style="background:…"`），使栅格化输出与
 * 浏览器渲染的底色一致。
 *
 * @param svg - Serialized chart SVG / 序列化的图表 SVG
 * @returns The background color, or undefined for transparent / 背景色；透明时返回 undefined
 */
function svgBackground(svg: string): string | undefined {
  const match = /background:([^;"']+)/.exec(svg)
  const bg = match?.[1]?.trim()
  return bg && bg !== 'transparent' ? bg : undefined
}

/**
 * Rasterizes a chart SVG to PNG via resvg.
 *
 * 通过 resvg 将图表 SVG 栅格化为 PNG。
 *
 * Unlike librsvg (sharp's engine), resvg loads the xkcd font explicitly from
 * `assets/xkcd.ttf`, so the PNG text style matches the SVG instead of falling
 * back to a system font. The font path resolves from the action repo root —
 * the composite action runs with `working-directory: ${{ github.action_path }}`
 * and both local and e2e runs use the repo root, mirroring `font-subset.ts`.
 *
 * 与 librsvg（sharp 的底层引擎）不同，resvg 显式从 `assets/xkcd.ttf` 加载
 * xkcd 字体，因此 PNG 的文字样式与 SVG 一致，而不会回退到系统字体。字体
 * 路径基于 action 仓库根解析——composite action 以
 * `working-directory: ${{ github.action_path }}` 运行，本地与 e2e 同样在
 * 仓库根运行，与 `font-subset.ts` 一致。
 *
 * @param svg - Chart SVG string / 图表 SVG 字符串
 * @param width - Output width in px; height follows the SVG aspect ratio /
 *   输出宽度（像素）；高度按 SVG 宽高比缩放
 * @returns PNG bytes / PNG 字节
 */
function rasterizeSvg(svg: string, width: number): Buffer {
  const background = svgBackground(svg)
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontFiles: [resolve('assets/xkcd.ttf')],
      loadSystemFonts: false,
      defaultFontFamily: 'xkcd',
    },
    ...(background ? { background } : {}),
  })
  return resvg.render().asPng()
}

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
      // Rasterize via resvg, which loads the xkcd font from assets/xkcd.ttf so
      // the PNG text style matches the SVG (librsvg ignores the inlined
      // @font-face and falls back to a system font).
      const pngPath = join(outDir, pngFile)
      const png = rasterizeSvg(svg, config.svgWidth)
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
