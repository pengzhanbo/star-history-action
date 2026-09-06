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
 * Output formats the action can write.
 *
 * `json` exports the fetched records as structured data instead of charts.
 *
 * 动作可输出的文件格式。
 *
 * `json` 将抓取的记录以结构化数据导出，而非图表。
 */
export const OUTPUT_FORMATS = ['svg', 'png', 'both', 'json'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/**
 * Parsed and validated action inputs.
 *
 * 解析并校验后的动作输入。
 */
export interface ActionConfig {
  /**
   * Repositories in `owner/repo` form; the `repo` input accepts multiple
   * comma/space-separated entries to compare several repos in one chart.
   *
   * `owner/repo` 形式的仓库列表；`repo` 输入支持逗号/空格分隔多个仓库，
   * 用于在单个图表中对比。
   */
  repos: string[]
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
   * File formats to write: `svg` (default), `png` (rasterized), `both`, or
   * `json` (structured record data instead of charts).
   *
   * 要写入的文件格式：`svg`（默认）、`png`（栅格化）、`both`，或
   * `json`（导出结构化记录数据而非图表）。
   */
  outputFormat: OutputFormat // default 'svg'
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
  /**
   * Whether to also render a per-repo radar SVG chart alongside the star history.
   *
   * 是否在 star history 之外再渲染每个仓库的雷达图 SVG。
   */
  radar: boolean // default false
  /**
   * Whether the repo owner's avatar is needed as an inline chart logo. Only the
   * SVG families use it, so `json` output can skip the extra request.
   *
   * 是否需要仓库所有者的头像作为内联图表 logo。仅 SVG 图表家族需要它，
   * 因此 `json` 输出可以跳过这个额外请求。
   */
  includeLogo: boolean // = outputFormat !== 'json'
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
 * Type guard narrowing a string to a known output format.
 *
 * 将字符串收窄为已知输出格式的类型守卫。
 *
 * @param value - Format string to validate / 待校验的格式字符串
 * @returns True when the value is `svg`, `png`, `both`, or `json` / 当值为 `svg`、`png`、`both` 或 `json` 时为真
 */
function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value)
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
  // The repo input accepts comma/space-separated `owner/repo` entries; each is
  // trimmed, empties dropped, and duplicates removed (same policy as theme).
  // repo 输入接受逗号/空格分隔的 `owner/repo` 条目：逐个去空白、丢弃空值、
  // 去重（与 theme 相同的策略）。
  const repos: string[] = []
  const rawRepo = getInput('repo') || GITHUB_REPOSITORY
  for (const value of rawRepo.split(/[,，\s]+/)) {
    const repo = value.trim()
    if (!repo) {
      continue
    }
    if (!repos.includes(repo)) {
      repos.push(repo)
    }
  }
  if (repos.length === 0) {
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
  // The PNG raster is derived from the SVG, so the input file name must stay
  // .svg; png/both modes swap the extension when naming the raster.
  if (!/\.svg$/i.test(outputFilename)) {
    throw new Error(`output-filename must end with .svg, got "${outputFilename}"`)
  }

  const rawFormat = getInput('output-format') || 'svg'
  const outputFormat = rawFormat.trim().toLowerCase()
  if (!isOutputFormat(outputFormat)) {
    throw new Error(`output-format "${rawFormat}" is invalid; use svg, png, both, or json`)
  }

  const rawRadar = getInput('radar')
  const radarValue = rawRadar.trim().toLowerCase()
  if (radarValue && radarValue !== 'true' && radarValue !== 'false') {
    throw new Error(`radar "${rawRadar}" is invalid; use true or false`)
  }
  const radar = radarValue === 'true'

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

  return {
    repos,
    token,
    outputDirectory,
    outputFilename,
    outputFormat,
    svgWidth,
    themes,
    radar,
    includeLogo: outputFormat !== 'json',
  }
}

/**
 * Chart output file for one theme: the SVG is always derived (it is the
 * rasterization source); the PNG exists only when output-format is png/both.
 *
 * 单个主题的图表输出文件：始终派生 SVG（它是栅格化的源）；仅当
 * output-format 为 png/both 时才派生 PNG。
 */
export interface ChartFileOutput {
  /** Theme this file belongs to / 该文件所属的主题。 */
  theme: ChartTheme
  /** Derived `.svg` file name / 派生出的 `.svg` 文件名。 */
  svgFile: string
  /** Derived `.png` file name; absent for output-format `svg` / 派生出的 `.png` 文件名；`svg` 模式不存在。 */
  pngFile?: string
}

/**
 * Maps the requested themes to concrete chart file names.
 *
 * 将请求的主题映射为具体的图表文件名。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns One entry per theme with the derived `.svg` (and, for `png`/`both`
 *   modes, `.png`) file names: single-theme runs keep the input filename;
 *   multi-theme runs derive `-light`/`-dark` variants. `json` output writes no
 *   charts, so it maps to an empty list. /
 *   每个主题一个条目，包含派生的 `.svg`（以及 `png`/`both` 模式下的 `.png`）
 *   文件名：单主题运行保留输入文件名；多主题运行派生 `-light`/`-dark` 变体。
 *   `json` 输出不写图表，映射为空列表。
 * @example
 * getChartFilePaths({ ...themes: ['light', 'dark'], outputFilename: 'chart.svg' })
 * // [{ theme: 'light', svgFile: 'chart-light.svg' }, { theme: 'dark', svgFile: 'chart-dark.svg' }]
 */
export function getChartFilePaths(config: ActionConfig): ChartFileOutput[] {
  if (config.outputFormat === 'json') {
    return []
  }
  const themeFiles =
    config.themes.length === 1
      ? [{ theme: config.themes[0]!, svgFile: config.outputFilename }]
      : (() => {
          const i = config.outputFilename.lastIndexOf('.')
          const ext = i > 0 ? config.outputFilename.slice(i) : '.svg'
          const stem = i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename
          return [
            { theme: 'light' as const, svgFile: `${stem}-light${ext}` },
            { theme: 'dark' as const, svgFile: `${stem}-dark${ext}` },
          ]
        })()
  return themeFiles.map(({ theme, svgFile }) => {
    const output: ChartFileOutput = { theme, svgFile }
    // exactOptionalPropertyTypes: only set pngFile when it exists.
    if (config.outputFormat !== 'svg') {
      output.pngFile = svgFile.replace(/\.svg$/i, '.png')
    }
    return output
  })
}

/**
 * Derives the JSON data export file name by swapping the `.svg` extension of
 * `output-filename`. The JSON holds every repo's records, so it is theme-agnostic
 * and never derives `-light`/`-dark` variants.
 *
 * 通过替换 `output-filename` 的 `.svg` 扩展名派生 JSON 数据导出文件名。
 * JSON 包含所有仓库的记录，与主题无关，因此不派生 `-light`/`-dark` 变体。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns The JSON file name / JSON 文件名
 * @example
 * getJsonFileName({ ...outputFilename: 'star-history.svg' })
 * // 'star-history.json'
 */
export function getJsonFileName(config: ActionConfig): string {
  return config.outputFilename.replace(/\.svg$/i, '.json')
}

/**
 * Derives the radar chart file name for one repo (and, on multi-theme runs, one
 * theme). Single-repo runs keep a plain `<stem>-radar.svg`; multi-repo runs
 * suffix the repo (`/` → `-`) so each repo gets its own file; when both themes
 * are configured, `-light`/`-dark` is inserted before the extension (mirroring
 * {@link getChartFilePaths}).
 *
 * 为单个仓库（多主题运行时为单个主题）派生雷达图文件名。单仓库运行保留
 * `<stem>-radar.svg`；多仓库运行追加仓库名（`/` 替换为 `-`），使每个仓库
 * 各自成文件；配置双主题时在扩展名前插入 `-light`/`-dark`（与
 * {@link getChartFilePaths} 一致）。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @param theme - Theme being rendered; only honored when both themes are
 *   configured / 正在渲染的主题；仅当配置双主题时生效
 * @returns The radar chart file name / 雷达图文件名
 * @example
 * getRadarFileName(
 *   { outputFilename: 'star-history.svg', repos: ['a/b', 'c/d'], themes: ['light', 'dark'] },
 *   'a/b',
 *   'dark',
 * )
 * // 'star-history-radar-a-b-dark.svg'
 */
export function getRadarFileName(config: ActionConfig, repo: string, theme?: ChartTheme): string {
  const i = config.outputFilename.lastIndexOf('.')
  const ext = i > 0 ? config.outputFilename.slice(i) : '.svg'
  const stem = i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename
  const repoPart = config.repos.length > 1 ? `-${repo.replaceAll('/', '-')}` : ''
  const themePart = theme && config.themes.length > 1 ? `-${theme}` : ''
  return `${stem}-radar${repoPart}${themePart}${ext}`
}

/**
 * Maps the requested themes to concrete radar chart file names for one repo,
 * reusing the same naming rules as {@link getChartFilePaths}: theme suffixes
 * for multi-theme runs, and `.png` derivation for `png`/`both` output formats.
 *
 * 将请求的主题映射为某个仓库的雷达图具体文件名，复用
 * {@link getChartFilePaths} 的命名规则：多主题运行追加主题后缀，`png`/`both`
 * 输出格式派生 `.png` 文件名。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @returns One entry per theme with the derived `.svg` (and, for `png`/`both`
 *   modes, `.png`) radar file names / 每个主题一个条目，包含派生的 `.svg`
 *   （以及 `png`/`both` 模式下的 `.png`）雷达图文件名
 * @example
 * getRadarFilePaths({ ...themes: ['light', 'dark'], outputFormat: 'both', repos: ['a/b'] }, 'a/b')
 * // [
 * //   { theme: 'light', svgFile: 'star-history-radar-light.svg', pngFile: 'star-history-radar-light.png' },
 * //   { theme: 'dark', svgFile: 'star-history-radar-dark.svg', pngFile: 'star-history-radar-dark.png' },
 * // ]
 */
export function getRadarFilePaths(config: ActionConfig, repo: string): ChartFileOutput[] {
  return getChartFilePaths({ ...config, outputFilename: getRadarFileName(config, repo) })
}
