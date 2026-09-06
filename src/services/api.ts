import { setTimeout as sleep } from 'node:timers/promises'
import { isInteger, promiseParallel, range, withTimeout } from '@pengzhanbo/utils'
import {
  API_PER_PAGE,
  MAX_RATE_LIMIT_WAIT_MS,
  REQUEST_TIMEOUT_MS,
  REPO_INFO_ACCEPT,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  STARGAZERS_ACCEPT,
} from '../common/constants.js'
import { AVATAR_SIZE, optimizeImage } from '../common/image-min.js'
import { GITHUB_API_URL } from './env.js'
import { formatDate } from './utils.js'

// GitHub runners export GITHUB_API_URL; honoring it also supports enterprise GitHub.
const API_BASE = GITHUB_API_URL.replace(/\/+$/, '')

/**
 * Extracts the page number of the `rel="last"` link from a GitHub Link header.
 *
 * 从 GitHub Link 响应头中提取 `rel="last"` 链接的页码。
 *
 * Parsing through the URL search params (instead of a positional regex)
 * tolerates instances that order query params differently (e.g.
 * `?page=2&per_page=100`) or omit them, as some GHES instances do.
 *
 * 通过 URL 查询参数解析（而非位置正则），可以兼容部分 GHES 实例中查询参数
 * 顺序不同（例如 `?page=2&per_page=100`）或省略参数的情况。
 *
 * @param link - Raw value of the `Link` response header / `Link` 响应头的原始值
 * @returns The page count, or null when the header is missing or malformed /
 *   页码总数；响应头缺失或格式非法时返回 null
 */
function parseLastPage(link: string): number | null {
  const match = /<([^>]+)>\s*;\s*rel="last"/.exec(link)
  if (!match) {
    return null
  }
  const parsed = Number.parseInt(new URL(match[1]!).searchParams.get('page') ?? '', 10)
  return isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Normalizes a `starred_at` payload — epoch ms numbers pass through,
 * ISO 8601 strings are parsed to epoch ms.
 *
 * 归一化 `starred_at` 负载——毫秒时间戳原样通过，ISO 8601 字符串解析为毫秒。
 *
 * @param value - Raw `starred_at` value / `starred_at` 原始值
 * @returns Epoch milliseconds / 毫秒级时间戳
 */
function parseStarredAt(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value)
}

/**
 * Status codes worth retrying: GitHub's rate-limit signals (403/429) and
 * server errors (5xx). Other 4xx responses (auth, not found) cannot be fixed
 * by retrying.
 *
 * 值得重试的状态码：GitHub 限流信号（403/429）与服务器错误（5xx）。
 * 其他 4xx 响应（权限、不存在等）重试无法解决。
 */
const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504])

/**
 * Fetches a URL with auth, timeout, and retry handling.
 *
 * 带认证、超时与重试处理地请求一个 URL。
 *
 * Network failures, 5xx responses, and rate limits are retried with
 * exponential backoff. On a rate limit (403/429 with `x-ratelimit-remaining:
 * 0`) the request waits for the reset when it is within
 * `MAX_RATE_LIMIT_WAIT_MS`, otherwise it fails fast with a readable error
 * that includes the reset time.
 *
 * 网络错误、5xx 响应与限流会按指数退避重试。遇到限流（403/429 且
 * `x-ratelimit-remaining: 0`）时，若重置时间在 `MAX_RATE_LIMIT_WAIT_MS`
 * 以内则等待重置后重试，否则快速失败并抛出含重置时间的可读错误。
 *
 * @param url - Request target / 请求目标
 * @param token - GitHub token used as `Authorization: token` /
 *   用于 `Authorization: token` 的 GitHub 令牌
 * @param accept - Accept header value / Accept 请求头值
 * @param retryDelayMs - Backoff base delay; tests inject a tiny value to
 *   avoid real sleeps / 退避基准延迟；测试注入极小值以避免真实等待
 * @returns The fetch response (caller must check `ok` and parse the body) /
 *   fetch 响应（调用方需检查 `ok` 并解析响应体）
 */
