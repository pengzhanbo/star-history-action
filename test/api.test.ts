import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  getIncrementalStarRecords,
  getRepoLogo,
  getRepoStarRecords,
  getRepoStargazers,
  mergeStarRecords,
  request,
} from '../src/services/api.js'
import { formatDate } from '../src/services/utils.js'

// api.ts computes API_BASE from GITHUB_API_URL at module evaluation; pin it
// so the asserted request URLs stay deterministic.
vi.hoisted(() => {
  process.env['GITHUB_API_URL'] = 'https://api.github.test'
})

const TOKEN = 'test-token'
const REPO_INFO_ACCEPT = 'application/vnd.github+json'
const STARGAZERS_ACCEPT = 'application/vnd.github.v3.star+json'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function stargazerAt(iso: string): { starred_at: string } {
  return { starred_at: iso }
}

// Mirrors the GitHub `Link` header format that api.ts parses for the page count.
function linkHeader(next: number, last: number): Record<string, string> {
  const base = 'https://api.github.test/repos/owner/repo/stargazers?per_page=100'
  return {
    link: `<${base}&page=${next}&per_page=100>; rel="next", <${base}&page=${last}&per_page=100>; rel="last"`,
  }
}

// The action only ever fetch()es string URLs; this keeps URL extraction
// type-safe (no implicit Object stringification) for mock introspection.
function callUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

function stargazerUrls(): string[] {
  return fetchMock.mock.calls
    .map((call) => callUrl(call[0]))
    .filter((url) => url.includes('/stargazers'))
}

describe('request', () => {
  it('sends the token as Authorization and the default repo-info Accept header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await request('https://api.github.test/x', TOKEN)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.github.test/x')
    expect(fetchMock.mock.calls[0]![1]).toEqual({
      headers: { Accept: REPO_INFO_ACCEPT, Authorization: `token ${TOKEN}` },
      signal: expect.any(AbortSignal),
    })
  })

  it('passes the stargazers Accept header through', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))

    await request('https://api.github.test/x', TOKEN, STARGAZERS_ACCEPT)

    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Accept: STARGAZERS_ACCEPT,
    })
  })

  it('retries a 5xx response with backoff and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, {}, 503))
      .mockResolvedValueOnce(jsonResponse({}))

    await request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure and succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({}))

    await request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the last response when every 5xx retry fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, {}, 503))

    const res = await request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('surfaces the last network error once retries are exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)).rejects.toThrow(
      'fetch failed',
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-retryable 4xx responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, {}, 404))

    const res = await request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)

    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('waits for a near rate-limit reset and retries', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 1
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {},
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({}))

    await request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails fast with the reset time when the rate-limit reset is too far away', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600
    fetchMock.mockResolvedValue(
      jsonResponse(
        {},
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) },
        403,
      ),
    )

    await expect(request('https://api.github.test/x', TOKEN, REPO_INFO_ACCEPT, 0)).rejects.toThrow(
      /GitHub API rate limit exceeded \(HTTP 403\); quota resets at \d{4}-\d{2}-\d{2}T/,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('getRepoStargazers', () => {
  it('maps starred_at ISO strings to epoch ms and requests the given page', async () => {
    fetchMock.mockResolvedValue(jsonResponse([stargazerAt('2024-01-05T00:00:00Z')]))

    await expect(getRepoStargazers('owner/repo', TOKEN, 2)).resolves.toEqual([
      Date.parse('2024-01-05T00:00:00Z'),
    ])
    expect(stargazerUrls()).toEqual([
      'https://api.github.test/repos/owner/repo/stargazers?per_page=100&page=2',
    ])
  })

  it('omits the page param when not requested', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))

    await getRepoStargazers('owner/repo', TOKEN)

    expect(stargazerUrls()).toEqual([
      'https://api.github.test/repos/owner/repo/stargazers?per_page=100',
    ])
  })

  it('passes numeric starred_at through untouched', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ starred_at: 1700000000000 }]))

    await expect(getRepoStargazers('owner/repo', TOKEN)).resolves.toEqual([1700000000000])
  })

  it('throws on a failed response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, {}, 404))

    await expect(getRepoStargazers('owner/repo', TOKEN)).rejects.toThrow(
      'Failed to get repo owner/repo stargazers: HTTP 404',
    )
  })
})

