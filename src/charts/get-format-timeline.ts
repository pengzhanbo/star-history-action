import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration.js'
import relativeTime from 'dayjs/plugin/relativeTime.js'

dayjs.extend(duration)
dayjs.extend(relativeTime)

/**
 * Granularity for human-readable duration formatting.
 *
 * 人类可读时长格式化的粒度。
 */
export type DurationUnitType = 'day' | 'week' | 'month' | 'year'

/**
 * Chooses the granularity that best fits the given duration.
 *
 * 为给定的时长选择最合适的粒度。
 *
 * @param timestamp - Duration in milliseconds / 时长（毫秒）
 * @returns `year`, `month`, `week`, or `day` / `year`、`month`、`week` 或 `day`
 */
export function getTimestampFormatUnit(timestamp: number): DurationUnitType {
  let timelineUnit: DurationUnitType = 'day'
  if (dayjs.duration(timestamp).asYears() > 1) {
    timelineUnit = 'year'
  } else if (dayjs.duration(timestamp).asMonths() > 1) {
    timelineUnit = 'month'
  } else if (dayjs.duration(timestamp).asWeeks() > 1) {
    timelineUnit = 'week'
  }
  return timelineUnit
}

/**
 * Formats a duration as a human-readable phrase.
 *
 * 将时长格式化为人类可读的短语。
 *
 * @param timestamp - Duration in milliseconds / 时长（毫秒）
 * @param type - Granularity; defaults to `day` / 粒度，默认为 `day`
 * @returns `'day one'` for zero, otherwise phrases like `'a month'` or `'12 days'` /
 *   时长为 0 时返回 `'day one'`，否则返回如 `'a month'`、`'12 days'` 这样的短语
 * @example
 * getFormatTimeline(0) // 'day one'
 * getFormatTimeline(31 * 86400_000, 'month') // 'a month'
 */
export function getFormatTimeline(timestamp: number, type: DurationUnitType = 'day'): string {
  if (timestamp === 0) {
    return 'day one'
  }

  const seconds = Math.floor(timestamp / 1000)
  const days = Math.floor(seconds / 60 / 60 / 24)
  const weeks = Math.floor(days / 7)
  const months = (days / 30).toFixed(0)
  const years = (days / 365).toFixed(0)

  if (type === 'day') {
    if (days === 1) {
      return 'a day'
    }
    return `${days} days`
  } else if (type === 'week') {
    if (weeks === 1) {
      return 'a week'
    }
    return `${weeks} weeks`
  } else if (type === 'month') {
    if (Number(months) === 1) {
      return 'a month'
    }
    return `${months} months`
  } else {
    if (Number(years) === 1) {
      return 'a year'
    }
    return `${years} years`
  }
}
