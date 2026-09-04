import type { D3Selection, Position } from './types.js'

interface ToolTipConfig {
  selection: D3Selection
  title: string
  items: {
    color: string
    text: string
  }[]
  position: {
    x: number
    y: number
    type: Position
  }
  backgroundColor: string
  strokeColor: string
}

class ToolTip {
  title: string
  items: {
    color: string
    text: string
  }[]
  position: {
    x: number
    y: number
    type: Position
  }
  backgroundColor: string
  strokeColor: string
  filter = 'url(#xkcdify)'
  svg: D3Selection
  tipTitle: any
  tipItems: any
  tipBackground: any

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

  show(): void {
    this.svg.style('visibility', 'visible')
  }

  hide(): void {
    this.svg.style('visibility', 'hidden')
  }

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

  _getBackgroundWidth(): number {
    // oxlint-disable-next-line unicorn/no-array-reduce
    const maxItemLength = this.items.reduce(
      (pre, cur) => (pre > cur.text.length ? pre : cur.text.length),
      0,
    )
    const maxLength = Math.max(maxItemLength, this.title.length)

    return maxLength * 7.4 + 25
  }

  _getBackgroundHeight(): number {
    const rows = this.items.length + 1
    return rows * 20 + 10
  }

  _getUpLeftX(): number {
    if (this.position.type === 'up_right' || this.position.type === 'down_right') {
      return this.position.x
    }
    return this.position.x - this._getBackgroundWidth() - 20
  }

  _getUpLeftY(): number {
    if (this.position.type === 'down_left' || this.position.type === 'down_right') {
      return this.position.y
    }
    return this.position.y - this._getBackgroundHeight() - 20
  }
}

export default ToolTip
