import sharp from 'sharp'

/**
 * Target edge length (px) for logo images.
 *
 * 目标边缘长度（像素）的 logo 图片。
 */
export const AVATAR_SIZE = 128

/**
 * Optimizes an image buffer: scales it down to `AVATAR_SIZE` and compresses
 * it with quality loss (jpeg/webp/avif) or palette quantization (png) so the
 * base64-embedded logo stays small. SVG inputs and undecodable buffers are
 * returned untouched.
 *
 * 优化图像缓冲区：将图像缩放到 `AVATAR_SIZE`，并以有损方式压缩
 * （jpeg/webp/avif）或调色板量化（png），使 base64 内嵌的 logo 保持较小。
 * SVG 输入与无法解码的缓冲区原样返回。
 *
 * @param image - Image buffer to optimize / 要优化的图像缓冲区
 * @returns The optimized image buffer / 优化后的图像缓冲区
 * @example
 * ```ts
 * const optimized = await optimizeImage(buf)
 * ```
 */
export async function optimizeImage(image: Buffer): Promise<Uint8Array> {
  try {
    const img = sharp(image)
    const { format } = await img.metadata()

    if (!format || format === 'svg') {
      return image
    }

    const resized = img.resize({
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      fit: 'cover',
    })

    const out =
      format === 'jpeg'
        ? resized.jpeg({ quality: 70 })
        : format === 'png'
          ? resized.png({ palette: true, quality: 70 })
          : format === 'webp'
            ? resized.webp({ quality: 70 })
            : format === 'heif'
              ? // AVIF input decodes with `heif`; re-encode to avif to stay small.
                resized.avif({ quality: 70 })
              : resized
    return await out.toBuffer()
  } catch {
    return image
  }
}
