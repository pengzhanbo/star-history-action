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
export const OUTPUT_FORMATS = ['svg', 'png', 'json'] as const
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
   * Chart file name; a multi-theme run derives `-light`/`-dark` variants. A
   * missing or unknown extension (.svg/.png/.json are recognized) is appended
   * based on the output-format list.
   *
   * 图表文件名；多主题运行时会派生 `-light`/`-dark` 变体。缺失或未知的扩展名
   * （识别 .svg/.png/.json）会根据 output-format 列表追加补全。
   */
  outputFilename: string // default 'star-history.svg'
  /**
   * File formats to write: any combination of `svg` (default), `png`
   * (rasterized) and `json` (structured record data instead of charts),
   * comma/space separated to generate several at once.
   *
   * 要写入的文件格式：`svg`（默认）、`png`（栅格化）、`json`（导出结构化
   * 记录数据而非图表）的任意组合，逗号/空格分隔可一次生成多种。
   */
  outputFormat: OutputFormat[] // default ['svg']
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
   * Whether incremental fetch is enabled: with `cache: true` the action reads
   * the last run's cache file (if any) as a baseline and only fetches the new
   * stargazers, slashing API quota on repos with large histories. The cache is
   * a dedicated `<stem>.cache.json` (no `updatedAt`, so unchanged runs stay
   * idempotent), committed alongside the charts.
   *
   * 是否启用增量抓取：`cache: true` 时会读取上一次运行的缓存文件（若存在）
   * 作为基线，只抓取新增的 stargazer，大幅降低大历史仓库的 API 配额消耗。
   * 缓存为专用的 `<stem>.cache.json`（不含 `updatedAt`，无变化时保持幂等），
   * 与图表一并提交。
   */
  cache: boolean // default false
  /**
   * Whether the repo owner's avatar is needed as an inline chart logo. Only the
   * SVG families use it, so a pure `json` export can skip the extra request.
   *
   * 是否需要仓库所有者的头像作为内联图表 logo。仅 SVG 图表家族需要它，
   * 因此纯 `json` 导出可以跳过这个额外请求。
   */
  includeLogo: boolean // = outputFormat.some((format) => format !== 'json')
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
 * @returns True when the value is `svg`, `png`, or `json` / 当值为 `svg`、`png` 或 `json` 时为真
 */
function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value)
}

/**
 * Parses the `output-format` input into a deduped format list. Comma/space-
 * separated entries (svg, png, json) allow generating several formats in one
 * run. Each entry is trimmed, lowercased, and deduped — the same policy as
 * `theme`. An empty input defaults to `svg`.
 *
 * 将 `output-format` 输入解析为去重后的格式列表。逗号/空格分隔的多个格式
 * （svg、png、json）允许一次运行生成多种格式。每个条目逐个去空白、转小写并
 * 去重——与 `theme` 相同的策略。空输入默认为 `svg`。
 *
 * @param raw - Raw input value (or `''` when the input is absent) / 原始输入值（输入缺省时为 `''`）
 * @returns The deduped format list (always non-empty) / 去重后的格式列表（恒非空）
 * @throws {Error} When a fragment is not a known format / 当某个片段不是已知格式时抛出
 */
function parseOutputFormats(raw: string): OutputFormat[] {
  const formats: OutputFormat[] = []
  for (const fragment of raw.split(/[,，\s]+/)) {
    const value = fragment.trim().toLowerCase()
    if (!value) {
      continue
    }
    if (!isOutputFormat(value)) {
      throw new Error(`output-format "${fragment}" is invalid; use svg, png, or json`)
    }
    if (!formats.includes(value)) {
      formats.push(value)
    }
  }
  return formats
}

/**
 * Parses a `true`/`false` action input (case- and whitespace-insensitive,
 * defaulting to `false`). Empty values are tolerated so boolean inputs stay
 * optional.
 *
 * 解析 `true`/`false` 的动作输入（大小写与空白不敏感，默认 `false`）。
 * 空值被容忍，因此布尔输入保持可选。
 *
 * @param key - Input key (without the `INPUT_` prefix) / 输入键名（不含 `INPUT_` 前缀）
 * @returns True when the input parses to `true` / 输入解析为 `true` 时返回真
 * @throws {Error} When the value is neither `true` nor `false` / 当值既非 `true` 也非 `false` 时抛出
 */
