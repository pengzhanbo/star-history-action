import type { RepoAttributes } from '../charts/radar-svg.js'
import type { RenderChartDataset } from '../render.js'
import type { ActionConfig } from './config.js'
import { writeOutput } from '../common/output.js'
import { getJsonFileName } from './config.js'

/**
 * Writes the JSON data export: every repo's records (plus radar scores when
 * `radar` is enabled and the pre-fetched attributes exist for that repo) as
 * structured data, and returns its workspace-relative path for the commit file
 * list. Radar attributes are fetched once up front by the caller — a repo the
 * fetch skipped simply has no `radar` block, matching the radar-fetch failure
 * semantics of the previous per-branch fetch.
 *
 * 写入 JSON 数据导出：将每个仓库的记录（开启 `radar` 且调用方预取的属性中
 * 存在该仓库时附带雷达分数）以结构化数据写出，并返回其工作区相对路径用于
 * 提交文件列表。雷达属性由调用方统一预取一次——抓取被跳过的仓库不包含
 * `radar` 数据块，与原分支各自抓取时的失败语义一致。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @param datasets - Successfully fetched datasets / 抓取成功的数据集
 * @param outDir - Output directory / 输出目录
 * @param workspace - GitHub workspace root / GitHub 工作区根
 * @param radarByRepo - Pre-fetched radar attributes per repo (absent when
 *   `radar` is off); the map only holds repos that fetched successfully /
 *   按仓库索引的预取雷达属性（`radar` 关闭时缺省）；映射仅含抓取成功的仓库
 * @returns Workspace-relative path of the written JSON file / 已写入 JSON 文件的工作区相对路径
 */
export async function writeJsonExport(
  config: ActionConfig,
  datasets: RenderChartDataset[],
  outDir: string,
  workspace: string,
  radarByRepo?: Map<string, RepoAttributes>,
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
      const radar = radarByRepo?.get(repo)
      if (radar) {
        entry.radar = radar
      }
    }
    repos.push(entry)
  }
  const json = JSON.stringify({ updatedAt: new Date().toISOString(), repos }, null, 2)
  return writeOutput({ outDir, workspace, file: getJsonFileName(config), content: json })
}
