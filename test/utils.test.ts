import { describe, expect, it } from 'vitest'
import { formatDate } from '../src/utils.js'

describe('formatDate', () => {
  it('formats an epoch timestamp as YYYY-MM-DD in UTC', () => {
    // 2024-01-05T00:00:00Z
    expect(formatDate(Date.UTC(2024, 0, 5))).toBe('2024-01-05')
  })

  it('always uses UTC, not the local timezone', () => {
    // 2024-06-01T23:30:00Z is 2024-06-02 in UTC+8 — the UTC date must win.
    expect(formatDate(Date.UTC(2024, 5, 1, 23, 30))).toBe('2024-06-01')
  })

  it('pads month and day to two digits', () => {
    expect(formatDate(Date.UTC(2024, 2, 7))).toBe('2024-03-07')
  })
})
