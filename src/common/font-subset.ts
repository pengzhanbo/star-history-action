import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import subsetFont from 'subset-font'

// 惰性读取一次 assets/xkcd.ttf，避免每次子集化都重复磁盘 IO。
// cwd 始终指向 action 仓库根：composite action 显式以
// `working-directory: ${{ github.action_path }}` 执行，本地与 e2e 也在
// 仓库根运行，因此相对路径是可靠的。
let ttfBuffer: Buffer | undefined

function getTtfBuffer(): Buffer {
  ttfBuffer ??= readFileSync(resolve('assets/xkcd.ttf'))
  return ttfBuffer
}

// 完整 ttf 的 data URL 缓存：渲染期兜底与 addFont/radar 会多处注入，
// 只需要编码一次
let fontDataUrl: string | undefined

/**
 * Returns the full xkcd TrueType font as a data URL, read from
 * `assets/xkcd.ttf` at runtime.
 *
 * 返回完整的 xkcd TrueType 字体 data URL，运行时从 `assets/xkcd.ttf`
 * 读取。用于渲染期兜底以及未内联子集字体时仍可显示完整字体。
 *
 * @returns A fonts/ttf data URL / fonts/ttf data URL
 */
export function getXkcdFontUrl(): string {
  fontDataUrl ??= `data:font/ttf;charset=utf-8;base64,${getTtfBuffer().toString('base64')}`
  return fontDataUrl
}

// text → woff2 data URL 缓存：light/dark 两主题文本一致，只需子集化一次
const urlCache = new Map<string, Promise<string>>()

/**
 * Subsets the xkcd font to only the glyphs needed to render `text`, returning
 * a woff2 data URL ready to be inlined into the SVG.
 *
 * 将 xkcd 字体按 `text` 中实际出现的字符做子集化，
 * 返回可直接内联进 SVG 的 woff2 data URL。
 *
 * @param text - All text rendered in the SVG / SVG 中渲染的全部文本
 * @returns A woff2 data URL / woff2 data URL
 */
export function getSubsetFontUrl(text: string): Promise<string> {
  // 空文本兜底空格：子集化工具对空字符集会报错，且刻度大都与空白排版相关
  const key = text || ' '
  let pending = urlCache.get(key)
  if (!pending) {
    pending = subsetFont(getTtfBuffer(), key, { targetFormat: 'woff2' }).then(
      (buf) => `data:font/woff2;charset=utf-8;base64,${buf.toString('base64')}`,
    )
    urlCache.set(key, pending)
  }
  return pending
}