export async function request(
  url: string | URL | Request,
  token: string,
  accept = REPO_INFO_ACCEPT,
  retryDelayMs = RETRY_BASE_DELAY_MS,
): Promise<Response> {
  const headers = {
    Accept: accept,
    Authorization: `token ${token}`,
  }

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await withTimeout((signal) => fetch(url, { headers, signal }), REQUEST_TIMEOUT_MS)
    } catch (error) {
      // Network-level failure (DNS, connection, timeout): back off and retry,
      // surfacing the error only once the last attempt has failed.
      // 网络层失败（DNS、连接、超时）：退避后重试，最后一次尝试仍失败才抛出。
      if (attempt < RETRY_MAX_ATTEMPTS - 1) {
        await sleep(retryDelayMs * 2 ** attempt)
        continue
      }
      throw error instanceof Error ? error : new Error(String(error))
    }

    // Success, or a status retrying cannot fix: return it as-is.
    // 成功或重试无法解决的状态码：原样返回。
    if (res.ok || !RETRYABLE_STATUS.has(res.status)) {
      return res
    }

    // GitHub rate limit: 403/429 with no remaining quota. Sleep until the
    // reset when it is close enough; otherwise fail fast with a readable
    // error carrying the reset time (the callers would only echo "HTTP 403").
    // GitHub 限流：403/429 且剩余配额为 0。重置时间足够近时睡到重置再试，
    // 否则快速失败并抛出含重置时间的可读错误（调用方只会报 "HTTP 403"）。
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const resetSec = Number(res.headers.get('x-ratelimit-reset') ?? 0)
      const waitMs = resetSec * 1000 - Date.now()
      if (
        resetSec > 0 &&
        waitMs > 0 &&
        waitMs <= MAX_RATE_LIMIT_WAIT_MS &&
        attempt < RETRY_MAX_ATTEMPTS - 1
      ) {
        await sleep(waitMs)
        continue
      }
      const resetAt = resetSec > 0 ? new Date(resetSec * 1000).toISOString() : 'unknown'
      throw new Error(
        `GitHub API rate limit exceeded (HTTP ${res.status}); quota resets at ${resetAt}`,
      )
    }

    if (attempt < RETRY_MAX_ATTEMPTS - 1) {
      await sleep(retryDelayMs * 2 ** attempt)
      continue
    }
    return res
  }
  // Unreachable: every iteration above returns or throws.
  throw new Error('request retries exhausted')
}

/**
 * Fetches one page of stargazers and returns their `starred_at` timestamps.
 *
 * 抓取一页 stargazer 并返回其 `starred_at` 时间戳。
 *
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @param page - Page number; defaults to page 1 / 页码，默认为第 1 页
 * @returns Epoch-ms `starred_at` values for the page, in GitHub's page order /
 *   该页的 `starred_at` 毫秒值，顺序与 GitHub 返回的页内顺序一致
 * @throws {Error} When the API response is not OK / 当 API 响应非成功状态时抛出
 */
export async function getRepoStargazers(
  repo: string,
  token: string,
  page?: number,
): Promise<number[]> {
  const url = `${API_BASE}/repos/${repo}/stargazers?per_page=${API_PER_PAGE}${page ? `&page=${page}` : ''}`
  const res = await request(url, token, STARGAZERS_ACCEPT)
  if (!res.ok) {
    throw new Error(`Failed to get repo ${repo} stargazers: HTTP ${res.status}`)
  }
  const data = (await res.json()) as { starred_at: string | number }[]

  // GitHub returns ISO 8601 strings; epoch ms is what callers consume.
  return data.map((item) => parseStarredAt(item.starred_at))
}

/**
 * Builds an ascending `{ date, stars }` series for the repository's history.
 *
 * 构建仓库历史的按日期升序 `{ date, stars }` 序列。
 *
 * When the history fits within the request budget, every stargazer is counted
 * for a full per-day series. Larger repositories are sampled: one boundary
 * point per page, each within ±100 stars of the real count. Page ordering is
 * detected from the repo's creation date, falling back to newest-first for
 * entries older than the GitHub default fetch of stargazers.
 *
 * 当历史规模在请求预算以内时，会统计每个 stargazer 生成完整的按日序列；
 * 更大的仓库则采样每个页面的一个边界点，每点与真实数量误差在 ±100 以内。
 * 页码顺序根据仓库创建日期判定，缺失创建日期时回退到 newest-first。
 *
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @param maxRequestAmount - Upper bound on the number of pages fetched /
 *   抓取序列时最大的页数上限
 * @returns Star records ascending by date / 按日期升序的 star 记录
 * @throws {Error} When the repo has no stars or an API response is not OK /
 *   当仓库没有 star 或 API 响应非成功状态时抛出
 */
