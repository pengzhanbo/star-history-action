import { isInteger, promiseParallel, range, withTimeout } from '@pengzhanbo/utils'
import { GITHUB_API_URL } from '../env.js'
import { formatDate } from '../utils.js'

const API_PER_PAGE = 100 // GitHub API max items per request
const REQUEST_TIMEOUT_MS = 15000 // 15s timeout for GitHub API calls

// GitHub runners export GITHUB_API_URL; honoring it also supports enterprise GitHub.
const API_BASE = GITHUB_API_URL.replace(/\/+$/, '')

const REPO_INFO_ACCEPT = 'application/vnd.github+json'
const STARGAZERS_ACCEPT = 'application/vnd.github.v3.star+json'

// Extract the page number of the `rel="last"` link from the GitHub Link
// header. Parsing through the URL search params (instead of a positional
// regex) tolerates instances that order query params differently (e.g.
// `?page=2&per_page=100`) or omit them.
function parseLastPage(link: string): number | null {
  const match = /<([^>]+)>\s*;\s*rel="last"/.exec(link)
  if (!match) {
    return null
  }
  const parsed = Number.parseInt(new URL(match[1]!).searchParams.get('page') ?? '', 10)
  return isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseStarredAt(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value)
}

export function request(
  url: string | URL | Request,
  token: string,
  accept = REPO_INFO_ACCEPT,
): Promise<Response> {
  const headers = {
    Accept: accept,
    Authorization: `token ${token}`,
  }
  return withTimeout((signal) => fetch(url, { headers, signal }), REQUEST_TIMEOUT_MS)
}

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

export async function getRepoLogo(repo: string, token: string): Promise<string> {
  const owner = repo.split('/')[0]
  const response = await request(`${API_BASE}/users/${owner}`, token)
  if (response.ok) {
    const data = (await response.json()) as { avatar_url: string }
    return data.avatar_url || ''
  }
  return ''
}
