import type { D3Selection } from './types.js'
import { xkcdFontUrl } from '../common/fonts.js'

/**
 * Injects the `'xkcd'` @font-face into the SVG's defs.
 *
 * 向 SVG 的 defs 中注入 `'xkcd'` @font-face。
 *
 * @param selection - Root selection to append the `<defs>` into /
 *   要追加 `<defs>` 的根 selection
 */
export function addFont(selection: D3Selection): void {
  selection.append('defs').append('style').attr('type', 'text/css').text(`@font-face {
      font-family: "xkcd";
      src: url(${xkcdFontUrl}) format('woff');
    }`)
}
