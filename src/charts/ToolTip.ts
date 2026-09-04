import type { D3Selection, Position } from './types.js'

/**
 * Configuration for creating or updating a tooltip.
 *
 * 创建或更新工具提示的配置。
 */
interface ToolTipConfig {
  /**
   * Container to append the tooltip into / 追加工具提示的容器。
   */
  selection: D3Selection
  /**
   * Tooltip headline / 工具提示的标题。
   */
  title: string
  /**
   * Rows shown below the title / 标题下方的数据行。
   */
  items: {
    /**
     * Row marker color / 行标记颜色。
     */
    color: string
    /**
     * Row label / 行标签。
     */
    text: string
  }[]
  /**
   * Anchor point and which side the tooltip opens toward /
   * 锚点位置以及工具提示的弹出方向。
   */
  position: {
    x: number
    y: number
    type: Position
  }
  /**
   * Fill color of the tooltip background / 工具提示背景的填充颜色。
   */
  backgroundColor: string
  /**
   * Color of text and borders / 文字与边框颜色。
   */
  strokeColor: string
}

/**
 * An xkcd-styled tooltip for the chart's data points.
 *
 * 图表数据点的 xkcd 风格工具提示。
 *
 * Starts hidden (`visibility: hidden`) until `show()` is called. In Node
 * environments (image export) it is never shown, so it never measures text.
 *
 * 初始隐藏（`visibility: hidden`），直到调用 `show()`。在 Node 环境（图片
 * 导出）中从不显示，因此也不会进行文本测量。
 */
class ToolTip {
  /**
   * Tooltip headline / 工具提示的标题。
   */
  title: string
  /**
   * Rows shown below the title / 标题下方的数据行。
   */
  items: {
    color: string
    text: string
  }[]
  /**
   * Anchor point and opening direction / 锚点位置与弹出方向。
   */
  position: {
    x: number
    y: number
    type: Position
  }
  /**
   * Background fill color / 背景填充颜色。
   */
  backgroundColor: string
  /**
   * Text and border color / 文字与边框颜色。
   */
  strokeColor: string
  /**
   * Wobble filter applied to the background / 应用于背景的抖动滤镜。
   */
  filter = 'url(#xkcdify)'
  /**
   * Root element of the tooltip / 工具提示的根元素。
   */
  svg: D3Selection
  /**
   * Title text element / 标题文本元素。
   */
  tipTitle: any
  /**
   * Per-row groups (swatch + label) / 每行分组（色块 + 标签）。
   */
  tipItems: any
  /**
   * Background rectangle / 背景矩形。
   */
  tipBackground: any

  /**
   * Creates a new (initially hidden) tooltip.
   *
   * 创建新的（初始隐藏的）工具提示。
   *
   * @param config - Tooltip configuration / 工具提示配置
   */
  constructor({ selection, title, items, position, backgroundColor, strokeColor }: ToolTipConfig) {
    this.title = title
    this.items = items
    this.position = position
    this.backgroundColor = backgroundColor
    this.strokeColor = strokeColor

    this.svg = selection
      .append('svg')
      .attr('x', this._getUpLeftX())
      .attr('y', this._getUpLeftY())
      .style('visibility', 'hidden') as D3Selection

    this.tipBackground = this.svg
      .append('rect')
      .style('fill', this.backgroundColor)
      .attr('fill-opacity', 0.9)
      .attr('stroke', strokeColor)
      .attr('stroke-width', 2)
      .attr('rx', 5)
      .attr('ry', 5)
      .attr('filter', this.filter)
      .attr('width', this._getBackgroundWidth())
      .attr('height', this._getBackgroundHeight())
      .attr('x', 5)
      .attr('y', 5)

    this.tipTitle = this.svg
      .append('text')
      .style('font-size', '15px')
      .style('font-weight', 'bold')
      .style('fill', this.strokeColor)
      .attr('x', 15)
      .attr('y', 25)
      .text(title)

    this.tipItems = items.map((item, i) => {
      const g = this._generateTipItem(item, i)
      return g
    })
  }

  /**
   * Makes the tooltip visible / 显示工具提示。
   */
  show(): void {
    this.svg.style('visibility', 'visible')
  }

  /**
   * Hides the tooltip / 隐藏工具提示。
   */
  hide(): void {
    this.svg.style('visibility', 'hidden')
  }

