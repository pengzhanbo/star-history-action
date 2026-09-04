import type { Landscape1Data } from '../src/charts/card-landscape1.js'
import { describe, expect, it } from 'vitest'
import { buildLandscape1 } from '../src/charts/card-landscape1.js'

interface ElementNode {
  type: string
  props: { children?: unknown } & Record<string, unknown>
}

// Deeply collects the text/number leaves of an h() element tree.
function collectTexts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') {
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectTexts(child, out)
    }
    return out
  }
  const element = node as ElementNode
  collectTexts(element.props?.children, out)
  return out
}

function collectTypes(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean' || typeof node !== 'object') {
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectTypes(child, out)
    }
    return out
  }
  const element = node as ElementNode
  out.push(element.type)
  collectTypes(element.props?.children, out)
  return out
}

const baseData: Landscape1Data = {
  name: 'owner/repo',
  description: 'A demo repository',
  stars: 1200,
  forks: 34,
  language: 'TypeScript',
  license: 'MIT',
  created_at: '2024-01-01T00:00:00Z',
  avatarBase64: 'data:image/png;base64,AAAA',
  radarSvgBase64: 'data:image/svg+xml;base64,BBBB',
  attributes: {
    stars: 90,
    new_stars: 10,
    pushes: 50,
    contributors: 40,
    issues_closed: 70,
    forks: 20,
  },
  rank: 42,
  logoBase64: 'data:image/png;base64,CCCC',
}

describe('buildLandscape1', () => {
  it('builds a 1200x630 card with the repo name, stats and meta', () => {
    const card = buildLandscape1(baseData)

    expect(card.type).toBe('div')
    expect(card.props.style).toMatchObject({ width: 1200, height: 630 })

    const texts = collectTexts(card)
    // the name row splits owner and repo into separate spans
    expect(texts.join('')).toContain('owner/repo')
    expect(texts).toContain('A demo repository')
    expect(texts).toContain('1.2k') // stars, compacted
    expect(texts).toContain('MIT')
    expect(texts).toContain('TypeScript')
  })

  it('embeds the avatar and radar images', () => {
    const card = buildLandscape1(baseData)

    const types = collectTypes(card)
    expect(types).toContain('img')
    const json = JSON.stringify(card)
    expect(json).toContain(baseData.avatarBase64)
    expect(json).toContain(baseData.radarSvgBase64)
  })

  it('draws the rank seal only when a positive rank is given', () => {
    const withRank = buildLandscape1(baseData)
    expect(collectTexts(withRank)).toContain('Global Rank')
    expect(collectTexts(withRank)).toContain('#42')

    const withoutRank = buildLandscape1({ ...baseData, rank: null })
    expect(collectTexts(withoutRank)).not.toContain('Global Rank')
  })

  it('omits the radar image when attributes are missing', () => {
    const card = buildLandscape1({ ...baseData, radarSvgBase64: null, attributes: null })

    expect(JSON.stringify(card)).not.toContain('data:image/svg+xml;base64,BBBB')
  })

  it('falls back to a neutral language color for unknown languages', () => {
    const card = buildLandscape1({ ...baseData, language: 'Brainfuck' })

    expect(JSON.stringify(card)).toContain('#6b7280')
  })
})
