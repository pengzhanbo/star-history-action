import type { RepoAttributes } from '../charts/radar-svg.js'
import { warning } from '@actions/core'
import { API_PER_PAGE } from '../common/constants.js'
import { parseLastPage, request } from './api.js'
import { GITHUB_API_URL } from './env.js'
import { formatDate } from './utils.js'

// GitHub runners export GITHUB_API_URL; honoring it also supports enterprise GitHub.
const API_BASE = GITHUB_API_URL.replace(/\/+$/, '')

/**
 * Maps a raw metric count to a 0–99 radar score using a base-10 log scale:
 * each ~10x growth adds ~33 points (1 → 3, 1e3 → 33, 1e6 → 66), capped at 99.
 * GitHub exposes no percentile API, so this is a relative intensity score
 * rather than a true percentile.
 *
 * 用十进制对数刻度把原始指标数量映射为 0–99 的雷达分数：每增长约 10 倍
 * 加约 33 分（1 → 3，1e3 → 33，1e6 → 66），封顶 99。GitHub 不提供百分位
 * API，因此这是相对的强度分数而非真实的百分位。
 *
 * @param count - Raw metric count / 原始指标数量
 * @returns A score in [0, 99] / [0, 99] 范围内的分数
 */
export function percentileOf(count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0
  }
  return Math.min(99, Math.round((Math.log10(count + 1) / 3) * 33))
}

/**
 * Counts the stars gained in the last `days` days from an ascending star
 * record series (the newest record is anchored at today).
 *
 * 从升序的 star 记录序列（最新一条锚定在今天）统计最近 `days` 天的新增 star。
 *
 * @param records - Ascending `{ date, stars }` series / 升序 `{ date, stars }` 序列
 * @param days - Lookback window in days, default 30 / 回看窗口（天），默认 30
 * @returns New stars in the window / 窗口内的新增 star 数
 */
export function newStarsInLastDays(records: { date: string; stars: number }[], days = 30): number {
  if (records.length === 0) {
    return 0
  }
  const cutoffDate = formatDate(Date.now() - days * 86_400_000)
  let base = 0
  for (const record of records) {
    if (record.date <= cutoffDate) {
      base = record.stars
    } else {
      break
    }
  }
  const last = records[records.length - 1]!
  return Math.max(0, last.stars - base)
}

/**
 * Approximates the total count of a paginated GitHub list endpoint from its
 * `Link` header: `lastPage * perPage`. Returns null when the header is missing
 * (a single page or an endpoint without paging info).
 *
 * 依据 `Link` 响应头近似分页 GitHub 列表端点的总数：`lastPage * perPage`。
 * 响应头缺失（单页或端点无分页信息）时返回 null。
 *
 * @param link - Raw `Link` header value / `Link` 响应头的原始值
 * @returns An estimated count, or null when unpaginated / 估计数量；无分页时返回 null
 */
function estimateTotal(link: string | null): number | null {
  const last = link ? parseLastPage(link) : null
  return last == null ? null : last * API_PER_PAGE
}

/**
 * Fetches the six radar metrics for a repository and maps them to 0–99 scores.
 *
 * 抓取仓库的六项雷达指标并映射为 0–99 分数。
 *
 * Metric sources (each a single API call): `/repos/{repo}` gives stars and
 * forks; contributors and commits are approximated from the pagination of
 * `per_page=1` list calls; closed issues come from the search API. `new_stars`
 * is derived from the already-fetched star records (no extra request).
 *
 * 指标来源（各一次 API 调用）：`/repos/{repo}` 提供 stars 与 forks；contributors
 * 与 commits 依据 `per_page=1` 列表调用的分页近似；issues_closed 来自搜索 API。
 * `new_stars` 从已抓取的 star 记录推导（无额外请求）。
 *
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @param records - Ascending star records from getRepoStarRecords /
 *   getRepoStarRecords 返回的升序 star 记录
 * @returns The radar attributes with 0–99 scores / 0–99 分数的雷达属性
 * @throws {Error} When the repo lookup fails / 当仓库查询失败时抛出
 */
export async function getRepoRadarAttributes(
  repo: string,
  token: string,
  records: { date: string; stars: number }[],
): Promise<RepoAttributes> {
  const repoRes = await request(`${API_BASE}/repos/${repo}`, token)
  if (!repoRes.ok) {
    throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`)
  }
  const repoData = (await repoRes.json()) as {
    stargazers_count: number
    forks_count: number
  }

  const [contributorsRes, commitsRes, issuesRes] = await Promise.all([
    request(`${API_BASE}/repos/${repo}/contributors?per_page=1`, token),
    request(`${API_BASE}/repos/${repo}/commits?per_page=1`, token),
    request(
      `${API_BASE}/search/issues?q=${encodeURIComponent(`repo:${repo} is:closed`)}&per_page=1`,
      token,
    ),
  ])

  const contributors = estimateTotal(contributorsRes.headers.get('link')) ?? 0
  const pushes = estimateTotal(commitsRes.headers.get('link')) ?? 0
  const issuesClosed = issuesRes.ok
    ? (((await issuesRes.json()) as { total_count: number }).total_count ?? 0)
    : 0

  return {
    stars: percentileOf(repoData.stargazers_count ?? 0),
    new_stars: percentileOf(newStarsInLastDays(records)),
    pushes: percentileOf(pushes),
    contributors: percentileOf(contributors),
    issues_closed: percentileOf(issuesClosed),
    forks: percentileOf(repoData.forks_count ?? 0),
  }
}

/**
 * One dataset's star records — all `getRepoRadarAttributes` needs from it.
 *
 * 单个数据集的 star 记录——`getRepoRadarAttributes` 所需的全部数据。
 */
interface RadarDataset {
  repo: string
  records: { date: string; stars: number }[]
}

/**
 * Fetches the radar attributes for every dataset in parallel, once per repo.
 * A failing repo is skipped with a warning (mirroring `fetchDatasets`'
 * partial-success policy) so the survivors still export — calling this once and
 * sharing the result between the JSON export and the radar charts keeps a
 * format list like `svg,png,json` from doubling the radar API requests.
 *
 * 为每个数据集并行抓取雷达属性，每个仓库只抓取一次。失败的仓库以 warning
 * 跳过（沿用 `fetchDatasets` 的部分成功策略），其余仓库照常导出——调用一次
 * 并在 JSON 导出与雷达图之间共享结果，可避免 `svg,png,json` 这类格式列表
 * 将雷达 API 请求翻倍。
 *
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @param datasets - Fetched datasets, one entry per repo / 抓取成功的数据集，每个仓库一条
 * @returns A map from `owner/repo` to its attributes, containing only the
 *   repos that fetched successfully / 从 `owner/repo` 到属性的映射，仅含抓取成功的仓库
 */
export async function getRepoRadarAttributesMap(
  token: string,
  datasets: RadarDataset[],
): Promise<Map<string, RepoAttributes>> {
  const settled = await Promise.allSettled(
    datasets.map(({ repo, records }) => getRepoRadarAttributes(repo, token, records)),
  )
  const attributesByRepo = new Map<string, RepoAttributes>()
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      attributesByRepo.set(datasets[i]!.repo, result.value)
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      warning(`skip radar metrics for ${datasets[i]!.repo}: ${reason}`)
    }
  })
  return attributesByRepo
}
