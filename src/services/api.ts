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
export function parseLastPage(link: string): number | null {
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
 * Merges newly fetched stargazer timestamps onto a baseline series, producing
 * the next ascending `{ date, stars }` records for the cache and charts.
 *
 * 将新抓取的 stargazer 时间戳合并到基线序列上，产出下一份按日期升序的
 * `{ date, stars }` 记录，供缓存与图表使用。
 *
 * Every stargazer on the same day collapses into one point. When the baseline's
 * last date already exists (stargazers kept arriving on that day), the point is
 * updated in place instead of appended, so the series stays strictly ascending.
 * The caller is expected to have filtered `incMs` to timestamps >= the
 * baseline's last date; the series end is re-anchored at today with the live
 * total. With no new stargazers the output is byte-stable relative to the
 * baseline (barring the final anchor date advancing), keeping unchanged reruns
 * idempotent.
 *
 * 同一天内的所有 stargazer 合并为一个点。当基线最后日期已存在时（当天仍在
 * 持续出现新 star），就地更新该点而非追加，保证序列严格升序。调用方需先将
 * `incMs` 过滤为不早于基线最后日期的时间戳；序列末尾会以实时 `total` 重新
 * 锚定到今天。没有新 stargazer 时输出相对基线字节稳定（除末尾锚点日期自然
 * 推进外），无变化的重复运行保持幂等。
 *
 * @param baseline - Ascending records from the previous run / 上一次运行的升序记录
 * @param incMs - Newly fetched `starred_at` timestamps, >= the baseline's last
 *   date, in any order / 新抓取的 `starred_at` 时间戳（不早于基线最后日期，任意顺序）
 * @param total - Live `stargazers_count` from the repo endpoint / 仓库接口的实时 `stargazers_count`
 * @returns The merged ascending records / 合并后的升序记录
 */
export function mergeStarRecords(
  baseline: { date: string; stars: number }[],
  incMs: number[],
  total: number,
): { date: string; stars: number }[] {
  const counts = new Map<string, number>()
  for (const ms of incMs) {
    const date = formatDate(ms)
    counts.set(date, (counts.get(date) ?? 0) + 1)
  }

  const merged = baseline.map((r) => ({ ...r }))
  let lastStars = merged.at(-1)?.stars ?? 0
  // Records arrive newest-first from the API; dates must be applied oldest
  // first so the count only ever grows.
  for (const date of [...counts.keys()].sort()) {
    lastStars += counts.get(date)!
    const tail = merged.at(-1)
    if (tail?.date === date) {
      // The baseline already ends on this day (more stargazers arrived on the
      // anchor date): update the point instead of breaking the ascending order.
      merged[merged.length - 1] = { date, stars: lastStars }
    } else {
      merged.push({ date, stars: lastStars })
    }
  }

  // Anchor the series end at today with the live count; never let it dip.
  const today = formatDate(Date.now())
  const tail = merged.at(-1)
  if (tail?.date === today) {
    merged[merged.length - 1] = { date: today, stars: Math.max(total, tail.stars) }
  } else {
    merged.push({ date: today, stars: total })
  }
  return merged
}

/**
 * Fetches only the stargazers added since the baseline records, merging them
 * onto the baseline for a much cheaper update than a full history fetch.
 *
 * 仅抓取自基线记录以来新增的 stargazer，并将其合并到基线上，比全量抓取
 * 历史省下大量请求。
 *
 * GitHub serves stargazers newest-first by default, so this walks pages from
 * the newest end until a page dips below the baseline's last date (probe page 1
 * is reused, only following pages are fetched). An instance that serves
 * oldest-first, an empty or undatable baseline, or an increment that outgrows
 * the request budget all degrade to the full {@link getRepoStarRecords} fetch.
 * The baseline itself is a sampled approximation for very large histories, so
 * only the *increment* is made exact — the merged series keeps the baseline's
 * pre-existing sampling error.
 *
 * GitHub 默认按 newest-first 返回 stargazer，因此本函数从最新端逐页抓取，
 * 直到某一页低于基线最后日期为止（探测用的第 1 页被复用，仅抓后续页）。
 * 以下情况都会退化为完整的 {@link getRepoStarRecords} 抓取：实例按
 * oldest-first 返回、基线为空或日期不可解析、增量超出请求预算。对于历史
 * 规模很大的仓库，基线本身是采样近似，因此只有*增量*被精确化——合并后的
 * 序列保留基线既有的采样误差。
 *
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
 * @param baseline - Ascending records from the previous run (cache baseline) /
 *   上一次运行的升序记录（缓存基线）
 * @param maxRequestAmount - Upper bound on the number of pages fetched /
 *   抓取序列时最大的页数上限
 * @returns Merged ascending records / 合并后的升序记录
 * @throws {Error} When the repo has no stars or an API response is not OK /
 *   当仓库没有 star 或 API 响应非成功状态时抛出
 */
export async function getIncrementalStarRecords(
  repo: string,
  token: string,
  baseline: { date: string; stars: number }[],
  maxRequestAmount: number,
): Promise<{ date: string; stars: number }[]> {
  const lastDateMs = Date.parse(`${baseline.at(-1)?.date}T00:00:00Z`)
  if (baseline.length === 0 || !Number.isFinite(lastDateMs)) {
    return getRepoStarRecords(repo, token, maxRequestAmount)
  }

  const repoRes = await request(`${API_BASE}/repos/${repo}`, token)
  if (!repoRes.ok) {
    throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`)
  }
  const repoData = (await repoRes.json()) as { stargazers_count: number; created_at: string }
  const total = repoData.stargazers_count ?? 0
  if (total === 0) {
    throw new Error(`Repo ${repo} has no star records`)
  }

  // Probe page 1 and reuse it as the first increment page. GitHub serves
  // newest-first by default; instances that serve oldest-first cannot cheaply
  // locate the new stargazers, so they fall back to the full fetch.
  // 探测第 1 页并复用作第一个增量页。GitHub 默认按 newest-first 返回；按
  // oldest-first 返回的实例无法廉价定位新增 stargazer，因此回退为全量抓取。
  const pageOneUrl = `${API_BASE}/repos/${repo}/stargazers?per_page=${API_PER_PAGE}&page=1`
  const pageOneRes = await request(pageOneUrl, token, STARGAZERS_ACCEPT)
  if (!pageOneRes.ok) {
    throw new Error(`Failed to get repo ${repo} star records: HTTP ${pageOneRes.status}`)
  }
  const firstPage = (await pageOneRes.json()) as { starred_at: string | number }[]
  if (firstPage.length === 0) {
    throw new Error(`Repo ${repo} has no star records`)
  }
  // Ordering is decided from how far page 1's first entry sits from the repo's
  // creation date vs. now (same comparison as the full-history fetch): page 1
  // near the creation date means oldest-first, which cannot be incrementally
  // cheap. A missing/unparseable creation date yields no signal and falls back.
  // 排序方向由第 1 页首条与创建日期、当前时刻的距离判定（与全量抓取使用同一
  // 比较）：第 1 页接近创建日期即为 oldest-first，无法廉价增量；创建日期缺失
  // 或不可解析时无信号，回退为全量抓取。
  const tFirst = parseStarredAt(firstPage[0]!.starred_at)
  const createdAtMs = Date.parse(repoData.created_at ?? '')
  if (
    !Number.isFinite(createdAtMs) ||
    Math.abs(tFirst - createdAtMs) < Math.abs(Date.now() - tFirst)
  ) {
    return getRepoStarRecords(repo, token, maxRequestAmount)
  }

  const incMs = firstPage.map((item) => parseStarredAt(item.starred_at))
  let reachedBaseline = incMs.some((ms) => ms < lastDateMs)
  // Walk from page 2 until a page dips below the baseline date, or the request
  // budget runs out. Only a reached baseline yields an incremental result.
  let page = 1
  while (!reachedBaseline && page < maxRequestAmount) {
    page++
    const raw = await getRepoStargazers(repo, token, page)
    if (raw.length === 0) {
      break
    }
    incMs.push(...raw)
    reachedBaseline = raw.some((ms) => ms < lastDateMs)
  }
  if (!reachedBaseline) {
    // The increment outgrew the budget (e.g. a massive influx since last run):
    // a partial merge would be wrong, so fall back to a full fetch.
    // 增量超出预算（例如上次运行后出现爆发式增长）：部分合并会产生错误
    // 结果，因此回退为全量抓取。
    return getRepoStarRecords(repo, token, maxRequestAmount)
  }

  // The live total minus the baseline's final count tells exactly how many
  // stargazers are new. The API cannot filter by timestamp, so the newest
  // `newCount` entries (newest-first) are the increment — a date comparison
  // alone would re-count the baseline's own final-day stargazers.
  // 实时 total 与基线最终计数的差值即新增的精确数量。API 无法按时间戳过滤，
  // 因此 newest-first 顺序下的前 `newCount` 条即增量——仅用日期比较会把基线
  // 最后一天已统计的 stargazer 重复计入。
  const newCount = Math.max(0, total - baseline[baseline.length - 1]!.stars)
  const newMs: number[] = []
  for (const ms of incMs) {
    if (newMs.length >= newCount) {
      break
    }
    newMs.push(ms)
  }
  return mergeStarRecords(baseline, newMs, total)
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
