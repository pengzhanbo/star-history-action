import imagemin from 'imagemin'
import jpg from 'imagemin-jpegtran'
import png from 'imagemin-pngquant'

/**
 * Optimizes an image buffer using imagemin.
 *
 * 使用 imagemin 优化图像缓冲区。
 *
 * @param image - Image buffer to optimize / 要优化的图像缓冲区
 * @returns The optimized image buffer / 优化后的图像缓冲区
 * @example
 * ```ts
 * const optimized = await optimizeImage(buf)
 * ```
 */
export function optimizeImage(image: Buffer): Promise<Uint8Array> {
  return imagemin.buffer(image, {
    plugins: [jpg(), png({ quality: [0.6, 0.8] })],
  })
}
