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
