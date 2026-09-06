import type { ActionConfig } from '../src/services/config.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getChartFilePaths, getRadarFileName } from '../src/services/config.js'

// env.js reads process.env at module evaluation, so parseInputs scenarios
// re-import the module after stubbing env vars.
async function loadParseInputs() {
  vi.resetModules()
  const { parseInputs } = await import('../src/services/config.js')
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
      repos: ['owner/repo'],
      token: 't0k3n',
      outputDirectory: 'assets',
      outputFilename: 'star-history.svg',
      outputFormat: 'svg',
      svgWidth: 960,
      themes: ['light'],
      radar: false,
    })
  })

  it('prefers the repo input over GITHUB_REPOSITORY', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'fallback/repo')
    stubInputs({ repo: 'input/repo', token: 't' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().repos).toEqual(['input/repo'])
  })

  it('parses comma and whitespace separated repos, trimmed and deduped', async () => {
    stubInputs({ repo: ' a/b , c/d  d/e, a/b ', token: 't' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().repos).toEqual(['a/b', 'c/d', 'd/e'])
  })

  it('accepts the full-width comma as a repo separator', async () => {
    stubInputs({ repo: 'a/b，c/d', token: 't' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().repos).toEqual(['a/b', 'c/d'])
  })

  it('throws when no repo is given and GITHUB_REPOSITORY is missing', async () => {
    stubInputs({ repo: '  ,  ', token: 't' })
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

  it.each(['png', 'both', 'PNG', ' Both '])(
    'accepts output-format %s (lowercased and trimmed)',
    async (format) => {
      stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-format': format })
      const parseInputs = await loadParseInputs()

      expect(parseInputs().outputFormat).toBe(format.trim().toLowerCase())
    },
  )

  it('throws on an unknown output-format', async () => {
    stubInputs({ 'repo': 'owner/repo', 'token': 't', 'output-format': 'webp' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('output-format "webp" is invalid')
  })

  it.each(['true', 'TRUE', ' True '])('accepts radar %s (truthy)', async (radar) => {
    stubInputs({ repo: 'owner/repo', token: 't', radar })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().radar).toBe(true)
  })

  it('defaults radar to false when the input is empty', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', radar: '' })
    const parseInputs = await loadParseInputs()

    expect(parseInputs().radar).toBe(false)
  })

  it('throws on an invalid radar value', async () => {
    stubInputs({ repo: 'owner/repo', token: 't', radar: 'yes' })
    const parseInputs = await loadParseInputs()

    expect(() => parseInputs()).toThrow('radar "yes" is invalid; use true or false')
  })
})

describe('getChartFilePaths', () => {
  const baseConfig: ActionConfig = {
    repos: ['owner/repo'],
    token: 't',
    outputDirectory: 'assets',
    outputFilename: 'star-history.svg',
    outputFormat: 'svg',
    svgWidth: 960,
    themes: ['light'],
    radar: false,
  }

  it('uses the output-filename as-is for a single theme', () => {
    expect(getChartFilePaths({ ...baseConfig, themes: ['dark'] })).toEqual([
      { theme: 'dark', svgFile: 'star-history.svg' },
    ])
  })

  it('suffixes the stem with the theme when rendering both themes', () => {
    expect(getChartFilePaths({ ...baseConfig, themes: ['light', 'dark'] })).toEqual([
      { theme: 'light', svgFile: 'star-history-light.svg' },
      { theme: 'dark', svgFile: 'star-history-dark.svg' },
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
      { theme: 'light', svgFile: 'chart-light.SVG' },
      { theme: 'dark', svgFile: 'chart-dark.SVG' },
    ])
  })

  it('derives a .png file for output-format png', () => {
    expect(getChartFilePaths({ ...baseConfig, outputFormat: 'png' })).toEqual([
      { theme: 'light', svgFile: 'star-history.svg', pngFile: 'star-history.png' },
    ])
  })

  it('derives per-theme .png files for output-format both', () => {
    expect(
      getChartFilePaths({
        ...baseConfig,
        outputFormat: 'both',
        themes: ['light', 'dark'],
      }),
    ).toEqual([
      { theme: 'light', svgFile: 'star-history-light.svg', pngFile: 'star-history-light.png' },
      { theme: 'dark', svgFile: 'star-history-dark.svg', pngFile: 'star-history-dark.png' },
    ])
  })
})

describe('getRadarFileName', () => {
  const baseConfig: ActionConfig = {
    repos: ['owner/repo'],
    token: 't',
    outputDirectory: 'assets',
    outputFilename: 'star-history.svg',
    outputFormat: 'svg',
    svgWidth: 960,
    themes: ['light'],
    radar: true,
  }

  it('derives `<stem>-radar.svg` for a single repo', () => {
    expect(getRadarFileName(baseConfig, 'owner/repo')).toBe('star-history-radar.svg')
  })

  it('appends the repo (slashes to dashes) for multi-repo runs', () => {
    expect(getRadarFileName({ ...baseConfig, repos: ['a/b', 'c/d'] }, 'a/b')).toBe(
      'star-history-radar-a-b.svg',
    )
    expect(getRadarFileName({ ...baseConfig, repos: ['a/b', 'c/d'] }, 'c/d')).toBe(
      'star-history-radar-c-d.svg',
    )
  })

  it('keeps an uppercase extension', () => {
    expect(getRadarFileName({ ...baseConfig, outputFilename: 'chart.SVG' }, 'owner/repo')).toBe(
      'chart-radar.SVG',
    )
  })
})
