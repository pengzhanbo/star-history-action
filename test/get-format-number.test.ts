import { describe, expect, it } from 'vitest'
import { getFormatNumber, getNumberFormatUnit } from '../src/charts/get-format-number.js'

describe('getNumberFormatUnit', () => {
  it('uses unit 1 below 300', () => {
    expect(getNumberFormatUnit(0)).toBe(1)
    expect(getNumberFormatUnit(1)).toBe(1)
    expect(getNumberFormatUnit(299)).toBe(1)
  })

  it('uses unit 1000 from 300 up to 1M', () => {
    expect(getNumberFormatUnit(300)).toBe(1000)
    expect(getNumberFormatUnit(999)).toBe(1000)
    expect(getNumberFormatUnit(999999)).toBe(1000)
  })

  it('uses unit 1000000 from 1M up', () => {
    expect(getNumberFormatUnit(1000000)).toBe(1000000)
    expect(getNumberFormatUnit(12345678)).toBe(1000000)
  })
})

describe('getFormatNumber', () => {
  it('renders plain integers with unit 1', () => {
    expect(getFormatNumber(0, 1)).toBe('0')
    expect(getFormatNumber(42, 1)).toBe('42')
  })

  it('defaults to unit 1', () => {
    expect(getFormatNumber(7)).toBe('7')
  })

  it('compacts thousands with K', () => {
    expect(getFormatNumber(3000, 1000)).toBe('3K')
    expect(getFormatNumber(12500, 1000)).toBe('12.5K')
  })

  it('compacts millions with M', () => {
    expect(getFormatNumber(2000000, 1000000)).toBe('2M')
    expect(getFormatNumber(3500000, 1000000)).toBe('3.5M')
  })

  it('keeps one decimal for non-exact compactions', () => {
    expect(getFormatNumber(1500, 1000000)).toBe('0.0M')
    expect(getFormatNumber(1234, 1000)).toBe('1.2K')
  })
})
