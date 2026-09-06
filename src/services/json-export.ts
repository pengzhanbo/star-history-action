import type { RepoAttributes } from '../charts/radar-svg.js'
import type { RenderChartDataset } from '../render.js'
import type { ActionConfig } from './config.js'
import { warning } from '@actions/core'
import { writeOutput } from '../common/output.js'
import { getJsonFileName } from './config.js'
import { getRepoRadarAttributes } from './radar.js'

/**
 * Writes the JSON data export: every repo's records (plus radar scores when
 * `radar` is enabled) as structured data, and returns its workspace-relative
 * path for the commit file list. A radar fetch failure skips that repo's radar
 * block instead of failing the export.
 *
 * 写入 JSON 数据导出：将每个仓库的记录（开启 `radar` 时附带雷达分数）以
 * 结构化数据写出，并返回其工作区相对路径用于提交文件列表。雷达抓取失败
 * 仅跳过该仓库的 radar 数据块，不会使导出失败。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @param datasets - Successfully fetched datasets / 抓取成功的数据集
 * @param outDir - Output directory / 输出目录
 * @param workspace - GitHub workspace root / GitHub 工作区根
 * @returns Workspace-relative path of the written JSON file / 已写入 JSON 文件的工作区相对路径
 */
export async function writeJsonExport(
  config: ActionConfig,
  datasets: RenderChartDataset[],
  outDir: string,
  workspace: string,
): Promise<string> {
  const repos: Array<{
    repo: string
    records: { date: string; stars: number }[]
    radar?: RepoAttributes
  }> = []
  for (const { repo, records } of datasets) {
    const entry: {
      repo: string
      records: { date: string; stars: number }[]
      radar?: RepoAttributes
    } = { repo, records }
    if (config.radar) {
      try {
        entry.radar = await getRepoRadarAttributes(repo, config.token, records)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        warning(`skip radar metrics for ${repo}: ${reason}`)
      }
    }
    repos.push(entry)
  }
  const json = JSON.stringify({ updatedAt: new Date().toISOString(), repos }, null, 2)
  return writeOutput({ outDir, workspace, file: getJsonFileName(config), content: json })
}
