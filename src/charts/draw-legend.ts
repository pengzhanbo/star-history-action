// oxlint-disable max-lines-per-function

import type { D3Selection, LegendPosition } from './types.js'
import { uniq } from '@pengzhanbo/utils'

/**
 * Configuration for the legend renderer.
 *
 * 图例渲染器的配置。
 */
interface DrawLegendConfig {
  /**
   * Legend rows: color swatch, optional logo, and text.
   *
   * 图例行：色块、可选 logo 与文本。
   */
  items: {
    /**
     * Color of the swatch / 色块颜色。
     */
    color: string
    /**
     * Display text, usually `owner/repo` / 显示文本，通常是 `owner/repo`。
     */
    text: string
    /**
     * Avatar URL; drawn when multiple owners exist / 头像 URL，存在多个所有者时绘制。
     */
    logo: string
  }[]
  /**
   * Color of text and borders / 文字与边框颜色。
   */
  strokeColor: string
  /**
   * Fill color of the legend background / 图例背景的填充颜色。
   */
  backgroundColor: string
  /**
   * Where to place the legend / 图例的放置位置。
   */
  legendPosition: LegendPosition
  /**
   * Chart width in px, used to anchor bottom-right placement /
   * 图表宽度（像素），用于右下角放置定位。
   */
  chartWidth: number
  /**
   * Chart height in px, used to anchor bottom-right placement /
   * 图表高度（像素），用于右下角放置定位。
   */
  chartHeight: number
}

/**
 * Draws the dataset legend (color swatches, owner logos, labels).
 *
 * 绘制数据集图例（色块、所有者 logo、标签）。
 *
 * @param selection - Selection to append the legend into / 要追加图例的 selection
 * @param config - Legend configuration / 图例配置
 */
export function drawLegend(
  selection: D3Selection,
  {
    items,
    strokeColor,
    backgroundColor,
    legendPosition,
    chartWidth,
    chartHeight,
  }: DrawLegendConfig,
): void {
  const legendXPadding = 7
  const legendYPadding = 6
  const xkcdCharWidth = 7
  const xkcdCharHeight = 20
  const colorBlockWidth = 8
  const logoSize = 14

  const legend = selection.append('svg')
  const backgroundLayer = legend.append('svg')
  const textLayer = legend.append('svg')
  let maxTextLength = 0
  // If repos have more than one unique owner, draw logo before legend.
  const shouldDrawLogo = uniq(items.map((i) => i.text.split('/')[0])).length > 1

  // Calculate background dimensions first
  items.forEach((item) => {
    maxTextLength = Math.max(item.text.length, maxTextLength)
  })

  let bboxWidth = maxTextLength * (xkcdCharWidth + 0.5) + colorBlockWidth + legendXPadding
  const backgroundWidth = Math.max(
    bboxWidth + legendXPadding * 2,
    maxTextLength * xkcdCharWidth +
      colorBlockWidth +
      legendXPadding * 2 +
      6 +
      (shouldDrawLogo ? legendXPadding + logoSize : 0),
  )
  const backgroundHeight = items.length * xkcdCharHeight + legendYPadding * 2

  // Calculate position based on legendPosition
  let legendX = 8
  let legendY = 5

  if (legendPosition === 'bottom-right') {
    legendX = chartWidth - backgroundWidth - 8
    legendY = chartHeight - backgroundHeight - 15
  }

  items.forEach((item, i) => {
    // draw color dot
    textLayer
      .append('rect')
      .style('fill', item.color)
      .attr('width', colorBlockWidth)
      .attr('height', colorBlockWidth)
      .attr('rx', 2)
      .attr('ry', 2)
      .attr('filter', 'url(#xkcdify)')
      .attr('x', legendX + legendXPadding)
      .attr('y', legendY + 12 + xkcdCharHeight * i)
    if (shouldDrawLogo) {
      textLayer
        .append('defs')
        .append('clipPath')
        .attr('id', `clip-circle-title-${item.text}`)
        .append('circle')
        .attr('r', logoSize / 2)
        .attr('cx', legendX + legendXPadding + colorBlockWidth + legendXPadding + logoSize / 2)
        .attr('cy', legendY + 12 + xkcdCharHeight * i - 4 + logoSize / 2)
      textLayer
        .append('image')
        .attr('x', legendX + legendXPadding + colorBlockWidth + legendXPadding)
        .attr('y', legendY + 12 + xkcdCharHeight * i - 4)
        .attr('height', logoSize)
        .attr('width', logoSize)
        .attr('href', item.logo)
        .attr('clip-path', `url(#clip-circle-title-${item.text})`)
    }
    // draw text
    textLayer
      .append('text')
      .style('font-size', '15px')
      .style('fill', strokeColor)
      .attr(
        'x',
        legendX +
          legendXPadding +
          colorBlockWidth +
          (shouldDrawLogo ? legendXPadding + logoSize : 0) +
          6,
      )
      .attr('y', legendY + 12 + xkcdCharHeight * i + 8)
      .text(item.text)
  })

  // Update bboxWidth with actual width if possible
  if (textLayer.node()?.getBBox) {
    bboxWidth = textLayer.node()?.getBBox().width as number
  }

  // add background
  backgroundLayer
    .append('rect')
    .style('fill', backgroundColor)
    .attr('fill-opacity', 0.85)
    .attr('stroke', strokeColor)
    .attr('stroke-width', 2)
    .attr('rx', 5)
    .attr('ry', 5)
    .attr('filter', 'url(#xkcdify)')
    .attr('width', backgroundWidth)
    .attr('height', backgroundHeight)
    .attr('x', legendX)
    .attr('y', legendY)
}
