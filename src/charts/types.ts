import type { Selection } from 'd3-selection'

/**
 * Shared D3 selection type used by every draw-* / add-* helper.
 *
 * 所有 draw-* / add-* 辅助函数共用的 D3 selection 类型。
 */
export type D3Selection = Selection<SVGSVGElement | SVGGElement, unknown, null, undefined>

/**
 * Placement of the legend inside the chart.
 *
 * 图例在图表内的位置。
 */
export type LegendPosition = 'top-left' | 'bottom-right'
