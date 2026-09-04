import type { D3Selection } from './types.js'

/**
 * Injects the `xkcdify` wobble filter (feTurbulence + feDisplacementMap).
 *
 * Must run before any element references `url(#xkcdify)`.
 *
 * 注入 `xkcdify` 抖动滤镜（feTurbulence + feDisplacementMap）。
 *
 * 必须早于任何引用 `url(#xkcdify)` 的元素执行。
 *
 * @param selection - Root selection to append the `<filter>` into /
 *   要追加 `<filter>` 的根 selection
 */
export function addFilter(selection: D3Selection): void {
  selection
    .append('filter')
    .attr('id', 'xkcdify')
    .attr('filterUnits', 'userSpaceOnUse')
    .attr('x', -5)
    .attr('y', -5)
    .attr('width', '100%')
    .attr('height', '100%')
    .call((f) => {
      f.append('feTurbulence')
        .attr('type', 'fractalNoise')
        .attr('baseFrequency', '0.05')
        .attr('result', 'noise')
      f.append('feDisplacementMap')
        .attr('scale', '5')
        .attr('xChannelSelector', 'R')
        .attr('yChannelSelector', 'G')
        .attr('in', 'SourceGraphic')
        .attr('in2', 'noise')
    })
}
