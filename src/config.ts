import { isAbsolute } from 'node:path'
import { getInput } from '@actions/core'
import { GITHUB_REPOSITORY } from './env.js'

/**
 * Chart themes supported by the action.
 *
 * 动作支持的图表主题。
 */
export const THEMES = ['light', 'dark'] as const
export type ChartTheme = (typeof THEMES)[number]

/**
 * Parsed and validated action inputs.
 *
 * 解析并校验后的动作输入。
 */
export interface ActionConfig {
  /**
   * Repository in `owner/repo` form.
   *
   * `owner/repo` 形式的仓库标识。
   */
  repo: string
  /**
   * Authentication token for GitHub API requests.
   *
   * GitHub API 请求的认证令牌。
   */
  token: string
  /**
   * Directory to write the chart into, relative to the workspace root.
   *
   * 图表输出目录（相对工作区根目录）。
   */
  outputDirectory: string // default 'assets'
  /**
   * Chart file name; a multi-theme run derives `-light`/`-dark` variants.
   *
   * 图表文件名；多主题运行时会派生 `-light`/`-dark` 变体。
   */
  outputFilename: string // default 'star-history.svg'
  /**
   * Width of the generated SVG in pixels.
   *
   * 生成的 SVG 宽度（像素）。
   */
  svgWidth: number // default 960
  /**
   * Themes to render, one SVG file per theme.
   *
   * 需要渲染的主题，每个主题输出一个 SVG 文件。
   */
  themes: ChartTheme[] // default ['light']
}

/**
 * Type guard narrowing a string to a known chart theme.
 *
 * 将字符串收窄为已知图表主题的类型守卫。
 *
 * @param value - Theme string to validate / 待校验的主题字符串
 * @returns True when the value is `light` or `dark` / 当值为 `light` 或 `dark` 时为真
 */
function isTheme(value: string): value is ChartTheme {
  return (THEMES as readonly string[]).includes(value)
}

/**
 * Reads and validates all action inputs from the runner environment.
 *
 * 从 runner 环境中读取并校验全部动作输入。
 *
 * @returns The parsed and validated configuration / 解析并校验后的配置
 * @throws {Error} When a required input is missing or a value is invalid / 当必填输入缺失或取值非法时抛出错误
 * @example
 * // On a GitHub runner, inputs arrive as INPUT_* env vars.
 * const config = parseInputs()
 */
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

/**
 * Maps the requested themes to concrete chart file names.
 *
 * 将请求的主题映射为具体的图表文件名。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns One entry per theme: single-theme runs keep the input filename;
 *   multi-theme runs derive `-light`/`-dark` variants /
 *   每个主题一个条目：单主题运行保留输入文件名；多主题运行派生
 *   `-light`/`-dark` 变体
 * @example
 * getChartFilePaths({ ...themes: ['light', 'dark'], outputFilename: 'chart.svg' })
 * // [{ theme: 'light', file: 'chart-light.svg' }, { theme: 'dark', file: 'chart-dark.svg' }]
 */
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
