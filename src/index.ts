import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { info, setFailed } from '@actions/core'
import { renderRadarSvg } from './charts/radar-svg.js'
import { writeOutput } from './common/output.js'
import { rasterizeSvg } from './common/raster.js'
import { renderStarHistorySvg } from './render.js'
import { readCacheRecords, serializeCache } from './services/cache.js'
import {
  getCacheFileName,
  getChartFilePaths,
  getRadarFilePaths,
  parseInputs,
} from './services/config.js'
import { GITHUB_WORKSPACE } from './services/env.js'
import { fetchDatasets } from './services/fetch.js'
import { commitAndPush } from './services/git.js'
import { writeJsonExport } from './services/json-export.js'
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

  // With cache: true the previous run's cache file (if any) is the incremental
  // baseline; a missing or unreadable file simply means a full first fetch.
  // 启用 cache 时，上一次运行的缓存文件（若存在）即增量基线；文件缺失或
  // 不可读时首次运行将执行全量抓取。
  const baselineByRepo = config.cache
    ? await readCacheRecords(resolve(outDir, getCacheFileName(config)))
    : null
  const datasets = await fetchDatasets(config, baselineByRepo ?? undefined)

  await mkdir(outDir, { recursive: true })

  const files: string[] = []
  if (config.outputFormat === 'json') {
    // JSON output: structured data instead of charts. No avatar was fetched
    // above (includeLogo is false), so this branch only touches the records.
    // JSON 输出：以结构化数据代替图表。上方未抓取头像（includeLogo 为
    // false），因此此分支只接触记录。
    files.push(await writeJsonExport(config, datasets, outDir, workspace))
  } else {
    // Rasterize via resvg, which loads the xkcd font from assets/xkcd.ttf so
    // the PNG text style matches the SVG (librsvg ignores the inlined
    // @font-face).
    for (const { theme, svgFile, pngFile } of getChartFilePaths(config)) {
      const svg = await renderStarHistorySvg({ datasets, theme, width: config.svgWidth })
      if (config.outputFormat !== 'png') {
        files.push(await writeOutput({ outDir, workspace, file: svgFile, content: svg }))
      }
      if (pngFile) {
        files.push(
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
            files.push(await writeOutput({ outDir, workspace, file: svgFile, content: svg }))
          }
          if (pngFile) {
            files.push(
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
  }

  // The refreshed baseline rides along so the next run can fetch incrementally.
  // Its bytes only change when the records do, keeping unchanged reruns
  // idempotent (no staged diff → no empty commit).
  // 刷新后的基线一并提交，供下一次运行增量抓取。其字节仅在记录变化时才
  // 改变，无变化的重复运行保持幂等（无暂存差异 → 无空提交）。
  if (config.cache) {
    files.push(
      await writeOutput({
        outDir,
        workspace,
        file: getCacheFileName(config),
        content: serializeCache(datasets),
      }),
    )
  }

  commitAndPush({ cwd: workspace, files, token: config.token })
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
