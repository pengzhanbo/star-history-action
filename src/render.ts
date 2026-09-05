import type { XYChartConfig, XYChartData } from './charts/index.js'
import { JSDOM } from 'jsdom'
import { optimize } from 'svgo'
import { XYChart } from './charts/index.js'
import { getSubsetFontUrl } from './common/font-subset.js'

/**
 * Inputs for rendering a star-history chart.
 *
 * 渲染 star-history 图表的输入。
 */
export interface RenderChartInput {
  /**
   * Repository in `owner/repo` form; used as the dataset label AND chart title.
   *
   * `owner/repo` 形式的仓库标识；同时用作数据集标签与图表标题。
   */
  repo: string // 'owner/name' — used as dataset label AND chart title
  /**
   * Avatar URL from getRepoLogo; `''` means no title logo.
   *
   * 来自 getRepoLogo 的头像 URL；为空字符串时标题不显示 logo。
   */
  logo: string // avatar URL from getRepoLogo; '' means no title logo
  /**
   * Star records ascending by date; shape from api.getRepoStarRecords.
   *
   * 按日期升序的 star 记录；结构来自 api.getRepoStarRecords。
   */
  records: { date: string; stars: number }[] // ascending by date; shape from api.getRepoStarRecords
  /**
   * Chart theme to render.
   *
   * 要渲染的图表主题。
   */
  theme: 'light' | 'dark'
  /**
   * Width of the generated SVG in pixels (the svg-width input).
   *
   * 生成的 SVG 宽度（像素），对应 svg-width 输入。
   */
  width: number // svg-width input
}

/**
 * Renders a complete standalone SVG string for a single theme.
 *
 * The full embedded xkcd font is swapped at the end for a woff2 subset that
 * contains only the glyphs used by the actual chart text, cutting the inlined
 * font from ~50KB to a few KB.
 *
 * 为单个主题渲染完整的独立 SVG 字符串。
 *
 * 渲染完成后会用仅包含图表实际文本字形的小体积 woff2 子集替换内嵌的完整
 * xkcd 字体，将内联字体从约 50KB 压缩到几 KB。
 *
 * @param input - Chart rendering inputs / 图表渲染输入
 * @returns The serialized SVG markup / 序列化后的 SVG 标记
 * @example
 * const svg = await renderStarHistorySvg({
 *   repo: 'owner/repo',
 *   logo: '',
 *   records,
 *   theme: 'dark',
 *   width: 960,
 * })
 */
export async function renderStarHistorySvg(input: RenderChartInput): Promise<string> {
  // A fresh document per call avoids any cross-render residue; at most 2 calls per run.
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const { document } = dom.window

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  // jsdom serializes HTML-style (namespace implied); standalone consumers
  // (XML parsers, resvg) require an explicit xmlns.
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(input.width))

  const data: XYChartData = {
    datasets: [
      {
        label: input.repo,
        logo: input.logo,
        data: input.records.map((record) => ({
          x: new Date(`${record.date}T00:00:00Z`),
          y: record.stars,
        })),
      },
    ],
  }

  const config: XYChartConfig = {
    title: 'Star History',
    xLabel: 'Date',
    yLabel: 'Stars',
    data,
    showDots: false,
    transparent: false,
    theme: input.theme,
  }

  XYChart(svg, config, {
    // jsdom reports a zero-width bounding rect; drawTitle falls back to this
    // width so a non-empty logo is placed on-canvas, not at negative x.
    chartWidth: input.width,
  })

  // Replace the full xkcd font with a woff2 subset covering only the glyphs
  // actually used by the chart text. On subsetting failure keep the full font
  // injected by addFont untouched.
  const styleEl = svg.querySelector('style')
  if (styleEl) {
    try {
      const chartText = Array.from(svg.querySelectorAll('text'))
        .map((el) => el.textContent ?? '')
        .join('')
      const fontUrl = await getSubsetFontUrl(chartText)
      styleEl.textContent = `@font-face { font-family: "xkcd"; src: url(${fontUrl}) format('woff2'); }`
    } catch {
      // Fall back to the full font added by addFont.
    }
  }

  const output = fixJsdomSvgCasing(svg.outerHTML)
  dom.window.close()
  return optimize(output, { multipass: true }).data
}

function fixJsdomSvgCasing(svgContent: string): string {
  return (
    svgContent
      .replace(/feturbulence/g, 'feTurbulence')
      .replace(/fedisplacementmap/g, 'feDisplacementMap')
      .replace(/filterunits/g, 'filterUnits')
      .replace(/basefrequency/g, 'baseFrequency')
      .replace(/xchannelselector/g, 'xChannelSelector')
      .replace(/ychannelselector/g, 'yChannelSelector')
      // Set by drawTitle on a <text> under the HTML-namespace root, where JSDOM
      // lowercases attribute names. Matched with the "=" so a repo name that
      // happens to contain the word is left alone.
      .replace(/\btextlength=/g, 'textLength=')
      .replace(/\blengthadjust=/g, 'lengthAdjust=')
  )
}