describe('getRepoLogo', () => {
  it('returns the owner avatar_url', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ avatar_url: 'https://avatars.test/o.png' }))

    await expect(getRepoLogo('owner/repo', TOKEN)).resolves.toBe('https://avatars.test/o.png?s=128')
    expect(callUrl(fetchMock.mock.calls[0]![0])).toBe('https://api.github.test/users/owner')
  })

  it('returns an empty string on a failed response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, {}, 404))

    await expect(getRepoLogo('owner/repo', TOKEN)).resolves.toBe('')
  })

  it('returns an empty string when avatar_url is empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ avatar_url: '' }))

    await expect(getRepoLogo('owner/repo', TOKEN)).resolves.toBe('')
  })
})

describe('getRepoStarRecords', () => {
  const TODAY = formatDate(Date.now())

  // Serves a mock repo info + one page of stargazers per entry in `pages`.
  // Page 1 additionally carries the given Link header; every entry in a page
  // shares one date so each page collapses into a single record.
  function mockPages(options: {
    total: number
    createdAt: string
    pages: Record<number, { starred_at: string }[]>
    linkHeader?: Record<string, string>
  }): void {
    fetchMock.mockImplementation(async (input) => {
      const url = callUrl(input)
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ stargazers_count: options.total, created_at: options.createdAt })
      }
      if (url.includes('/stargazers')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1')
        const body = options.pages[page] ?? []
        return jsonResponse(body, page === 1 ? (options.linkHeader ?? {}) : {})
      }
      return jsonResponse({}, {}, 404)
    })
  }

  it('throws when the repo info request fails', async () => {
    mockPages({ total: 0, createdAt: '2024-01-01T00:00:00Z', pages: {} })
    fetchMock.mockImplementation(async () => jsonResponse({}, {}, 404))

    await expect(getRepoStarRecords('owner/repo', TOKEN, 15)).rejects.toThrow(
      'Failed to get repo owner/repo info: HTTP 404',
    )
  })

  it('throws when the repo has no stars', async () => {
    mockPages({ total: 0, createdAt: '2024-01-01T00:00:00Z', pages: { 1: [] } })

    await expect(getRepoStarRecords('owner/repo', TOKEN, 15)).rejects.toThrow(
      'Repo owner/repo has no star records',
    )
  })

  it('throws when page 1 fails', async () => {
    mockPages({ total: 10, createdAt: '2024-01-01T00:00:00Z', pages: {} })
    fetchMock.mockImplementation(async (input) => {
      const url = callUrl(input)
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ stargazers_count: 10, created_at: '2024-01-01T00:00:00Z' })
      }
      return jsonResponse({}, {}, 404)
    })

    await expect(getRepoStarRecords('owner/repo', TOKEN, 15)).rejects.toThrow(
      'Failed to get repo owner/repo star records: HTTP 404',
    )
  })

  it('throws when page 1 is empty', async () => {
    mockPages({ total: 10, createdAt: '2024-01-01T00:00:00Z', pages: { 1: [] } })

    await expect(getRepoStarRecords('owner/repo', TOKEN, 15)).rejects.toThrow(
      'Repo owner/repo has no star records',
    )
  })

  it('counts every stargazer per day when the history fits within the request budget', async () => {
    mockPages({
      total: 150,
      createdAt: '2024-01-01T00:00:00Z',
      pages: {
        1: Array.from({ length: 100 }, () => stargazerAt('2024-01-05T00:00:00Z')),
        2: Array.from({ length: 50 }, () => stargazerAt('2024-02-10T00:00:00Z')),
      },
      linkHeader: linkHeader(2, 2),
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    expect(records).toEqual([
      { date: '2024-01-05', stars: 100 },
      { date: '2024-02-10', stars: 150 },
      { date: TODAY, stars: 150 },
    ])
    // repo info + page 1 (Link parse) + page 2 (the only remaining page)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(stargazerUrls().sort()).toEqual([
      'https://api.github.test/repos/owner/repo/stargazers?per_page=100&page=1',
      'https://api.github.test/repos/owner/repo/stargazers?per_page=100&page=2',
    ])
  })

  it('reads the page count from the Link header and treats one page as full history', async () => {
    mockPages({
      total: 50,
      createdAt: '2024-01-01T00:00:00Z',
      pages: { 1: Array.from({ length: 50 }, () => stargazerAt('2024-03-01T00:00:00Z')) },
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    expect(records).toEqual([
      { date: '2024-03-01', stars: 50 },
      { date: TODAY, stars: 50 },
    ])
    // Page 1 is fetched once for the Link probe and reused as the data.
    expect(stargazerUrls().filter((url) => url.includes('page=1')).length).toBe(1)
  })

  it('parses GHES-style Link headers that order query params differently', async () => {
    // Enterprise instances may emit `?page=N&per_page=100` (page first) or
    // omit `per_page`; parsing must not depend on GitHub's param order.
    const base = 'https://ghe.test/repos/owner/repo/stargazers'
    mockPages({
      total: 120,
      createdAt: '2024-01-01T00:00:00Z',
      pages: {
        1: Array.from({ length: 100 }, () => stargazerAt('2024-01-10T00:00:00Z')),
        2: Array.from({ length: 20 }, () => stargazerAt('2024-02-10T00:00:00Z')),
      },
      linkHeader: {
        link: `<${base}?page=2&per_page=100>; rel="next", <${base}?page=2>; rel="last"`,
      },
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    // 2 pages → full history, both pages counted.
    expect(records).toEqual([
      { date: '2024-01-10', stars: 100 },
      { date: '2024-02-10', stars: 120 },
      { date: TODAY, stars: 120 },
    ])
  })

  it('samples evenly across pages when the history exceeds the request budget (oldest-first page 1)', async () => {
    // Page 1's first entry sits next to the repo creation date → ascending.
    mockPages({
      total: 4000,
      createdAt: '2024-01-01T00:00:00Z',
      pages: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          i + 1,
          Array.from({ length: 100 }, () =>
            stargazerAt(new Date(Date.UTC(2024, 0, i + 1)).toISOString()),
          ),
        ]),
      ),
      linkHeader: linkHeader(2, 40),
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    // 15 sampled boundary points + the today anchor.
    expect(records.length).toBe(16)
    // Page 1 is the oldest page: its boundary count is 0 stars at the repo's first day.
    expect(records[0]).toEqual({ date: '2024-01-01', stars: 0 })
    // The last sampled page (40) sits at 39 * 100 stars.
    expect(records.at(-2)).toEqual({ date: '2024-02-09', stars: 3900 })
    expect(records.at(-1)).toEqual({ date: TODAY, stars: 4000 })
    // Sampled points are strictly ascending in both date and count.
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.date > records[i - 1]!.date).toBe(true)
      expect(records[i]!.stars).toBeGreaterThanOrEqual(records[i - 1]!.stars)
    }
    // Only the 15 sampled pages are fetched: page 1 is served from the Link
    // probe (not refetched) and the other 14 pages go out in parallel.
    expect(new Set(stargazerUrls()).size).toBe(15)
    expect(fetchMock).toHaveBeenCalledTimes(16)
  })

  it('detects newest-first page 1 and counts from the tail when sampling', async () => {
    // Page 1's first entry sits next to now → newest-first serving.
    const nowMs = Date.now()
    const day = 24 * 60 * 60 * 1000
    mockPages({
      total: 4000,
      createdAt: '2024-01-01T00:00:00Z',
      pages: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          i + 1,
          Array.from({ length: 100 }, () =>
            stargazerAt(new Date(nowMs - (i + 1) * day).toISOString()),
          ),
        ]),
      ),
      linkHeader: linkHeader(2, 40),
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    expect(records.length).toBe(16)
    // Output is sorted by date: page 40 (nowMs - 40 days) is the earliest
    // boundary and carries the oldest stars — total - 40 * 100 = 0.
    expect(records[0]).toEqual({ date: formatDate(nowMs - 40 * day), stars: 0 })
    // Page 1 is the newest-first page; its boundary count is total - 1 * 100.
    expect(records.at(-2)).toEqual({ date: formatDate(nowMs - day), stars: 3900 })
    expect(records.at(-1)).toEqual({ date: TODAY, stars: 4000 })
    // Dates still ascend in the output (sorting is by date string).
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.date > records[i - 1]!.date).toBe(true)
    }
  })

  it('falls back to newest-first when the creation date is unparseable', async () => {
    // A missing/empty created_at (NaN after Date.parse) must not flip the
    // series: it degrades to GitHub's default newest-first ordering.
    const nowMs = Date.now()
    const day = 24 * 60 * 60 * 1000
    mockPages({
      total: 4000,
      createdAt: '',
      pages: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          i + 1,
          Array.from({ length: 100 }, () =>
            stargazerAt(new Date(nowMs - (i + 1) * day).toISOString()),
          ),
        ]),
      ),
      linkHeader: linkHeader(2, 40),
    })

    const records = await getRepoStarRecords('owner/repo', TOKEN, 15)

    expect(records.length).toBe(16)
    expect(records[0]).toEqual({ date: formatDate(nowMs - 40 * day), stars: 0 })
    expect(records.at(-2)).toEqual({ date: formatDate(nowMs - day), stars: 3900 })
    expect(records.at(-1)).toEqual({ date: TODAY, stars: 4000 })
  })
})

