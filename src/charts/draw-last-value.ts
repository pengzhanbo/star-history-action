import type { D3Selection } from './types.js'
import { getFormatNumber, getNumberFormatUnit } from './get-format-number.js'

/**
 * Configuration for the end-value pill renderer.
 *
 * 末端数值胶囊标签渲染器的配置。
 */
export interface DrawLastValueConfig {
  /**
   * Value to label — the latest star count of a dataset /
   * 要标注的数值——数据集最新的 star 数量。
   */
  value: number
  /**
   * X pixel of the latest point / 最新点的 x 像素坐标。
   */
  x: number
  /**
   * Y pixel of the latest point / 最新点的 y 像素坐标。
   */
  y: number
  /**
   * Fill color of the pill — the dataset color / 胶囊填充色——数据集颜色。
   */
  color: string
  /**
   * Plot width in px, used to keep the pill inside the canvas /
   * 绘图区宽度（像素），用于将胶囊约束在画布内。
   */
  chartWidth: number
}

/**
 * Picks a readable pill text color from the background luminance.
 *
 * 根据背景亮度选择可读的胶囊文字颜色。
 *
 * @param color - The pill fill color (hex) / 胶囊填充色（十六进制）
 * @returns `#000` on light fills, `#fff` otherwise / 亮色填充返回 `#000`，否则返回 `#fff`
 */
function getContrastTextColor(color: string): string {
  const hex = color.startsWith('#') ? color.slice(1) : ''
  if (hex.length !== 6) {
    return '#fff'
  }
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

  return luminance > 0.6 ? '#000' : '#fff'
}

/**
 * Draws a pill label with the formatted latest value at the newest point,
 * anchored above the point and flipped below it when the top would clip.
 *
 * 在最新数据点处绘制带格式化最新值的胶囊标签：默认位于点的上方，
 * 当上方超出画布时翻转到点的下方。
 *
 * @param selection - Selection to append the pill into / 要追加胶囊的 selection
 * @param config - Pill configuration / 胶囊配置
 */
export function drawLastValue(
  selection: D3Selection,
  { value, x, y, color, chartWidth }: DrawLastValueConfig,
): void {
  const text = getFormatNumber(value, getNumberFormatUnit(value))
  const fontSize = 14
  const height = 24
  const paddingX = 8
  // jsdom cannot measure text; estimate the pill width from the character
  // count at the xkcd font's typical 6.5px/char at 14px.
  // jsdom 无法测量文本；按 xkcd 字体在 14px 下约 6.5px/字符估算胶囊宽度。
  const width = text.length * 6.5 + paddingX * 2

  // The pill sits above the point by default and flips below it when the
  // default position would clip off the top of the plot.
  // 胶囊默认位于点的上方，当默认位置超出绘图区顶部时翻转到点的下方。
  const gap = 10
  const rectY = y - gap - height < 0 ? y + gap : y - gap - height

  // Keep the pill inside the plot horizontally.
  // 水平方向将胶囊约束在绘图区内。
  const centerX = Math.min(Math.max(x, width / 2), chartWidth - width / 2)

  const group = selection.append('g').attr('class', 'xkcd-chart-xy-end-value')
  group
    .append('rect')
    .attr('x', centerX - width / 2)
    .attr('y', rectY)
    .attr('width', width)
    .attr('height', height)
    .attr('rx', height / 2)
    .attr('ry', height / 2)
    .attr('filter', 'url(#xkcdify)')
    .style('fill', color)
  group
    .append('text')
    .attr('x', centerX)
    .attr('y', rectY + height / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', 'middle')
    .style('font-size', `${fontSize}px`)
    .style('font-weight', 'bold')
    .style('fill', getContrastTextColor(color))
    .text(text)
}
