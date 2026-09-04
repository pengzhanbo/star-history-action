// oxlint-disable max-lines-per-function
import type { AxisScale } from 'd3-axis'
import type { D3Selection, Position, LegendPosition } from './types.js'
import { uniq } from '@pengzhanbo/utils'
import { scaleLinear, scaleTime, scaleSymlog } from 'd3-scale'
import { select } from 'd3-selection'
import { line, curveMonotoneX } from 'd3-shape'
import dayjs from 'dayjs'
import { colors, darkColors } from '../common/colors.js'
import { addFilter } from './add-filter.js'
import { addFont } from './add-font.js'
import { drawXAxis, drawYAxis } from './draw-axis.js'
import { drawTitle, drawXLabel, drawYLabel } from './draw-labels.js'
import { drawLegend } from './draw-legend.js'
// import { drawWatermark } from './draw-watermark.js'
import { getFormatTimeline, getTimestampFormatUnit } from './get-format-timeline.js'
import ToolTip from './ToolTip.js'

/**
 * Base chart padding, copied per render so consecutive renders never
 * contaminate each other's state.
 *
 * 图表的基础留白，每次渲染复制一份，避免连续渲染之间相互污染状态。
 */
const margin = {
  top: 50,
  right: 30,
  bottom: 50,
  left: 50,
}

/**
 * A single charted point: x is a date (or number with `xTickLabelType:
 * 'Number'`) and y is the value.
 *
 * 图表中的单个数据点：x 为日期（在 `xTickLabelType: 'Number'` 时为数值），
 * y 为数值。
 */
interface XYPoint {
  x: Date | number
  y: number
}

/**
 * One dataset: label (`owner/repo` semantics), optional logo, and points.
 *
 * 单个数据集：标签（`owner/repo` 语义）、可选 logo 及数据点。
 */
export interface XYData {
  /**
   * Dataset label — owner uniqueness gates title/legend logos, and lowercase
   * matches gate the moltbot/openclaw easter eggs.
   *
   * 数据集标签——通过 unique owner 数量决定标题/图例 logo，小写匹配
   * 决定 moltbot/openclaw 彩蛋。
   */
  label: string
  /**
   * Avatar URL of the dataset owner / 数据集所有者的头像 URL。
   */
  logo: string
  /**
   * Charted points / 图表数据点。
   */
  data: XYPoint[]
}

/**
 * Chart data: the list of datasets to render.
 *
 * 图表数据：需要渲染的数据集列表。
 */
export interface XYChartData {
  datasets: XYData[]
}

/**
 * Public surface of the chart: config layer passed by callers.
 *
 * 图表的公开入口：由调用方传入的配置层。
 */
export interface XYChartConfig {
  /**
   * Chart title text / 图表标题文字。
   */
  title: string
  /**
   * X-axis label / x 轴标签。
   */
  xLabel: string
  /**
   * Y-axis label / y 轴标签。
   */
  yLabel: string
  /**
   * Underlying data / 底层数据。
   */
  data: XYChartData
  /**
   * Render a dot for every data point / 为每个数据点绘制圆点。
   */
  showDots: boolean
  /**
   * Use transparent backgrounds instead of theme colors /
   * 使用透明背景而非主题色。
   */
  transparent: boolean
  /**
   * Theme used to pick default colors; `light` when omitted /
   * 用于选择默认颜色的主题；省略时使用 `light`。
   */
  theme?: 'light' | 'dark'
}

/**
 * How x-axis tick values are interpreted / x 轴刻度值的解释方式。
 */
type XTickLabelType = 'Date' | 'Number'

/**
 * Loose tuning knobs merged over the theme defaults.
 *
 * 在主题默认值之上合并的可选调优项。
 */