describe('mergeStarRecords', () => {
  const day = 24 * 60 * 60 * 1000
  const TODAY = formatDate(Date.now())
  const D1 = formatDate(Date.now() - 3 * day)
  const D2 = formatDate(Date.now() - 1 * day)

  it('appends new days and collapses same-day stars', () => {
    const baseline = [{ date: D1, stars: 100 }]
    // Three brand-new stargazers: one on D2, two today.
    const incMs = [
      Date.parse(`${D2}T18:00:00Z`),
      Date.parse(`${TODAY}T09:00:00Z`),
      Date.parse(`${TODAY}T21:00:00Z`),
    ]

    expect(mergeStarRecords(baseline, incMs, 103)).toEqual([
      { date: D1, stars: 100 },
      { date: D2, stars: 101 },
      { date: TODAY, stars: 103 },
    ])
  })

  it('updates the baseline end date in place when new stars share it', () => {
    const baseline = [
      { date: D1, stars: 100 },
      { date: D2, stars: 250 },
    ]
    // Both new stars arrive on the baseline's last day: the point is updated
    // (250 + 2) instead of appended, keeping the series strictly ascending.
    const incMs = [Date.parse(`${D2}T20:00:00Z`), Date.parse(`${D2}T22:00:00Z`)]

    expect(mergeStarRecords(baseline, incMs, 252)).toEqual([
      { date: D1, stars: 100 },
      { date: D2, stars: 252 },
      { date: TODAY, stars: 252 },
    ])
  })

  it('is byte-stable without new stargazers when the anchor is already today', () => {
    const baseline = [
      { date: D1, stars: 100 },
      { date: TODAY, stars: 250 },
    ]

    expect(mergeStarRecords(baseline, [], 250)).toEqual(baseline)
  })

  it('is insensitive to the incoming order (dates are applied oldest-first)', () => {
    const baseline = [{ date: D1, stars: 100 }]
    const incMs = [Date.parse(`${TODAY}T21:00:00Z`), Date.parse(`${TODAY}T09:00:00Z`)]

    expect(mergeStarRecords(baseline, incMs, 102)).toEqual([
      { date: D1, stars: 100 },
      { date: TODAY, stars: 102 },
    ])
  })

  it('builds a series from scratch for an empty baseline', () => {
    expect(
      mergeStarRecords([], [Date.parse(`${D2}T10:00:00Z`), Date.parse(`${TODAY}T08:00:00Z`)], 2),
    ).toEqual([
      { date: D2, stars: 1 },
      { date: TODAY, stars: 2 },
    ])
  })
})

