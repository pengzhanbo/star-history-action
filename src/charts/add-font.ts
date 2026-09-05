import type { D3Selection } from './types.js'
import { getXkcdFontUrl } from '../common/font-subset.js'

/**
 * Injects the `'xkcd'` @font-face into the SVG's defs.
 *
 * 向 SVG 的 defs 中注入 `'xkcd'` @font-face。
 *
 * 字体数据在运行时从 `assets/xkcd.ttf` 读取，因此该函数仅适用于
 * Node 渲染环境（action 与图片生成场景）。
 *
 * @param selection - Root selection to append the `<defs>` into /
 *   要追加 `<defs>` 的根 selection
 */
export function addFont(selection: D3Selection): void {
  selection.append('defs').append('style').attr('type', 'text/css').text(`@font-face {
      font-family: "xkcd";
      src: url(${getXkcdFontUrl()}) format('truetype');
    }`)
}
