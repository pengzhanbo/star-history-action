// Barrel for the XY-chart family: re-exports the chart itself and its shared
// types. The draw-*/add-* helpers are consumed via deep imports.
//
// XY-chart 系列的桶文件：再导出图表本体与共享类型。draw-*/add-* 辅助函数
// 通过深层导入使用，不在此导出。
export * from './xy-chart.js'
export type * from './types.js'