  /**
   * Refreshes the tooltip's title, rows, or anchor position.
   *
   * 更新工具提示的标题、数据行或锚点位置。
   *
   * @param config - Partial/total tooltip state; unchanged props are kept /
   *   部分或完整的工具提示状态；未变化的属性保持不变
   */
  // update tooltip position / content
  update({ title, items, position }: ToolTipConfig): void {
    if (title && title !== this.title) {
      this.title = title
      this.tipTitle.text(title)
    }

    if (items && JSON.stringify(items) !== JSON.stringify(this.items)) {
      this.items = items

      this.tipItems.forEach((g: { svg: any }) => g.svg.remove())

      this.tipItems = this.items.map((item, i) => {
        const g = this._generateTipItem(item, i)
        return g
      })

      const maxWidth = Math.max(
        ...this.tipItems.map((item: { width: number }) => item.width),
        this.tipTitle.node().getBBox().width,
      )

      this.tipBackground.attr('width', maxWidth + 15).attr('height', this._getBackgroundHeight())
    }

    if (position) {
      this.position = position
      this.svg.attr('x', this._getUpLeftX())
      this.svg.attr('y', this._getUpLeftY())
    }
  }

  /**
   * Builds one row (color swatch + label) and measures its dimensions.
   *
   * 构建一行（色块 + 标签）并测量其尺寸。
   *
   * @param item - Row content / 行内容
   * @param i - Row index, used for vertical stacking / 行索引，用于垂直排布
   * @returns The appended row group with its measured size /
   *   追加的行分组及其测量尺寸
   */
  _generateTipItem(
    item: { color: string; text: string },
    i: number,
  ): { svg: D3Selection; width: number; height: number } {
    const svg = this.svg.append('svg') as D3Selection

    svg
      .append('rect')
      .style('fill', item.color)
      .attr('width', 8)
      .attr('height', 8)
      .attr('rx', 2)
      .attr('ry', 2)
      .attr('filter', this.filter)
      .attr('x', 15)
      .attr('y', 37 + 20 * i)

    svg
      .append('text')
      .style('font-size', '15px')
      .style('fill', this.strokeColor)
      .attr('x', 15 + 12)
      .attr('y', 37 + 20 * i + 8)
      .text(item.text)

    const bbox = svg.node()!.getBBox()
    const width = bbox.width + 15
    const height = bbox.height + 10
    return {
      svg,
      width,
      height,
    }
  }

  /**
   * Background width estimated from the longest row text (no DOM measurement).
   *
   * 根据最长行文本估算背景宽度（无需 DOM 测量）。
   *
   * @returns Estimated width in px / 估算的宽度（像素）
   */
  _getBackgroundWidth(): number {
    // oxlint-disable-next-line unicorn/no-array-reduce
    const maxItemLength = this.items.reduce(
      (pre, cur) => (pre > cur.text.length ? pre : cur.text.length),
      0,
    )
    const maxLength = Math.max(maxItemLength, this.title.length)

    return maxLength * 7.4 + 25
  }

  /**
   * Background height for the title plus one row per item.
   *
   * 标题加每行条目对应的背景高度。
   *
   * @returns Estimated height in px / 估算的高度（像素）
   */
  _getBackgroundHeight(): number {
    const rows = this.items.length + 1
    return rows * 20 + 10
  }

  /**
   * Left-most x of the tip, keeping left-opening tips left of the anchor.
   *
   * 提示的最左 x 坐标，向左展开的提示保持在锚点左侧。
   *
   * @returns X position for the root element / 根元素的 x 位置
   */
  _getUpLeftX(): number {
    if (this.position.type === 'up_right' || this.position.type === 'down_right') {
      return this.position.x
    }
    return this.position.x - this._getBackgroundWidth() - 20
  }

  /**
   * Top-most y of the tip, keeping down-opening tips below the anchor.
   *
   * 提示的最上 y 坐标，向下展开的提示保持在锚点下方。
   *
   * @returns Y position for the root element / 根元素的 y 位置
   */
  _getUpLeftY(): number {
    if (this.position.type === 'down_left' || this.position.type === 'down_right') {
      return this.position.y
    }
    return this.position.y - this._getBackgroundHeight() - 20
  }
}

export default ToolTip
