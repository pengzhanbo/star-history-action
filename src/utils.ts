import imagemin from 'imagemin'
import imageminJpegtran from 'imagemin-jpegtran'
import imageminPngquant from 'imagemin-pngquant'

/**
 * Formats an epoch timestamp as a UTC date string in `YYYY-MM-DD` form.
 *
 * 将毫秒级时间戳格式化为 `YYYY-MM-DD` 形式的 UTC 日期字符串。
 *
 * @param date - Epoch timestamp in milliseconds / 毫秒级时间戳
 * @returns The date in `YYYY-MM-DD` format / `YYYY-MM-DD` 格式的日期字符串
 * @example
 * formatDate(Date.parse('2024-01-05T00:00:00Z')) // '2024-01-05'
 */
export function formatDate(date: number): string {
  return new Date(date).toISOString().substring(0, 10)
}

/**
 * Optimizes an image buffer using imagemin.
 *
 * 使用 imagemin 优化图像缓冲区。
 *
 * @param image - Image buffer to optimize / 要优化的图像缓冲区
 * @returns The optimized image buffer / 优化后的图像缓冲区
 * @example
 * const optimized = await optimizeImage(buf)
 */
export function optimizeImage(image: Buffer): Promise<Uint8Array> {
  return imagemin.buffer(image, {
    plugins: [imageminJpegtran(), imageminPngquant({ quality: [0.6, 0.8] })],
  })
}