describe('getIncrementalStarRecords', () => {
  const day = 24 * 60 * 60 * 1000
  const TODAY = formatDate(Date.now())
  const YESTERDAY = formatDate(Date.now() - day)

  // Serves a mock repo info + one page of stargazers per entry in `pages`.
  function mockPages(options: {
    total: number
    createdAt: string
    pages: Record<number, { starred_at: string }[]>
    linkHeader?: Record<string, string>
  }): void {
    fetchMock.mockImplementation(async (input) => {
      const url = callUrl(input)
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ stargazers_count: options.total, created_at: options.createdAt })
      }
      if (url.includes('/stargazers')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1')
        const body = options.pages[page] ?? []
        return jsonResponse(body, page === 1 ? (options.linkHeader ?? {}) : {})
      }
      return jsonResponse({}, {}, 404)
    })
  }

  it('fetches only the newest pages down to the baseline date and merges', async () => {
    const baseline = [
      { date: formatDate(Date.now() - 3 * day), stars: 100 },
      { date: YESTERDAY, stars: 250 },
    ]
    // Page 1 mixes a yesterday star (new) with an ancient star (below the
    // baseline), so the walk stops after the probe page.
    mockPages({
      total: 251,
      createdAt: '2024-01-01T00:00:00Z',
      pages: {
        1: [
          stargazerAt(new Date(Date.parse(`${YESTERDAY}T18:00:00Z`)).toISOString()),
          stargazerAt('2024-03-01T00:00:00Z'),
        ],
      },
    })

    const records = await getIncrementalStarRecords('owner/repo', TOKEN, baseline, 15)

    expect(records).toEqual([
      { date: formatDate(Date.now() - 3 * day), stars: 100 },
      { date: YESTERDAY, stars: 251 },
      { date: TODAY, stars: 251 },
    ])
    // repo info + the reused page-1 probe only — no full-history walk.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the baseline byte-stable when no stargazers arrived since', async () => {
    const baseline = [
      { date: formatDate(Date.now() - 3 * day), stars: 100 },
      { date: TODAY, stars: 250 },
    ]
    // Page 1's newest entry sits close to now (newest-first) but belongs to a
    // star already counted in the baseline; `total === baseline.end` means zero
    // new stargazers, so nothing is merged and the anchor is re-used as-is.
    mockPages({
      total: 250,
      createdAt: '2024-01-01T00:00:00Z',
      pages: {
        1: [
          stargazerAt(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()),
          stargazerAt('2024-03-01T00:00:00Z'),
        ],
      },
    })

    const records = await getIncrementalStarRecords('owner/repo', TOKEN, baseline, 15)

    expect(records).toEqual(baseline)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to a full fetch for oldest-first instances', async () => {
    // Page 1's first entry sits next to the creation date → oldest-first.
    mockPages({
      total: 150,
      createdAt: '2024-01-01T00:00:00Z',
      pages: {
        1: Array.from({ length: 100 }, () => stargazerAt('2024-01-05T00:00:00Z')),
        2: Array.from({ length: 50 }, () => stargazerAt('2024-02-10T00:00:00Z')),
      },
      linkHeader: linkHeader(2, 2),
    })

    const records = await getIncrementalStarRecords(
      'owner/repo',
      TOKEN,
      [{ date: TODAY, stars: 150 }],
      15,
    )

    // The full-history result, not an incremental merge.
    expect(records).toEqual([
      { date: '2024-01-05', stars: 100 },
      { date: '2024-02-10', stars: 150 },
      { date: TODAY, stars: 150 },
    ])
  })

  it('falls back to a full fetch when the increment outgrows the budget', async () => {
    // Newest-first pages date from yesterday back across ~40 days. The walk
    // spends its whole budget (15 pages) without ever dipping below the
    // baseline — far more stars arrived since last run — so the incremental
    // merge is abandoned for a full (sampled) fetch.
    // newest-first 页面从昨天起跨约 40 天分布。走页耗尽全部预算（15 页）
    // 仍未低于基线日期——上次运行以来新增远多于预算——因此放弃增量合并，
    // 回退为全量（采样）抓取。
    mockPages({
      total: 4000,
      createdAt: '2024-01-01T00:00:00Z',
      pages: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          i + 1,
          Array.from({ length: 100 }, () =>
            stargazerAt(new Date(Date.now() - (i + 1) * day).toISOString()),
          ),
        ]),
      ),
      linkHeader: linkHeader(2, 40),
    })

    const records = await getIncrementalStarRecords(
      'owner/repo',
      TOKEN,
      [{ date: formatDate(Date.now() - 16 * day), stars: 0 }],
      15,
    )

    // A sampled full history (15 sampled points + the today anchor).
    expect(records.length).toBe(16)
    expect(records.at(-1)).toEqual({ date: TODAY, stars: 4000 })
  })
})
