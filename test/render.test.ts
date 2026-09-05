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
  it('produces a standalone light-theme SVG sized to svg-width', async () => {
    const svg = await renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('<svg')
    // jsdom serializes HTML-style; standalone consumers need the explicit xmlns.
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="960"')
    // clientHeight = width * 2 / 3
    expect(svg).toContain('height="640"')
    // light theme background — svgo's color conversion emits hex
    expect(svg).toContain('background:#fff')
  })

  it('uses the dark palette for the dark theme', async () => {
    const svg = await renderStarHistorySvg({ ...baseInput, theme: 'dark' })

    // jsdom (cssstyle) + svgo serialize the hex dark background as #0d1117
    expect(svg).toContain('background:#0d1117')
    expect(svg).not.toContain('background:#fff')
  })

  it('draws the line path, title and legend (dots disabled)', async () => {
    const svg = await renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('class="xkcd-chart-xyline"')
    expect(svg).toContain('d="M') // the line path data
    // showDots is disabled, so no per-record dots are drawn
    expect(svg.match(/class="chart-tooltip-dot"/g)).toBeNull()
    // repo name appears in the legend
    expect(svg.match(/owner\/repo/g)?.length).toBeGreaterThanOrEqual(1)
    // axes labels and legend entry; the title is a fixed "Star History"
    expect(svg).toContain('Date')
    expect(svg).toContain('Stars')
    expect(svg).toContain('Star History')
  })

  it('injects the xkcdify filter and a subset xkcd font family', async () => {
    const svg = await renderStarHistorySvg({ ...baseInput, theme: 'light' })

    expect(svg).toContain('id="xkcdify"')
    expect(svg).toContain('url(#xkcdify)')
    expect(svg).toContain('font-family:xkcd')
    // the full embedded woff is swapped for a woff2 subset of the chart text
    expect(svg).toContain('data:font/woff2')
    // svgo normalizes the CSS quotes and jsdom/html escaping turns them
    // into &quot; when serializing the <style> text content
    expect(svg).toContain('format(&quot;woff2&quot;)')
    expect(svg).not.toContain('application/font-woff')
  })

  it('honors a custom svg-width', async () => {
    const svg = await renderStarHistorySvg({ ...baseInput, theme: 'light', width: 1200 })

    expect(svg).toContain('width="1200"')
    expect(svg).toContain('height="800"')
  })

  it('labels the current star count at the newest point', async () => {
    const svg = await renderStarHistorySvg({
      ...baseInput,
      records: [...records, { date: '2024-04-01', stars: 1234 }],
      theme: 'light',
    })

    // the end-value pill renders and carries the compact-formatted latest count
    const pill = svg.match(/xkcd-chart-xy-end-value[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
    expect(pill).toContain('xkcd-chart-xy-end-value')
    expect(pill).toContain('1.2K')
  })

  it('keeps the title logo clear of the centered title', async () => {
    const svg = await renderStarHistorySvg({
      ...baseInput,
      logo: 'https://example.com/avatar.png',
      theme: 'light',
    })

    // drawTitle places the logo at chartWidth/2 - 84 = 396 on the 960px chart
    const logoX = Number(svg.match(/<image[^>]*\sx="(\d+)"\sy="12"/)?.[1])
    const logoSize = 22
    // jsdom cannot measure text; the 10 chars of "owner/repo" estimate to
    // 10 * 20px * 0.6 = 120px wide, i.e. 60px half-width.
    const titleHalfWidth = 60
    // the title is anchored middle at 50% (= 480) of the 960px chart
    const titleLeft = 480 - titleHalfWidth

    // logo (396..418) sits left of the text (420..540) — no overlap
    expect(logoX + logoSize).toBeLessThan(titleLeft)
    // the logo stays on-canvas
    expect(logoX).toBeGreaterThan(0)
  })
})
