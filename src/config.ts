import { isAbsolute } from 'node:path'
import { getInput } from '@actions/core'
import { GITHUB_REPOSITORY } from './env.js'

export const THEMES = ['light', 'dark'] as const
export type ChartTheme = (typeof THEMES)[number]

export interface ActionConfig {
  repo: string
  token: string
  outputDirectory: string // default 'assets'
  outputFilename: string // default 'star-history.svg'
  svgWidth: number // default 960
  themes: ChartTheme[] // default ['light']
}

function isTheme(value: string): value is ChartTheme {
  return (THEMES as readonly string[]).includes(value)
}

export function parseInputs(): ActionConfig {
  const repo = getInput('repo') || GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('repo input is required')
  }

  const token = getInput('token')
  if (!token) {
    throw new Error('token input is required')
  }

  const outputDirectory = getInput('output-directory') || 'assets'
  if (isAbsolute(outputDirectory)) {
    throw new Error(`output-directory must be a relative path, got "${outputDirectory}"`)
  }

  const outputFilename = getInput('output-filename') || 'star-history.svg'
  if (
    outputFilename.length === 0 ||
    outputFilename.includes('/') ||
    outputFilename.includes('\\')
  ) {
    throw new Error(
      `output-filename must be a file name without path separators, got "${outputFilename}"`,
    )
  }
  // The rendered content is always SVG; a non-.svg extension would write
  // unrasterized SVG bytes to a misleadingly named file.
  if (!/\.svg$/i.test(outputFilename)) {
    throw new Error(`output-filename must end with .svg, got "${outputFilename}"`)
  }

  const rawWidth = getInput('svg-width') || '960'
  const svgWidth = Number(rawWidth)
  if (!Number.isInteger(svgWidth) || svgWidth < 1) {
    throw new Error(`svg-width must be a positive integer, got "${rawWidth}"`)
  }

  const themes: ChartTheme[] = []
  const rawTheme = getInput('theme')
  if (rawTheme) {
    for (const value of rawTheme.split(/[,，\s]+/)) {
      const theme = value.trim().toLowerCase()
      if (!theme) {
        continue
      }
      if (!isTheme(theme)) {
        throw new Error(`theme "${value}" is invalid; use light, dark, or light, dark`)
      }
      if (!themes.includes(theme)) {
        themes.push(theme)
      }
    }
  }
  if (themes.length === 0) {
    themes.push('light')
  }

  return { repo, token, outputDirectory, outputFilename, svgWidth, themes }
}

export function getChartFilePaths(config: ActionConfig): { theme: ChartTheme; file: string }[] {
  if (config.themes.length === 1) {
    return [{ theme: config.themes[0]!, file: config.outputFilename }]
  }
  const i = config.outputFilename.lastIndexOf('.')
  const ext = i > 0 ? config.outputFilename.slice(i) : '.svg'
  const stem = i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename
  return [
    { theme: 'light', file: `${stem}-light${ext}` },
    { theme: 'dark', file: `${stem}-dark${ext}` },
  ]
}