export interface XYChartOptions {
  /**
   * Environment the chart renders in — gates responsive sizing,
   * animation styles and tooltip behavior / 图表渲染环境——决定响应式
   * 尺寸、动画样式与工具提示行为。
   */
  envType: 'browser' | 'node'
  /**
   * Tick label interpretation for x / x 轴刻度标签的解释方式。
   */
  xTickLabelType: XTickLabelType
  /**
   * Tooltip date format / 工具提示的日期格式。
   */
  dateFormat?: string
  /**
   * Suggested x tick count / 建议的 x 轴刻度数量。
   */
  xTickCount: number
  /**
   * Suggested y tick count / 建议的 y 轴刻度数量。
   */
  yTickCount: number
  /**
   * Draw the lines themselves / 是否绘制折线本身。
   */
  showLine: boolean
  /**
   * Dot size multiplier (0.5 default) / 圆点尺寸倍率（默认 0.5）。
   */
  dotSize: number
  /**
   * Per-dataset colors, index by dataset position / 按数据集位置索引的颜色。
   */
  dataColors: string[]
  /**
   * Font family used across the chart / 图表统一使用的字体族。
   */
  fontFamily: string
  /**
   * Chart background color / 图表背景颜色。
   */
  backgroundColor: string
  /**
   * Axis line and text color / 轴线与文字颜色。
   */
  strokeColor: string
  /**
   * Chart width in px; lets the title logo land on-canvas in jsdom /
   * 图表宽度（像素），让标题 logo 在 jsdom 中也能落在画布内。
   */
  chartWidth?: number
  /**
   * Log-scale the y axis with symlog / 使用 symlog 对数化 y 轴。
   */
  useLogScale?: boolean
  /**
   * Legend placement / 图例位置。
   */
  legendPosition?: LegendPosition
}

/**
 * Default options for the light theme (or any theme when unspecified).
 *
 * 浅色主题（或未指定主题时）的默认选项。
 *
 * @param transparent - Whether to use a transparent background /
 *   是否使用透明背景
 * @returns The default options / 默认选项
 */
const getDefaultOptions = (transparent: boolean): XYChartOptions => ({
  envType: 'node',
  xTickLabelType: 'Date',
  dateFormat: 'MMM DD, YYYY',
  xTickCount: 5,
  yTickCount: 5,
  showLine: true,
  dotSize: 0.5,
  dataColors: colors,
  fontFamily: 'xkcd',
  backgroundColor: transparent ? 'transparent' : 'white',
  strokeColor: 'black',
  legendPosition: 'top-left',
})

/**
 * Default options for the dark theme.
 *
 * 深色主题的默认选项。
 *
 * @param transparent - Whether to use a transparent background /
 *   是否使用透明背景
 * @returns The default options with the dark palette and background /
 *   使用深色调色板与背景的默认选项
 */
const getDarkThemeDefaultOptions = (transparent: boolean): XYChartOptions => ({
  ...getDefaultOptions(transparent),
  dataColors: darkColors,
  backgroundColor: transparent ? 'transparent' : '#0d1117',
  strokeColor: 'white',
})

/**
 * Renders an xkcd-style line chart into the given SVG element.
 *
 * 将 xkcd 风格的折线图渲染到给定的 SVG 元素中。
 *
 * @param svg - Target SVG element; existing content is cleared /
 *   目标 SVG 元素，已存在的内容会被清空
 * @param param1 - Chart-level config, destructured by the function /
 *   图表级配置，由函数解构
 * @param initialOptions - Partial options merged over the theme defaults /
 *   部分选项，会在主题默认值之上合并
 * @example
 * XYChart(svg, { title: 'owner/repo', xLabel: 'Date', yLabel: 'Stars',
 *   data, showDots: true, transparent: false, theme: 'light' },
 *   { envType: 'node', chartWidth: 960 })
 */
