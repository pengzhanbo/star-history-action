import { describe, expect, it } from 'vitest'
import { renderStarHistorySvg } from '../src/render.js'

const records = [
  { date: '2024-01-01', stars: 1 },
  { date: '2024-02-01', stars: 10 },
  { date: '2024-03-01', stars: 100 },
]

const baseInput = {
  repo: 'owner/repo',
  logo: '',
  records,
  width: 960,
}

describe('renderStarHistorySvg', () => {
  it('produces a standalone light-theme SVG sized to svg-width', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('<svg')
    // jsdom serializes HTML-style; standalone consumers need the explicit xmlns.
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="960"')
    // clientHeight = width * 2 / 3
    expect(svg).toContain('height="640"')
    // light theme background
    expect(svg).toContain('background: white')
  })

  it('uses the dark palette for the dark theme', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'dark' })

    // jsdom (cssstyle) serializes the hex background as rgb()
    expect(svg).toContain('rgb(13, 17, 23)')
    expect(svg).not.toContain('background: white')
  })

  it('draws the line path, one dot per record, title and legend', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('class="xkcd-chart-xyline"')
    expect(svg).toContain('d="M') // the line path data
    // one circle per record
    expect(svg.match(/class="chart-tooltip-dot"/g)).toHaveLength(records.length)
    // repo name appears as chart title and legend entry
    expect(svg.match(/owner\/repo/g)?.length).toBeGreaterThanOrEqual(2)
    // axis labels
    expect(svg).toContain('Date')
    expect(svg).toContain('Stars')
  })

  it('injects the xkcdify filter and the xkcd font family', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('id="xkcdify"')
    expect(svg).toContain('url(#xkcdify)')
    expect(svg).toContain('font-family: xkcd')
  })

  it('skips browser-only extras in node rendering', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'light' })

    // envType: 'node' — no animation styles, no emoji easter eggs for a neutral repo
    expect(svg).not.toContain('lobster-swim')
    expect(svg).not.toContain('browser-only')
  })

  it('honors a custom svg-width', () => {
    const svg = renderStarHistorySvg({ ...baseInput, theme: 'light', width: 1200 })

    expect(svg).toContain('width="1200"')
    expect(svg).toContain('height="800"')
  })
})
