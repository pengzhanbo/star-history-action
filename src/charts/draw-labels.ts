import type { D3Selection } from './types.js'

/**
 * Title font size in px; also feeds the node-env width estimate.
 *
 * 标题字体大小（像素），同时用于 node 环境下的宽度估算。
 */
const TITLE_FONT_SIZE = 20
/**
 * Title logo (owner avatar) side length in px / 标题 logo（owner 头像）边长（像素）。
 */
const TITLE_LOGO_SIZE = 22
/**
 * Gap between the title logo and the title text in px /
 * 标题 logo 与标题文字之间的间距（像素）。
 */
const TITLE_LOGO_GAP = 8
/**
 * Estimated average glyph width per character as a fraction of the font size.
 * Used only when the environment cannot measure text (jsdom has no layout).
 *
 * 每个字符的平均宽度估算值（字体大小的比例）。仅在环境无法测量文本时
 * （jsdom 没有布局引擎）使用。
 */
const TITLE_TEXT_WIDTH_FACTOR = 0.6

/**
 * Measures the rendered width of a title text node; falls back to a length
 * based estimate when the environment cannot lay out text (node/jsdom).
 *
 * 测量标题文本节点的渲染宽度；当环境无法排版文本时（node/jsdom）
 * 回退到基于字数的估算。
 *
 * @param node - The appended text node / 已追加的文本节点
 * @param text - The title text, used for the estimate / 标题文字，用于估算
 * @returns The text width in px / 文本宽度（像素）
 */
function measureTitleTextWidth(node: SVGTextElement | null, text: string): number {
  if (node) {
    if (typeof node.getComputedTextLength === 'function') {
      return node.getComputedTextLength()
    }
    if (typeof node.getBBox === 'function') {
      const width = node.getBBox().width
      if (width > 0) {
        return width
      }
    }
  }
  return text.length * TITLE_FONT_SIZE * TITLE_TEXT_WIDTH_FACTOR
}

/**
 * Appends the circular clip path and the clipped logo image.
 *
 * 追加圆形裁剪路径与被裁剪的 logo 图片。
 *
 * @param selection - Selection to append into / 要追加的 selection
 * @param logoURL - Avatar URL / 头像 URL
 * @param logoX - Logo left edge position / logo 的左边缘位置
 * @param clipX - Clip circle center x, aligned with the logo center /
 *   裁剪圆圆心 x，与 logo 中心对齐
 */
function appendLogoAndClip(
  selection: D3Selection,
  logoURL: string,
  logoX: string | number,
  clipX: string | number,
): void {
  selection
    .append('svg')
    .append('defs')
    .append('clipPath')
    .attr('id', 'clip-circle-title')
    .append('circle')
    .attr('r', 11)
    .attr('cx', clipX)
    .attr('cy', 12 + 11)
  selection
    .append('image')
    .attr('x', logoX)
    .attr('y', 12)
    .attr('height', TITLE_LOGO_SIZE)
    .attr('width', TITLE_LOGO_SIZE)
    .attr('href', logoURL)
    .attr('clip-path', 'url(#clip-circle-title)')
}

/**
 * Draws the centered chart title, optionally with a circular owner logo.
 *
 * 绘制居中的图表标题，可选地附带圆形 owner 头像。
 *
 * The logo and the text are laid out as one group (`[logo][gap][text]`) and
 * the whole group is horizontally centered. A fixed pixel offset from the
 * text center would overlap long titles and leave short ones off-center.
 *
 * logo 与文字作为一组（`[logo][间距][文字]`）整体水平居中；若按固定像素
 * 偏移放置 logo，长标题会与其重叠，短标题又会整体偏离中心。
 *
 * @param selection - Selection to append the title into / 要追加标题的 selection
 * @param text - Title text / 标题文字
 * @param logoURL - Avatar URL; `''` skips the logo / 头像 URL，为空时跳过 logo
 * @param color - Text color / 文字颜色
 * @param chartWidth - Chart width in px; used to place the logo precisely /
 *   图表宽度（像素），用于精确放置 logo
 */
export function drawTitle(
  selection: D3Selection,
  text: string,
  logoURL: string,
  color: string,
  chartWidth?: number,
): void {
  const svgWidth = chartWidth ?? selection.node()?.getBoundingClientRect().width ?? 0

  const textNode = selection
    .append('text')
    .style('font-size', `${TITLE_FONT_SIZE}px`)
    .style('font-weight', 'bold')
    .style('fill', color)
    .attr('y', 30)
    .attr('text-anchor', 'middle')
    .attr('x', '50%')
    .text(text)
    .node()

  if (!logoURL) {
    // Plain title: the default 50% x already centers it.
    return
  }

  if (!svgWidth) {
    // No measurable width (detached element): keep the legacy percentage layout.
    appendLogoAndClip(selection, logoURL, '38%', '39.5%')
    return
  }

  const centerX = svgWidth / 2
  const textWidth = measureTitleTextWidth(textNode, text)
  const groupLeft = centerX - (TITLE_LOGO_SIZE + TITLE_LOGO_GAP + textWidth) / 2
  textNode?.setAttribute('x', String(groupLeft + TITLE_LOGO_SIZE + TITLE_LOGO_GAP + textWidth / 2))
  appendLogoAndClip(selection, logoURL, groupLeft, groupLeft + TITLE_LOGO_SIZE / 2)
}

/**
 * Draws the centered x-axis label at the bottom of the chart.
 *
 * 在图表底部绘制居中的 x 轴标签。
 *
 * @param selection - Selection to append the label into / 要追加标签的 selection
 * @param text - Label text / 标签文字
 * @param color - Text color / 文字颜色
 */
export function drawXLabel(selection: D3Selection, text: string, color: string): void {
  selection
    .append('text')
    .style('font-size', '17px')
    .style('fill', color)
    .attr('x', '50%')
    .attr('y', ((selection.attr('height') as unknown as number) || 10) - 10)
    .attr('text-anchor', 'middle')
    .text(text)
}

/**
 * Draws the rotated y-axis label along the left edge of the chart.
 *
 * 绘制图表左侧旋转 90 度的 y 轴标签。
 *
 * @param selection - Selection to append the label into / 要追加标签的 selection
 * @param text - Label text / 标签文字
 * @param color - Text color / 文字颜色
 * @param offsetY - Vertical offset of the label / 标签的垂直偏移
 */
export function drawYLabel(selection: D3Selection, text: string, color: string, offsetY = 6): void {
  selection
    .append('text')
    .attr('text-anchor', 'end')
    .attr('dy', '.75em')
    .attr('transform', 'rotate(-90)')
    .style('font-size', '17px')
    .style('fill', color)
    .text(text)
    .attr('y', offsetY)
    .call((f) => {
      const defaultTextLength = 100
      let textLength = defaultTextLength
      // Because there is no `getComputedTextLength` method in nodejs env,
      // we have to use it after validate function existed.
      if (f.node()?.getComputedTextLength) {
        textLength = f.node()?.getComputedTextLength() as number
      }

      const offsetX = Math.floor(
        textLength / 2 - ((selection.attr('height') as unknown as number) || 10) / 2,
      )
      f.attr('x', offsetX)
    })
}
