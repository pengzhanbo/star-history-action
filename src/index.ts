import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { info, setFailed } from '@actions/core'
import { getChartFilePaths, parseInputs } from './config.js'
import { GITHUB_WORKSPACE } from './env.js'
import { commitAndPush } from './git.js'
import { renderStarHistorySvg } from './render.js'
import { getRepoLogo, getRepoStarRecords } from './services/api.js'
import { DEFAULT_MAX_REQUEST_AMOUNT } from './services/covert.js'

/**
 * Runs the full action pipeline: parse → fetch → render → write → commit/push.
 *
 * 运行动作的完整流水线：解析 → 抓取 → 渲染 → 写入 → 提交/推送。
 *
 * @throws {Error} When any pipeline step fails / 当流水线任一步骤失败时抛出
 * @example
 * // Entry of the composite action; failures are reported via setFailed.
 * void main()
 */
async function run(): Promise<void> {
  const config = parseInputs()

  // The runner always exports GITHUB_WORKSPACE; failing fast here (instead of
  // falling back to cwd) keeps the chart from landing in an unexpected spot.
  if (!GITHUB_WORKSPACE) {
    throw new Error('GITHUB_WORKSPACE is not set: the action must run on a GitHub runner')
  }
  const workspace = GITHUB_WORKSPACE
  const outDir = resolve(workspace, config.outputDirectory)
  const isInsideWorkspace = outDir === workspace || outDir.startsWith(`${workspace}${sep}`)
  if (!isAbsolute(outDir) || !isInsideWorkspace) {
    throw new Error('output-directory must point inside the workspace')
  }

  const records = await getRepoStarRecords(config.repo, config.token, DEFAULT_MAX_REQUEST_AMOUNT)
  const logo = await getRepoLogo(config.repo, config.token)

  await mkdir(outDir, { recursive: true })

  const chartFiles = getChartFilePaths(config)
  for (const { theme, file } of chartFiles) {
    const svg = renderStarHistorySvg({
      repo: config.repo,
      logo,
      records,
      theme,
      width: config.svgWidth,
    })
    const filePath = join(outDir, file)
    await writeFile(filePath, svg, 'utf8')
    info(`wrote ${relative(workspace, filePath)}`)
  }

  const chartPaths = chartFiles.map(({ file }) => relative(workspace, join(outDir, file)))
  commitAndPush({ cwd: workspace, files: chartPaths, token: config.token })
  info('done')
}

async function main(): Promise<void> {
  try {
    await run()
  } catch (error) {
    // setFailed logs the message and marks the run failed (exit code 1).
    setFailed(error instanceof Error ? error.message : String(error))
  }
}

void main()
