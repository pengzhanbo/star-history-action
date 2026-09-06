import { describe, expect, it } from 'vitest'
import { renderRadarSvg } from '../src/charts/radar-svg.js'

const attributes = {
  stars: 90,
  new_stars: 10,
  pushes: 50,
  contributors: 40,
  issues_closed: 70,
  forks: 20,
}

describe('renderRadarSvg', () => {
  it('returns a standalone SVG with a subset xkcd font embedded', async () => {
    const svg = await renderRadarSvg(attributes)

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('width="400"')
    expect(svg).toContain('height="400"')
    expect(svg).toContain('font-family:xkcd,cursive')
    // the font is inlined as a woff2 subset (not the full ttf), so the SVG
    // renders as a sandboxed <img> without shipping ~50KB of font data
    expect(svg).toContain('@font-face')
    expect(svg).toContain('data:font/woff2')
    expect(svg).toContain('format("woff2")')
    expect(svg).not.toContain('data:font/ttf')
  })

  it('labels all six axes', async () => {
    const svg = await renderRadarSvg(attributes)

    for (const label of [
      'Stars',
      'New Stars',
      'Issues Closed',
      'Contributors',
      'Pushes',
      'Forks',
    ]) {
      expect(svg).toContain(`>${label}</text>`)
    }
  })

  it('draws the data polygon and one dot per axis', async () => {
    const svg = await renderRadarSvg(attributes)

    expect(svg).toContain('#16a34a')
    // one data dot per axis
    expect(svg.match(/<circle /g)).toHaveLength(6)
    // dashed level rings + outer ring + 6 axes + data polygon
    expect(svg.match(/<path d="/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('honors a custom size', async () => {
    const svg = await renderRadarSvg(attributes, { size: 200 })

    expect(svg).toContain('width="200"')
    expect(svg).toContain('height="200"')
    expect(svg).toContain('viewBox="0 0 200 200"')
  })

  it('defaults to the light theme (transparent background)', async () => {
    const svg = await renderRadarSvg(attributes)

    expect(svg).toContain('background:transparent')
  })

  it('renders the dark theme with dark colors', async () => {
    const svg = await renderRadarSvg(attributes, { theme: 'dark' })

    expect(svg).toContain('background:#0d1117')
    expect(svg).toContain('#2ea043')
    expect(svg).toContain('#30363d')
  })

  it('is deterministic for identical input (seeded PRNG)', async () => {
    expect(await renderRadarSvg(attributes)).toBe(await renderRadarSvg(attributes))
  })
})
