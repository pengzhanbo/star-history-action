import type { RenderChartDataset } from '../render.js'
import type { ActionConfig } from './config.js'
import { warning } from '@actions/core'
import { DEFAULT_MAX_REQUEST_AMOUNT } from '../common/constants.js'
import { getRepoLogo, getRepoStarRecords, toBase64 } from './api.js'

/**
 * Fetches star records (+ the owner avatar when the SVG families need it) for
 * every repo in parallel; each repo keeps its own request budget so comparing
 * repos never starves one another. A single failing repo (404, rate limit,
 * empty history) only skips that repo: the others still chart, and the failure
 * is reported as a warning. Only when every repo fails does the run fail —
 * there is nothing left to write.
 *
 * 并行抓取每个仓库的 star 记录（SVG 图表家族需要时还包括所有者头像）；
 * 每个仓库独立使用请求预算，互不挤占。单个仓库失败（404、限流、无 star）
 * 仅跳过该仓库：其余仓库照常出图，失败以 warning 记录。仅当全部仓库都
 * 失败时才失败——此时已无任何可写内容。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns Datasets for the repos that fetched successfully / 抓取成功的仓库数据集
 * @throws {Error} When every repo fails to fetch / 当所有仓库都抓取失败时抛出
 */
export async function fetchDatasets(config: ActionConfig): Promise<RenderChartDataset[]> {
  const settled = await Promise.allSettled(
    config.repos.map(async (repo) => ({
      repo,
      records: await getRepoStarRecords(repo, config.token, DEFAULT_MAX_REQUEST_AMOUNT),
      // A logo fetch failure degrades to no logo instead of dropping the repo.
      logo: config.includeLogo
        ? await toBase64(await getRepoLogo(repo, config.token)).catch(() => '')
        : '',
    })),
  )
  const datasets: RenderChartDataset[] = []
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      datasets.push(result.value)
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      warning(`skip ${config.repos[i]}: ${reason}`)
    }
  })
  if (datasets.length === 0) {
    throw new Error('no repository data could be fetched; see warnings above for per-repo failures')
  }
  return datasets
}
