import { describe, expect, it } from 'vitest'
import { getFormatTimeline, getTimestampFormatUnit } from '../src/charts/get-format-timeline.js'

describe('getTimestampFormatUnit', () => {
  it('returns day for durations under a week', () => {
    expect(getTimestampFormatUnit(0)).toBe('day')
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24)).toBe('day')
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 6)).toBe('day')
  })

  it('returns week for durations over a week but under a month', () => {
    // exactly 7 days is asWeeks() === 1, which is not > 1 — one more day flips the unit
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 7)).toBe('day')
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 8)).toBe('week')
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 20)).toBe('week')
  })

  it('returns month for durations over a month but under a year', () => {
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 32)).toBe('month')
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 300)).toBe('month')
  })

  it('returns year for durations over a year', () => {
    expect(getTimestampFormatUnit(1000 * 60 * 60 * 24 * 366)).toBe('year')
  })
})

describe('getFormatTimeline', () => {
  it('formats zero as "day one"', () => {
    expect(getFormatTimeline(0)).toBe('day one')
    expect(getFormatTimeline(0, 'year')).toBe('day one')
  })

  it('formats singular day as "a day"', () => {
    const oneDay = 24 * 60 * 60 * 1000
    expect(getFormatTimeline(oneDay, 'day')).toBe('a day')
  })

  it('formats plural days', () => {
    expect(getFormatTimeline(5 * 24 * 60 * 60 * 1000, 'day')).toBe('5 days')
  })

  it('formats weeks', () => {
    expect(getFormatTimeline(7 * 24 * 60 * 60 * 1000, 'week')).toBe('a week')
    expect(getFormatTimeline(3 * 7 * 24 * 60 * 60 * 1000, 'week')).toBe('3 weeks')
  })

  it('formats months on a 30-day basis', () => {
    expect(getFormatTimeline(30 * 24 * 60 * 60 * 1000, 'month')).toBe('a month')
    expect(getFormatTimeline(90 * 24 * 60 * 60 * 1000, 'month')).toBe('3 months')
  })

  it('formats years on a 365-day basis', () => {
    expect(getFormatTimeline(365 * 24 * 60 * 60 * 1000, 'year')).toBe('a year')
    expect(getFormatTimeline(730 * 24 * 60 * 60 * 1000, 'year')).toBe('2 years')
  })
})