export function XYChart(
  svg: SVGSVGElement,
  { title, xLabel, yLabel, data: { datasets }, showDots, theme, transparent }: XYChartConfig,
  initialOptions: Partial<XYChartOptions>,
): void {
  const options: XYChartOptions = {
    ...(theme === 'dark'
      ? getDarkThemeDefaultOptions(transparent)
      : getDefaultOptions(transparent)),
    ...initialOptions,
  }

  const m = { ...margin }
  if (title) {
    m.top = 60
  }
  if (xLabel) {
    m.bottom = 50
  }
  if (yLabel) {
    m.left = 70
  }

  const data = {
    datasets,
  }

  const filter = 'url(#xkcdify)'
  const fontFamily = options.fontFamily || 'xkcd'
  const clientWidth = Number(svg.clientWidth ?? svg.getAttribute('width') ?? '') || 600
  const clientHeight = (clientWidth * 2) / 3

  const d3Selection = select(svg)
    .style('stroke-width', 3)
    .style('font-family', fontFamily)
    .style('background', options.backgroundColor)
    .attr('width', clientWidth)
    .attr('height', clientHeight)
    .attr('preserveAspectRatio', 'xMidYMid meet') as D3Selection

  if (options.envType === 'browser') {
    // If in browser, be more responsive.
    d3Selection
      .attr('width', clientWidth <= 600 ? 600 : '100%')
      .attr('viewBox', `0 0 ${clientWidth <= 600 ? 600 : clientWidth} ${clientHeight}`)
  }
  d3Selection.selectAll('*').remove()

  addFont(d3Selection)
  addFilter(d3Selection)

  // Add animation styles for moltbot lobster emoji (browser only, skip for image generation)
  if (options.envType === 'browser') {
    d3Selection.append('style').text(`
            @keyframes lobster-swim {
                0%, 100% { transform: translate(0, 0) rotate(0deg); }
                25% { transform: translate(2px, -3px) rotate(-5deg); }
                50% { transform: translate(0, -5px) rotate(0deg); }
                75% { transform: translate(-2px, -3px) rotate(5deg); }
            }
            .moltbot-emoji {
                animation: lobster-swim 1.5s ease-in-out infinite;
                transform-origin: center;
                transform-box: fill-box;
            }
        `)
  }

  const chart = d3Selection.append('g').attr('transform', `translate(${m.left},${m.top})`)

  const tooltip = new ToolTip({
    selection: d3Selection,
    title: '',
    items: [],
    position: { x: 60, y: 60, type: 'up_left' },
    strokeColor: options.strokeColor,
    backgroundColor: options.backgroundColor,
  })

  if (options.xTickLabelType === 'Date') {
    data.datasets.forEach((dataset) => {
      dataset.data.forEach((d) => {
        d.x = dayjs(d.x) as any
      })
    })
  }

  const allData: XYPoint[] = []
  data.datasets.map((d) => allData.push(...d.data))

  const allXData = allData.map((d) => d.x)
  const allYData = allData.map((d) => d.y)

  const chartWidth = clientWidth - margin.left - margin.right
  const chartHeight = clientHeight - margin.top - margin.bottom

  // NOTE: Xaxis with date type(default)
  let xScale: AxisScale<number | Date> = scaleTime()
    .domain([
      Math.min(...allXData.map((d) => Number(d))),
      Math.max(...allXData.map((d) => Number(d))),
    ])
    .range([0, chartWidth])

  if (options.xTickLabelType === 'Number') {
    xScale = scaleLinear()
      .domain([0, Math.max(...allXData.map((d) => Number(d)))])
      .range([0, chartWidth])
  }

  let yScale: AxisScale<number>
  if (options.useLogScale) {
    // Use scaleSymlog which naturally handles zero and negative values
    // It transitions smoothly between linear (near zero) and logarithmic (far from zero)
    const maxYData = Math.max(...allYData)

    yScale = scaleSymlog()
      .domain([0, maxYData]) // Always start from 0 to show true starting point
      .range([chartHeight, 0])
      .constant(10) // Higher constant for smoother log transition
  } else {
    yScale = scaleLinear()
      .domain([0, Math.max(...allYData)]) // Always start from 0 for linear scale
      .range([chartHeight, 0])
  }

  const svgChart = chart.append('g').attr('pointer-events', 'all')

  // drawWatermark(svgChart, chartWidth, chartHeight)

  if (title) {
    if (uniq(datasets.map((d) => d.label.split('/')[0])).length === 1) {
      drawTitle(d3Selection, title, datasets[0]!.logo, options.strokeColor, options.chartWidth)
    } else {
      drawTitle(d3Selection, title, '', options.strokeColor, options.chartWidth)
    }
  }
  if (xLabel) {
    drawXLabel(d3Selection, xLabel, options.strokeColor)
  }
  if (yLabel) {
    const maxYData = Math.max(...allYData)
    let offsetY = 24
    if (maxYData > 100000) {
      offsetY = 2
    } else if (maxYData > 10000) {
      offsetY = 8
    } else if (maxYData > 1000) {
      offsetY = 12
    } else if (maxYData > 100) {
      offsetY = 20
    }
    drawYLabel(d3Selection, yLabel, options.strokeColor, offsetY)
  }

  // draw axis
  drawXAxis(svgChart, {
    xScale,
    tickCount: options.xTickCount,
    moveDown: chartHeight,
    fontFamily,
    stroke: options.strokeColor,
    type: options.xTickLabelType,
  })
  drawYAxis(svgChart, {
    yScale,
    tickCount: options.yTickCount,
    fontFamily,
    stroke: options.strokeColor,
    useLogScale: options.useLogScale!,
  })

  // draw lines
  if (options.showLine) {
    const drawLine = line<XYPoint>()
      .x((d) => xScale(d.x) ?? 0)
      .y((d) => yScale(d.y) ?? 0)
      .curve(curveMonotoneX)

    svgChart
      .selectAll('.xkcd-chart-xyline')
      .data(data.datasets)
      .enter()
      .append('path')
      .attr('class', 'xkcd-chart-xyline')
      .attr('d', (d) => drawLine(d.data))
      .attr('fill', 'none')
      .attr('stroke', (_, i) => options.dataColors[i]!)
      .attr('filter', filter)
  }

  if (showDots) {
    // draw dots
    const dotInitSize = 3.5 * (options.dotSize ?? 1)
    const dotHoverSize = 6 * (options.dotSize ?? 1)
    svgChart
      .selectAll('.xkcd-chart-xycircle-group')
      .data(data.datasets)
      .enter()
      .append('g')
      .attr('class', 'xkcd-chart-xycircle-group')
      .attr('filter', filter)
      .attr('xy-group-index', (_, i) => i)
      .selectAll('.xkcd-chart-xycircle-circle')
      .data((dataset) => dataset.data)
      .enter()
      .append('circle')
      .attr('class', 'chart-tooltip-dot')
      .style('stroke', (_, i, nodes) => {
        const xyGroupIndex = Number(select(nodes[i]!.parentElement).attr('xy-group-index'))
        return options.dataColors[xyGroupIndex]!
      })
      .style('fill', (_, i, nodes) => {
        const xyGroupIndex = Number(select(nodes[i]!.parentElement).attr('xy-group-index'))
        return options.dataColors[xyGroupIndex]!
      })
      .attr('r', dotInitSize)
      .attr('cx', (d) => xScale(d.x) ?? 0)
      .attr('cy', (d) => yScale(d.y) ?? 0)
      .attr('pointer-events', 'all')
      .on('mouseover', (event, d) => {
        if (window === undefined) {
          return
        }
        const nodes = event.currentTarget.parentNode.childNodes ?? []
        const i = [...nodes].indexOf(event.target)
        const xyGroupIndex = Number(select(nodes[i].parentElement).attr('xy-group-index'))
        select(nodes[i]).attr('r', dotHoverSize)

        const tipX = (xScale(d.x) ?? 0) + m.left + 5
        const tipY = (yScale(d.y) ?? 0) + m.top + 5
        let tooltipPositionType: Position = 'down_right'
        if (tipX > chartWidth / 2 && tipY < chartHeight / 2) {
          tooltipPositionType = 'down_left'
        } else if (tipX > chartWidth / 2 && tipY > chartHeight / 2) {
          tooltipPositionType = 'up_left'
        } else if (tipX < chartWidth / 2 && tipY > chartHeight / 2) {
          tooltipPositionType = 'up_right'
        }

        let formattedTitle = dayjs(data.datasets[xyGroupIndex]!.data[i]!.x).format(
          options.dateFormat,
        )
        if (options.xTickLabelType === 'Number') {
          const type = getTimestampFormatUnit(
            Number(
              data.datasets[xyGroupIndex]!.data[1]!.x || data.datasets[xyGroupIndex]!.data[i]!.x,
            ),
          )
          formattedTitle = getFormatTimeline(Number(data.datasets[xyGroupIndex]!.data[i]!.x), type)
        }

        tooltip.update({
          title: formattedTitle,
          items: [
            {
              color: options.dataColors[xyGroupIndex]!,
              text: `${data.datasets[xyGroupIndex]!.label || ''}: ${d.y}`,
            },
          ],
          position: {
            x: tipX,
            y: tipY,
            type: tooltipPositionType,
          },
          selection: d3Selection,
          backgroundColor: options.backgroundColor,
          strokeColor: options.strokeColor,
        })

        tooltip.show()
      })
      .on('mouseout', (event) => {
        const nodes = event.currentTarget.parentNode.childNodes ?? []
        if (!nodes.length) {
          return
        }
        const i = [...nodes].indexOf(event.target)
        select(nodes[i]).attr('r', dotInitSize)
        tooltip.hide()
      })
  }

  // draw legend
  const legendItems = data.datasets.map((dataset, i) => ({
    color: options.dataColors[i] ?? '',
    text: dataset.label,
    logo: dataset.logo,
  }))

  drawLegend(svgChart, {
    items: legendItems,
    strokeColor: options.strokeColor,
    backgroundColor: options.backgroundColor,
    legendPosition: options.legendPosition ?? 'top-left',
    chartWidth,
    chartHeight,
  })
}
