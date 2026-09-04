/**
 * Magnitude unit for compact number formatting.
 *
 * 紧凑数字格式化的量级单位。
 */
export type NumberUnitType = 1 | 1000 | 1000000

/**
 * Picks the smallest unit that keeps the number readable.
 *
 * 选择能让数字保持可读的最小量级单位。
 *
 * @param n - The number to format / 待格式化的数字
 * @returns `1000000` for ≥1e6, `1000` for ≥300, otherwise `1` /
 *   ≥1e6 时为 `1000000`，≥300 时为 `1000`，其余为 `1`
 */
export function getNumberFormatUnit(n: number): NumberUnitType {
  if (n >= 1000000) {
    return 1000000
  }
  if (n >= 300) {
    return 1000
  }

  return 1
}

/**
 * Formats a number compactly with K/M suffixes.
 *
 * 使用 K/M 后缀对数字进行紧凑格式化。
 *
 * @param n - The number to format / 待格式化的数字
 * @param type - Magnitude unit; defaults to `1` / 量级单位，默认为 `1`
 * @returns Compact string (e.g. `1.2K`, `3M`, `42`) /
 *   紧凑字符串（例如 `1.2K`、`3M`、`42`）
 * @example
 * getFormatNumber(1234, getNumberFormatUnit(1234)) // '1.2K'
 */
export function getFormatNumber(n: number, type: NumberUnitType = 1): string {
  if (type === 1) {
    return `${n}`
  }

  if (type === 1000000) {
    if (n >= 1000000 && n % 1000000 === 0) {
      return `${n / 1000000}M`
    }
    return `${(n / 1000000).toFixed(1)}M`
  }

  if (n >= 1000 && n % 1000 === 0) {
    return `${n / 1000}K`
  }
  return `${(n / 1000).toFixed(1)}K`
}
