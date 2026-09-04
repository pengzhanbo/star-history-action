import type { AxisScale } from 'd3-axis'
import type { NumberUnitType } from './get-format-number.js'
import type { DurationUnitType } from './get-format-timeline.js'
import type { D3Selection } from './types.js'
import { axisBottom, axisLeft } from 'd3-axis'
import { getFormatNumber, getNumberFormatUnit } from './get-format-number.js'
import { getFormatTimeline, getTimestampFormatUnit } from './get-format-timeline.js'

interface DrawXAxisConfig {
  xScale: AxisScale<number | Date>
  tickCount: number
  moveDown: number
  fontFamily: string
  stroke: string
  type: 'Date' | 'Number'
}

export function drawXAxis(
  selection: D3Selection,
  { xScale, tickCount, moveDown, fontFamily, stroke, type }: DrawXAxisConfig,
): void {
  const xAxisGenerator = axisBottom(xScale).tickSize(0).tickPadding(6).ticks(tickCount)

  if (type === 'Number') {
    let index = 1
    let unitType: DurationUnitType | undefined = undefined
    xAxisGenerator.tickFormat((d) => {
      const timestamp = Number(d)
      const tickAmount = selection.selectAll('.xaxis > .tick').nodes().length
      index++
      if (timestamp === 0 || (tickAmount >= 7 && index % 2 === 0)) {
        return ' '
      }
      unitType ??= getTimestampFormatUnit(timestamp)

      return getFormatTimeline(timestamp, unitType)
    })
  }

  selection
    .append('g')
    .attr('class', 'xaxis')
    .attr('transform', `translate(0,${moveDown})`)
    .call(xAxisGenerator)

  selection.selectAll('.domain').attr('filter', 'url(#xkcdify)').style('stroke', stroke)

  selection
    .selectAll('.xaxis > .tick > text')
    .style('font-family', fontFamily)
    .style('font-size', '16px')
    .style('fill', stroke)
}

interface DrawYAxisConfig {
  yScale: AxisScale<number>
  tickCount: number
  fontFamily: string
  stroke: string
  useLogScale?: boolean
}

export function drawYAxis(
  selection: D3Selection,
  { yScale, tickCount, fontFamily, stroke, useLogScale }: DrawYAxisConfig,
): void {
  let type: NumberUnitType | undefined = undefined
  const yAxisGenerator = axisLeft(yScale).tickSize(1).tickPadding(6)

  if (useLogScale) {
    // Smart logarithmic tick generation based on data range
    const domain = yScale.domain()
    const maxValue = Math.max(...domain)

    const logTicks: number[] = [0] // Always start with 0

    // Determine appropriate starting power based on range
    let startPower = 0
    if (maxValue >= 10000) {
      startPower = 2 // Start from 100 for very large ranges
    } else if (maxValue >= 100) {
      startPower = 1 // Start from 10 for medium ranges
    } else if (maxValue >= 10) {
      startPower = 1 // Start from 10 for small-medium ranges
    } else {
      // For very small ranges (< 10), use linear-like ticks
      if (maxValue <= 5) {
        logTicks.push(Math.ceil(maxValue))
      } else {
        logTicks.push(5, Math.ceil(maxValue))
      }

      yAxisGenerator.tickValues(logTicks).tickFormat((d) => {
        if (d === 0) {
          return '0'
        }
        return d.toString()
      })

      selection.append('g').attr('class', 'yaxis').call(yAxisGenerator)
      selection.selectAll('.domain').attr('filter', 'url(#xkcdify)').style('stroke', stroke)
      selection
        .selectAll('.yaxis > .tick > text')
        .style('font-family', fontFamily)
        .style('font-size', '16px')
        .style('fill', stroke)
      return
    }

    // Generate powers of 10 with smart spacing
    let power = startPower
    let count = 1 // Already have 0
    const maxTicks = 6 // Limit total ticks for readability

    while (10 ** power <= maxValue && count < maxTicks) {
      const tick = 10 ** power
      logTicks.push(tick)
      count++
      power++
    }

    // If we haven't reached maxValue and have room for one more tick, add it
    if (count < maxTicks && maxValue > logTicks[logTicks.length - 1]!) {
      const lastTick = logTicks[logTicks.length - 1]!
      // Add a tick that's closer to maxValue but still meaningful
      if (maxValue > lastTick * 2) {
        logTicks.push(10 ** Math.ceil(Math.log10(maxValue)))
      }
    }

    yAxisGenerator.tickValues(logTicks).tickFormat((d) => {
      if (d === 0) {
        return '0'
      }
      type ??= getNumberFormatUnit(d)
      return getFormatNumber(d, type)
    })
  } else {
    yAxisGenerator.ticks(tickCount, 's').tickFormat((d) => {
      if (d === 0) {
        return ' '
      }
      type ??= getNumberFormatUnit(d)
      return getFormatNumber(d, type)
    })
  }

  selection.append('g').attr('class', 'yaxis').call(yAxisGenerator)

  selection.selectAll('.domain').attr('filter', 'url(#xkcdify)').style('stroke', stroke)

  selection
    .selectAll('.yaxis > .tick > text')
    .style('font-family', fontFamily)
    .style('font-size', '16px')
    .style('fill', stroke)
}
