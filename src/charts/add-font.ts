import type { D3Selection } from './types.js'
import { xkcdFontUrl } from '../common/fonts.js'

export function addFont(selection: D3Selection): void {
  selection.append('defs').append('style').attr('type', 'text/css').text(`@font-face {
      font-family: "xkcd";
      src: url(${xkcdFontUrl}) format('woff');
    }`)
}
