import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

/**
 * Extracts the CSS background color from a generated SVG (`style="background:…"`),
 * so the rasterizer can paint the same backdrop as the browser would.
 *
 * 从生成的 SVG 中提取 CSS 背景色（`style="background:…"`），使栅格化输出与
 * 浏览器渲染的底色一致。
 *
 * @param svg - Serialized chart SVG / 序列化的图表 SVG
 * @returns The background color, or undefined for transparent / 背景色；透明时返回 undefined
 */
function svgBackground(svg: string): string | undefined {
  const match = /background:([^;"']+)/.exec(svg)
  const bg = match?.[1]?.trim()
  return bg && bg !== 'transparent' ? bg : undefined
}

/**
 * Rasterizes a chart SVG to PNG via resvg, then re-encodes the result through
 * sharp's palette quantization.
 *
 * 通过 resvg 将图表 SVG 栅格化为 PNG，再经 sharp 调色板量化二次编码。
 *
 * Unlike librsvg (sharp's engine), resvg loads the xkcd font explicitly from
 * `assets/xkcd.ttf`, so the PNG text style matches the SVG instead of falling
 * back to a system font. The font path resolves from the action repo root —
 * the composite action runs with `working-directory: ${{ github.action_path }}`
 * and both local and e2e runs use the repo root, mirroring `font-subset.ts`.
 *
 * 与 librsvg（sharp 的底层引擎）不同，resvg 显式从 `assets/xkcd.ttf` 加载
 * xkcd 字体，因此 PNG 的文字样式与 SVG 一致，而不会回退到系统字体。字体
 * 路径基于 action 仓库根解析——composite action 以
 * `working-directory: ${{ github.action_path }}` 运行，本地与 e2e 同样在
 * 仓库根运行，与 `font-subset.ts` 一致。
 *
 * Chart color palettes stay far below 256 entries (background, grid, a few
 * lines, and antialiased text), so `palette: true` maps every pixel to the
 * palette losslessly while shrinking the file ~65% — pixel-identical output.
 * If a chart ever exceeds 256 colors the quantization becomes slightly lossy
 * instead of failing.
 *
 * 图表调色板远少于 256 种颜色（背景、网格、少数折线以及抗锯齿文字），因此
 * `palette: true` 可无损地将每个像素映射到调色板，同时将文件体积缩减约 65%，
 * 输出与原始渲染逐像素一致。若未来图表颜色超过 256 种，量化将退化为轻微
 * 有损，而不会报错。
 *
 * @param svg - Chart SVG string / 图表 SVG 字符串
 * @param width - Output width in px; height follows the SVG aspect ratio /
 *   输出宽度（像素）；高度按 SVG 宽高比缩放
 * @returns PNG bytes / PNG 字节
 */
export async function rasterizeSvg(svg: string, width: number): Promise<Buffer> {
  const background = svgBackground(svg)
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontFiles: [resolve('assets/xkcd.ttf')],
      loadSystemFonts: false,
      defaultFontFamily: 'xkcd',
    },
    ...(background ? { background } : {}),
  })
  return sharp(resvg.render().asPng()).png({ compressionLevel: 9, palette: true }).toBuffer()
}
