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
  it('returns a standalone SVG with the xkcd font embedded', () => {
    const svg = renderRadarSvg(attributes)

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('width="400"')
    expect(svg).toContain('height="400"')
    expect(svg).toContain('font-family:xkcd,cursive')
    // the woff font is inlined so the SVG renders as a sandboxed <img>
    expect(svg).toContain('@font-face')
    expect(svg).toContain('format("woff")')
  })

  it('labels all six axes', () => {
    const svg = renderRadarSvg(attributes)

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

  it('draws the data polygon and one dot per axis', () => {
    const svg = renderRadarSvg(attributes)

    expect(svg).toContain('#16a34a')
    // one data dot per axis
    expect(svg.match(/<circle /g)).toHaveLength(6)
    // dashed level rings + outer ring + 6 axes + data polygon
    expect(svg.match(/<path d="/g)?.length).toBeGreaterThanOrEqual(8)
  })

  it('honors a custom size', () => {
    const svg = renderRadarSvg(attributes, 200)

    expect(svg).toContain('width="200"')
    expect(svg).toContain('height="200"')
    expect(svg).toContain('viewBox="0 0 200 200"')
  })

  it('is deterministic for identical input (seeded PRNG)', () => {
    expect(renderRadarSvg(attributes)).toBe(renderRadarSvg(attributes))
  })
})
