import type { XYChartConfig, XYChartData } from './charts/index.js'
import { JSDOM } from 'jsdom'
import { XYChart } from './charts/index.js'

export interface RenderChartInput {
  repo: string // 'owner/name' — used as dataset label AND chart title
  logo: string // avatar URL from getRepoLogo; '' means no title logo
  records: { date: string; stars: number }[] // ascending by date; shape from api.getRepoStarRecords
  theme: 'light' | 'dark'
  width: number // svg-width input
}

export function renderStarHistorySvg(input: RenderChartInput): string {
  // A fresh document per call avoids any cross-render residue; at most 2 calls per run.
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const { document } = dom.window

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  // jsdom serializes HTML-style (namespace implied); standalone consumers
  // (XML parsers, resvg) require an explicit xmlns.
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(input.width))
  // jsdom performs no layout, so clientWidth always reads 0. Pin the width the
  // way a browser's layout would, letting XYChart size to the svg-width input.
  Object.defineProperty(svg, 'clientWidth', { value: input.width })

  const data: XYChartData = {
    datasets: [
      {
        label: input.repo,
        logo: input.logo,
        data: input.records.map((record) => ({
          x: new Date(`${record.date}T00:00:00Z`),
          y: record.stars,
        })),
      },
    ],
  }

  const config: XYChartConfig = {
    title: input.repo,
    xLabel: 'Date',
    yLabel: 'Stars',
    data,
    showDots: true,
    transparent: false,
    theme: input.theme,
  }

  XYChart(svg, config, {
    envType: 'node',
    // jsdom reports a zero-width bounding rect; drawTitle falls back to this
    // width so a non-empty logo is placed on-canvas, not at negative x.
    chartWidth: input.width,
  })

  const output = svg.outerHTML
  dom.window.close()
  return output
}
