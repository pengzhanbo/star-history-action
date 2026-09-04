import type { ActionConfig } from '../src/config.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getChartFilePaths } from '../src/config.js'

// env.js reads process.env at module evaluation, so parseInputs scenarios
// re-import the module after stubbing env vars.
async function loadParseInputs() {
  vi.resetModules()
  const { parseInputs } = await import('../src/config.js')
  return parseInputs
}

function stubInputs(inputs: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(inputs)) {
    // @actions/core getInput reads `INPUT_<UPPER_SNAKE_NAME>`; hyphens are kept.
    const envName = `INPUT_${name.replaceAll(' ', '_').toUpperCase()}`
    vi.stubEnv(envName, value ?? '')
  }
}

describe('parseInputs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('applies defaults for optional inputs and falls back to GITHUB_REPOSITORY', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('INPUT_TOKEN', 't0k3n')
    const parseInputs = await loadParseInputs()

    expect(parseInputs()).toEqual<ActionConfig>({
      repo: 'owner/repo',
      token: 't0k3n',
      outputDirectory: 'assets',
      outputFilename: 'star-history.svg',
      svgWidth: 960,
      themes: ['light'],
    })
  })

  it('prefers the repo input over GITHUB_REPOSITORY', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'fallback/repo')
    stubInputs({ repo: 'input/repo', token: 't' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().repo).toBe('input/repo')
  })

  it('throws when repo and GITHUB_REPOSITORY are both missing', async () => {
    stubInputs({ token: 't' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('repo input is required')
  })

  it('throws when token is missing', async () => {
    stubInputs({ repo: 'owner/repo' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('token input is required')
  })

  it('throws when output-directory is absolute', async () => {
    stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-directory': '/etc' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('output-directory must be a relative path')
  })

  it.each(['a/b.svg', 'a\\b.svg'])(
    'throws when output-filename contains a path separator (%s)',
    async (filename) => {
      stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-filename': filename })
      const parseInputs = await loadParseInputs()

      expect(() => parseInputs()).toThrow('output-filename must be a file name')
    },
  )

  it.each(['chart.png', 'history'])(
    'throws when output-filename does not end with .svg (%s)',
    async (filename) => {
      stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-filename': filename })
      const parseInputs = await loadParseInputs()

      expect(() => parseInputs()).toThrow('output-filename must end with .svg')
    },
  )

  it('accepts an uppercase .SVG extension', async () => {
    stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-filename': 'chart.SVG' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().outputFilename).toBe('chart.SVG')
  })

  it.each(['abc', '0', '-5', '100.5'])(
    'throws when svg-width is not a positive integer (%s)',
    async (width) => {
      stubInputs({ 'repo': 'owner/repo', 'token': 't', 'svg-width': width })
      const parseInputs = await loadParseInputs()

      expect(() => parseInputs()).toThrow('svg-width must be a positive integer')
    },
  )

  it('accepts a custom svg-width', async () => {
    stubInputs({ 'repo': 'owner/repo', 'token': 't', 'svg-width': '1200' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().svgWidth).toBe(1200)
  })

  it('parses comma and whitespace separated themes, lowercased and deduped', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', theme: ' LIGHT, dark, DARK , light' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().themes).toEqual(['light', 'dark'])
  })

  it('accepts the full-width comma as a theme separator', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', theme: 'light，dark' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().themes).toEqual(['light', 'dark'])
  })

  it('ignores empty theme fragments', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', theme: ',, light ,' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().themes).toEqual(['light'])
  })

  it('throws on an unknown theme', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', theme: 'blue' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('theme "blue" is invalid')
  })
})

describe('getChartFilePaths', () => {
  const baseConfig: ActionConfig = {
    repo: 'owner/repo',
    token: 't',
    outputDirectory: 'assets',
    outputFilename: 'star-history.svg',
    svgWidth: 960,
    themes: ['light'],
  }

  it('uses the output-filename as-is for a single theme', () => {
    expect(getChartFilePaths({ ...baseConfig, themes: ['dark'] })).toEqual([
      { theme: 'dark', file: 'star-history.svg' },
    ])
  })

  it('suffixes the stem with the theme when rendering both themes', () => {
    expect(getChartFilePaths({ ...baseConfig, themes: ['light', 'dark'] })).toEqual([
      { theme: 'light', file: 'star-history-light.svg' },
      { theme: 'dark', file: 'star-history-dark.svg' },
    ])
  })

  it('keeps an uppercase extension when suffixing', () => {
    expect(
      getChartFilePaths({
        ...baseConfig,
        outputFilename: 'chart.SVG',
        themes: ['light', 'dark'],
      }),
    ).toEqual([
      { theme: 'light', file: 'chart-light.SVG' },
      { theme: 'dark', file: 'chart-dark.SVG' },
    ])
  })
})