function parseBooleanInput(key: string): boolean {
  const raw = getInput(key)
  const value = raw.trim().toLowerCase()
  if (value && value !== 'true' && value !== 'false') {
    throw new Error(`${key} "${raw}" is invalid; use true or false`)
  }
  return value === 'true'
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
  // Not restricted to .svg: the derived file names append the right extension
  // per format when the input has none or an unknown one (see
  // getChartFilePaths / getJsonFileName / getCacheFileName / getRadarFileName).
  // 不再限制为 .svg：当输入没有扩展名或带未知扩展名时，派生文件名按格式
  // 追加对应的扩展名（见 getChartFilePaths / getJsonFileName /
  // getCacheFileName / getRadarFileName）。

  // The output-format input accepts comma/space-separated entries (svg, png,
  // json) so several formats can be generated in one run (see
  // parseOutputFormats).
  // output-format 输入接受逗号/空格分隔的多个格式（svg、png、json），一次运行
  // 可生成多种格式（见 parseOutputFormats）。
  const outputFormat = parseOutputFormats(getInput('output-format') || 'svg')

  const radar = parseBooleanInput('radar')

  const cache = parseBooleanInput('cache')

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
    cache,
    includeLogo: outputFormat.some((format) => format !== 'json'),
  }
}

/**
 * Splits a file name into its stem and — when present and a known output
 * format extension (case-insensitive) — its extension, preserving the input's
 * extension case. Absent or unknown extensions keep the whole name as the stem
 * so the callers append the right suffix per format.
 *
 * 将文件名拆分为 stem 与扩展名——扩展名存在且为已知输出格式（大小写不敏感）
 * 时剥离，并保留输入扩展名的大小写。缺失或未知的扩展名将整体保留为 stem，
 * 由调用方按格式追加正确后缀。
 *
 * @param filename - File name without path separators / 不含路径分隔符的文件名
 * @returns The stem and the extension (with leading dot; `''` when absent) /
 *   拆分出的 stem 与扩展名（含前导点；缺失时为 `''`）
 * @example
 * splitOutputFilename('star-history.SVG') // { stem: 'star-history', ext: '.SVG' }
 * splitOutputFilename('chart') // { stem: 'chart', ext: '' }
 * splitOutputFilename('chart.webp') // { stem: 'chart.webp', ext: '' }
 */
function splitOutputFilename(filename: string): { stem: string; ext: string } {
  const i = filename.lastIndexOf('.')
  if (i <= 0) {
    return { stem: filename, ext: '' }
  }
  const ext = filename.slice(i + 1)
  return isKnownFormatExtension(ext)
    ? { stem: filename.slice(0, i), ext: `.${ext}` }
    : { stem: filename, ext: '' }
}

/**
 * Whether an extension (case-insensitive) matches an output format.
 *
 * 判断扩展名（大小写不敏感）是否为已知的输出格式。
 *
 * @param ext - Extension without the leading dot / 不含前导点的扩展名
 * @returns True when the extension is `svg`, `png`, or `json` / 当扩展名为 `svg`、`png` 或 `json` 时为真
 */
function isKnownFormatExtension(ext: string): boolean {
  return (OUTPUT_FORMATS as readonly string[]).includes(ext.toLowerCase())
}

/**
 * Chart output file for one theme: the SVG is always derived (it is the
 * rasterization source); the PNG exists only when the format list includes
 * `png`.
 *
 * 单个主题的图表输出文件：始终派生 SVG（它是栅格化的源）；仅当格式列表
 * 包含 `png` 时才派生 PNG。
 */
export interface ChartFileOutput {
  /** Theme this file belongs to / 该文件所属的主题。 */
  theme: ChartTheme
  /** Derived `.svg` file name / 派生出的 `.svg` 文件名。 */
  svgFile: string
  /** Derived `.png` file name; absent unless the format list includes `png` / 派生出的 `.png` 文件名；格式列表未含 `png` 时缺省。 */
  pngFile?: string
}

/**
 * Maps the requested themes to concrete chart file names.
 *
 * 将请求的主题映射为具体的图表文件名。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns One entry per theme: the `.svg` file keeps the input extension
 *   (preserving its case) or defaults to `.svg`; the `.png` twin is present
 *   only when the format list includes `png`. Single-theme runs keep the plain
 *   stem; multi-theme runs derive `-light`/`-dark` variants. A pure `json`
 *   export writes no charts, so it maps to an empty list. /
 *   每个主题一个条目：`.svg` 文件保留输入的扩展名（保留其大小写）或默认
 *   `.svg`；`.png` 孪生文件仅当格式列表包含 `png` 时存在。单主题运行保留
 *   原始 stem；多主题运行派生 `-light`/`-dark` 变体。纯 `json` 导出不写
 *   图表，映射为空列表。
 * @example
 * getChartFilePaths({ outputFilename: 'chart', themes: ['light', 'dark'], outputFormat: ['svg', 'png'] })
 * // [
 * //   { theme: 'light', svgFile: 'chart-light.svg', pngFile: 'chart-light.png' },
 * //   { theme: 'dark', svgFile: 'chart-dark.svg', pngFile: 'chart-dark.png' },
 * // ]
 */