export async function getRepoStarRecords(
  repo: string,
  token: string,
  maxRequestAmount: number,
): Promise<{ date: string; stars: number }[]> {
  const repoRes = await request(`${API_BASE}/repos/${repo}`, token)
  if (!repoRes.ok) {
    throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`)
  }
  const repoData = (await repoRes.json()) as { stargazers_count: number; created_at: string }
  const total = repoData.stargazers_count ?? 0
  const createdAt = repoData.created_at ?? ''
  if (total === 0) {
    throw new Error(`Repo ${repo} has no star records`)
  }

  // Fetch page 1 directly so its `Link` header can be read before parsing.
  const pageOneUrl = `${API_BASE}/repos/${repo}/stargazers?per_page=${API_PER_PAGE}&page=1`
  const pageOneRes = await request(pageOneUrl, token, STARGAZERS_ACCEPT)
  if (!pageOneRes.ok) {
    throw new Error(`Failed to get repo ${repo} star records: HTTP ${pageOneRes.status}`)
  }
  // A missing or malformed `last` link degrades to a single page.
  const pageCount = parseLastPage(pageOneRes.headers.get('link') ?? '') ?? 1
  const firstPage = (await pageOneRes.json()) as { starred_at: string | number }[]
  const firstPageMs = firstPage.map((item) => parseStarredAt(item.starred_at))
  if (firstPageMs.length === 0) {
    throw new Error(`Repo ${repo} has no star records`)
  }

  const sampled = pageCount > maxRequestAmount
  // Spread `maxRequestAmount` pages evenly across the history, always
  // including page 1 and the last page (strictly ascending). Full history
  // only needs pages after 1: page 1 was already parsed above.
  const pages = sampled
    ? Array.from(
        { length: maxRequestAmount },
        (_, k) => 1 + Math.floor(((pageCount - 1) * k) / (maxRequestAmount - 1)),
      )
    : range(2, pageCount + 1)
  // Reuse the parsed page 1 instead of refetching it (saves one request in
  // both modes); only the remaining pages are fetched in parallel.
  const pageData = new Map<number, number[]>()
  pageData.set(1, firstPageMs)
  const restPages = pages.filter((page) => page !== 1)
  const restData = await promiseParallel(
    restPages.map((page) => getRepoStargazers(repo, token, page)),
  )
  restPages.forEach((page, i) => pageData.set(page, restData[i]!))

  // Date-keyed so several stargazers on one day collapse into a single point.
  const records = new Map<string, number>()
  if (!sampled) {
    // Full history: count every stargazer at its own date, oldest first.
    const sorted = [...pageData.values()].flat().sort((a, b) => a - b)
    sorted.forEach((ms, i) => records.set(formatDate(ms), i + 1))
  } else {
    // Sampled history: one boundary point per fetched page. Each point is an
    // approximation within ±100 stars of the real count (inherent to sampling).
    // Page 1 may be served oldest-first or newest-first depending on the
    // GitHub instance; decide from how far page 1's first entry sits from the
    // repo's creation date vs. now. If a live run ever shows a visibly wrong
    // series, this comparison is the suspect: flip the operator and re-test.
    // A missing/unparseable creation date (NaN) yields no ordering signal, so
    // fall back to newest-first, GitHub's default ordering for stargazers.
    const tFirst = firstPageMs[0]!
    const createdAtMs = Date.parse(createdAt)
    const ascending =
      Number.isFinite(createdAtMs) && Math.abs(tFirst - createdAtMs) < Math.abs(Date.now() - tFirst)
    pages.forEach((page) => {
      const arr = pageData.get(page)!
      if (arr.length === 0) {
        return
      }
      const boundaryMs = ascending ? arr[0]! : arr[arr.length - 1]!
      const count = ascending ? (page - 1) * API_PER_PAGE : total - page * API_PER_PAGE
      records.set(formatDate(boundaryMs), count)
    })
  }

  // Anchor the series end at today with the final count.
  records.set(formatDate(Date.now()), total)

  return [...records]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stars]) => ({ date, stars }))
}

/**
 * Fetches the owner's avatar URL, or `''` when the user lookup fails.
 *
 * 获取所有者的头像 URL；用户查询失败时返回空字符串。
 *
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @returns The owner's avatar URL, or `''` on failure / 所有者的头像 URL，失败时为空字符串
 */
export async function getRepoLogo(repo: string, token: string): Promise<string> {
  const owner = repo.split('/')[0]
  const response = await request(`${API_BASE}/users/${owner}`, token)
  if (response.ok) {
    const data = (await response.json()) as { avatar_url: string }
    if (!data.avatar_url) {
      return ''
    }
    // Request a small avatar at the source so the embedded base64 stays small.
    const url = new URL(data.avatar_url)
    url.searchParams.set('s', String(AVATAR_SIZE))
    return url.toString()
  }
  return ''
}

export async function toBase64(url: string): Promise<string> {
  if (!url) {
    return ''
  }

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`)
  }
  const type = res.headers.get('content-type') ?? ''
  if (!/^image\//i.test(type)) {
    throw new Error(`unexpected content-type "${type || 'none'}"`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const compressed = Buffer.from(await optimizeImage(buf))
  return `data:${type};base64,${compressed.toString('base64')}`
}
