import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoRadarAttributes, newStarsInLastDays, percentileOf } from '../src/services/radar.js'

// radar.ts computes API_BASE from GITHUB_API_URL at module evaluation; pin it
// so the asserted request URLs stay deterministic.
vi.hoisted(() => {
  process.env['GITHUB_API_URL'] = 'https://api.github.test'
})

const TOKEN = 'test-token'

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

// The action only ever fetch()es string URLs; this keeps URL extraction
// type-safe (no implicit Object stringification) for mock introspection.
function callUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

// A GitHub-style `rel="last"` Link header advertising `last` pages.
function lastLinkHeader(last: number): Record<string, string> {
  return {
    link: `<https://api.github.test/whatever?page=${last}&per_page=1>; rel="last"`,
  }
}

describe('percentileOf', () => {
  it('maps counts to a 0-99 log-scale intensity', () => {
    expect(percentileOf(0)).toBe(0)
    expect(percentileOf(1)).toBe(3)
    expect(percentileOf(10)).toBe(11)
    expect(percentileOf(1_000)).toBe(33)
    expect(percentileOf(1_000_000)).toBe(66)
  })

  it('caps at 99 and ignores non-finite or negative counts', () => {
    expect(percentileOf(Number.POSITIVE_INFINITY)).toBe(0)
    expect(percentileOf(Number.NaN)).toBe(0)
    expect(percentileOf(-1)).toBe(0)
    // log10(1e9)/3*33 = 99 — exactly the cap
    expect(percentileOf(1_000_000_000)).toBe(99)
  })
})

describe('newStarsInLastDays', () => {
  const day = 86_400_000
  const today = Date.now()
  const iso = (offsetDays: number): string =>
    new Date(today - offsetDays * day).toISOString().slice(0, 10)

  it('counts stars gained inside the lookback window', () => {
    const records = [
      { date: iso(20), stars: 100 },
      { date: iso(10), stars: 120 },
      { date: iso(1), stars: 150 },
    ]

    // cutoff is 15 days ago: only iso(20) is before it, so base = 100.
    expect(newStarsInLastDays(records, 15)).toBe(50) // 150 - 100
  })

  it('returns 0 for an empty series', () => {
    expect(newStarsInLastDays([], 30)).toBe(0)
  })

  it('returns 0 when the series does not reach the cutoff', () => {
    const records = [{ date: iso(1), stars: 150 }]

    // cutoff is 30 days ago, before every record: no base to subtract.
    expect(newStarsInLastDays(records, 30)).toBe(150)
  })

  it('never returns a negative delta (data correction)', () => {
    const records = [{ date: iso(1), stars: 50 }]

    // cutoff is 0 days ago (today) >= the only record: base becomes 50 → delta 0.
    expect(newStarsInLastDays(records, 0)).toBe(0)
  })
})

describe('getRepoRadarAttributes', () => {
  const day = 86_400_000
  const today = Date.now()
  const iso = (offsetDays: number): string =>
    new Date(today - offsetDays * day).toISOString().slice(0, 10)
  // New stars = 20 - 10 = 10 (the 40-day-old record sits before the 30-day cutoff).
  const records = [
    { date: iso(40), stars: 10 },
    { date: iso(20), stars: 20 },
  ]

  it('fetches all six metrics and maps them to scores', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(callUrl(input))
      if (url.pathname === '/repos/owner/repo') {
        return jsonResponse({ stargazers_count: 5_000, forks_count: 300 })
      }
      if (url.pathname.endsWith('/contributors')) {
        return jsonResponse([], lastLinkHeader(5)) // ~500 contributors
      }
      if (url.pathname.endsWith('/commits')) {
        return jsonResponse([], lastLinkHeader(2)) // ~200 pushes
      }
      if (url.pathname === '/search/issues') {
        return jsonResponse({ total_count: 120 })
      }
      return jsonResponse({}, {}, 404)
    })

    const attributes = await getRepoRadarAttributes('owner/repo', TOKEN, records)

    expect(attributes).toEqual({
      stars: 41, // percentileOf(5000)
      new_stars: 11, // percentileOf(10)
      pushes: 25, // percentileOf(200)
      contributors: 30, // percentileOf(500)
      issues_closed: 23, // percentileOf(120)
      forks: 27, // percentileOf(300)
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('falls back to 0 for metrics without paging info', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(callUrl(input))
      if (url.pathname === '/repos/owner/repo') {
        return jsonResponse({ stargazers_count: 0, forks_count: 0 })
      }
      if (url.pathname.endsWith('/contributors') || url.pathname.endsWith('/commits')) {
        // single page: no Link header
        return jsonResponse([])
      }
      if (url.pathname === '/search/issues') {
        return jsonResponse({ total_count: 0 })
      }
      return jsonResponse({}, {}, 404)
    })

    const attributes = await getRepoRadarAttributes('owner/repo', TOKEN, records)

    expect(attributes).toEqual({
      stars: 0,
      new_stars: 11,
      pushes: 0,
      contributors: 0,
      issues_closed: 0,
      forks: 0,
    })
  })

  it('throws when the repo lookup fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, {}, 404))

    await expect(getRepoRadarAttributes('missing/repo', TOKEN, records)).rejects.toThrow(
      'Failed to get repo missing/repo info',
    )
  })
})
