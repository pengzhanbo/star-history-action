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

  it('centers the title logo + text as one group without overlap', () => {
    const svg = renderStarHistorySvg({
      ...baseInput,
      logo: 'https://example.com/avatar.png',
      theme: 'light',
    })

    // jsdom cannot measure text, so drawTitle uses a length-based estimate:
    // 10 chars * 20px * 0.6 = 120px wide, i.e. 60px half-width on the 960px chart.
    const logoX = Number(svg.match(/<image x="(\d+)" y="12"/)?.[1])
    // y="30" is unique to the title (legend rows sit at y="25").
    const titleX = Number(svg.match(/<text[^>]*y="30"[^>]*x="(\d+)">owner\/repo<\/text>/)?.[1])
    const logoSize = 22
    const titleHalfWidth = 60

    // logo (405..427) sits left of the text (435..555) — no overlap
    expect(logoX + logoSize).toBeLessThan(titleX - titleHalfWidth)
    // the logo+text group spans 405..555, centered on the 960px chart
    expect(logoX + titleX + titleHalfWidth).toBe(960)
  })
})