export function getChartFilePaths(config: ActionConfig): ChartFileOutput[] {
  // A pure `json` export writes no charts; only a format list holding at least
  // one SVG-family entry (svg/png) derives chart files.
  if (config.outputFormat.every((format) => format === 'json')) {
    return []
  }
  const { stem, ext } = splitOutputFilename(config.outputFilename)
  // The SVG keeps a user-supplied .svg/.SVG extension as-is (case preserved);
  // the PNG twin is named for the png format. Without a known extension both
  // fall back to their canonical suffix.
  // SVG 保留用户提供的 .svg/.SVG 扩展名原样（保留大小写）；PNG 孪生文件按
  // png 格式命名。无已知扩展名时两者回退到各自的规范后缀。
  const svgExt = ext.toLowerCase() === '.svg' ? ext : '.svg'
  const pngExt = ext.toLowerCase() === '.png' ? ext : '.png'
  return config.themes.map((theme) => {
    const suffix = config.themes.length > 1 ? `-${theme}` : ''
    const output: ChartFileOutput = { theme, svgFile: `${stem}${suffix}${svgExt}` }
    // exactOptionalPropertyTypes: only set pngFile when it exists.
    if (config.outputFormat.includes('png')) {
      output.pngFile = `${stem}${suffix}${pngExt}`
    }
    return output
  })
}

/**
 * Derives the JSON data export file name from the `output-filename` stem: a
 * user-supplied `.json`/`.JSON` extension is kept as-is (case preserved),
 * anything else uses `.json`. The JSON holds every repo's records, so it is
 * theme-agnostic and never derives `-light`/`-dark` variants.
 *
 * 依据 `output-filename` 的 stem 派生 JSON 数据导出文件名：用户提供的
 * `.json`/`.JSON` 扩展名原样保留（保留大小写），其余情况使用 `.json`。
 * JSON 包含所有仓库的记录，与主题无关，因此不派生 `-light`/`-dark` 变体。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns The JSON file name / JSON 文件名
 * @example
 * getJsonFileName({ ...outputFilename: 'star-history.svg' })
 * // 'star-history.json'
 */
export function getJsonFileName(config: ActionConfig): string {
  const { stem, ext } = splitOutputFilename(config.outputFilename)
  return `${stem}${ext.toLowerCase() === '.json' ? ext : '.json'}`
}

/**
 * Derives the incremental-fetch cache file name from the `output-filename`
 * stem, appending `.cache.json`. The cache holds every repo's records in one
 * theme-agnostic file, so it never derives `-light`/`-dark` variants.
 *
 * 依据 `output-filename` 的 stem 派生增量抓取缓存文件名，追加 `.cache.json`。
 * 缓存将所有仓库的记录聚合到一个与主题无关的文件中，因此不派生
 * `-light`/`-dark` 变体。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @returns The cache file name / 缓存文件名
 * @example
 * getCacheFileName({ ...outputFilename: 'star-history.svg' })
 * // 'star-history.cache.json'
 */
export function getCacheFileName(config: ActionConfig): string {
  const { stem } = splitOutputFilename(config.outputFilename)
  return `${stem}.cache.json`
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
  const { stem, ext } = splitOutputFilename(config.outputFilename)
  const repoPart = config.repos.length > 1 ? `-${repo.replaceAll('/', '-')}` : ''
  const themePart = theme && config.themes.length > 1 ? `-${theme}` : ''
  return `${stem}-radar${repoPart}${themePart}${ext}`
}

/**
 * Maps the requested themes to concrete radar chart file names for one repo,
 * reusing the same naming rules as {@link getChartFilePaths}: theme suffixes
 * for multi-theme runs, and `.png` derivation when the format list includes
 * `png`.
 *
 * 将请求的主题映射为某个仓库的雷达图具体文件名，复用
 * {@link getChartFilePaths} 的命名规则：多主题运行追加主题后缀，格式列表
 * 包含 `png` 时派生 `.png` 文件名。
 *
 * @param config - Parsed action inputs / 解析后的动作输入
 * @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
 * @returns One entry per theme with the derived `.svg` (and, when the format
 *   list includes `png`, `.png`) radar file names / 每个主题一个条目，包含派生的
 *   `.svg`（以及格式列表包含 `png` 时的 `.png`）雷达图文件名
 * @example
 * getRadarFilePaths({ ...themes: ['light', 'dark'], outputFormat: ['svg', 'png'], repos: ['a/b'] }, 'a/b')
 * // [
 * //   { theme: 'light', svgFile: 'star-history-radar-light.svg', pngFile: 'star-history-radar-light.png' },
 * //   { theme: 'dark', svgFile: 'star-history-radar-dark.svg', pngFile: 'star-history-radar-dark.png' },
 * // ]
 */
export function getRadarFilePaths(config: ActionConfig, repo: string): ChartFileOutput[] {
  return getChartFilePaths({ ...config, outputFilename: getRadarFileName(config, repo) })
}
