import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Hermetic end-to-end run of the built action (dist/index.js): a local HTTP
// server stands in for the GitHub API, and a scratch git repo with a bare
// origin stands in for the runner workspace.
const projectRoot = join(import.meta.dirname, '..')
const distEntry = join(projectRoot, 'dist/index.js')

const created_at = '2024-01-01T00:00:00Z'
const starsByPage: Record<number, string[]> = {
  1: Array.from({ length: 100 }, () => '2024-03-01T00:00:00Z'),
  2: Array.from({ length: 100 }, () => '2024-06-01T00:00:00Z'),
  3: Array.from({ length: 60 }, () => '2024-09-01T00:00:00Z'),
}

// Mock repo catalog; the multi-repo e2e case charts owner/repo + other/repo.
// 模拟仓库目录；多仓库 e2e 用例对比 owner/repo 与 other/repo。
const repoData: Record<
  string,
  { stargazers_count: number; created_at: string; pages: Record<number, string[]> }
> = {
  'owner/repo': { stargazers_count: 260, created_at, pages: starsByPage },
  'other/repo': {
    stargazers_count: 60,
    created_at: '2024-02-01T00:00:00Z',
    pages: { 1: Array.from({ length: 60 }, () => '2024-04-01T00:00:00Z') },
  },
}

let server: http.Server
let serverUrl = ''

let scratchRoot: string
let workspace: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// The e2e suite exercises the committed build artifact; rebuild when any
// source file is newer than dist/index.js so a stale dist cannot fail it.
async function isDistStale(): Promise<boolean> {
  if (!existsSync(distEntry)) {
    return true
  }
  const distMtime = (await stat(distEntry)).mtimeMs
  const sources: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else {
        sources.push(path)
      }
    }
  }
  await walk(join(projectRoot, 'src'))
  for (const file of sources) {
    if ((await stat(file)).mtimeMs > distMtime) {
      return true
    }
  }
  return false
}

// The action child must be spawned asynchronously: spawnSync would block this
// process's event loop, starving the in-process mock HTTP server and making
// the action's fetches time out.
function runAction(env: Record<string, string> = {}): Promise<{
  status: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [distEntry], {
      env: {
        ...process.env,
        GITHUB_API_URL: serverUrl,
        GITHUB_WORKSPACE: workspace,
        INPUT_REPO: 'owner/repo',
        INPUT_TOKEN: 'e2e-token',
        INPUT_THEME: 'light,dark',
        // Local push mode: empty GITHUB_REPOSITORY pushes to the origin remote.
        GITHUB_REPOSITORY: '',
        GITHUB_HEAD_REF: '',
        GITHUB_REF_NAME: '',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function expectSuccess(output: { status: number | null; stdout: string; stderr: string }): void {
  expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', serverUrl)
    res.setHeader('content-type', 'application/json')

    const stargazersMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/stargazers$/)
    if (stargazersMatch) {
      const key = `${stargazersMatch[1]}/${stargazersMatch[2]}`
      const data = repoData[key]
      if (data) {
        const page = Number(url.searchParams.get('page') ?? '1')
        if (page === 1 && Object.keys(data.pages).length > 1) {
          // GitHub-style Link header advertising the last page.
          const base = `${serverUrl}${url.pathname}?per_page=100`
          const last = Object.keys(data.pages).length
          const links = [`<${base}&page=2&per_page=100>; rel="next"`]
          if (last > 2) {
            links.push(`<${base}&page=${last}&per_page=100>; rel="last"`)
          }
          res.setHeader('link', links.join(', '))
        }
        res.end(JSON.stringify((data.pages[page] ?? []).map((starred_at) => ({ starred_at }))))
        return
      }
      res.statusCode = 404
      res.end('{}')
      return
    }

    const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/)
    if (repoMatch) {
      const data = repoData[`${repoMatch[1]}/${repoMatch[2]}`]
      if (data) {
        res.end(
          JSON.stringify({ stargazers_count: data.stargazers_count, created_at: data.created_at }),
        )
        return
      }
      res.statusCode = 404
      res.end('{}')
      return
    }

    // Radar chart metrics: paginated list endpoints advertise their size via the
    // Link header; the search endpoint reports a total_count.
    const listMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(contributors|commits)$/)
    if (listMatch) {
      // ~300 contributors, ~200 pushes: last page * per_page (100).
      const last = listMatch[3] === 'contributors' ? 3 : 2
      res.setHeader('link', `<${serverUrl}${url.pathname}?page=${last}&per_page=1>; rel="last"`)
      res.end('[]')
      return
    }
    if (url.pathname === '/search/issues') {
      res.end(JSON.stringify({ total_count: 120 }))
      return
    }

    const userMatch = url.pathname.match(/^\/users\/([^/]+)$/)
    if (userMatch) {
      res.end(JSON.stringify({ avatar_url: `${serverUrl}${url.pathname}/avatar.png` }))
      return
    }
    if (url.pathname.match(/^\/users\/[^/]+\/avatar\.png$/)) {
      // The action base64-encodes the avatar as an inline <img>; a real 1x1
      // PNG lets sharp resize/encode it during optimization.
      res.setHeader('content-type', 'image/png')
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      )
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  if (await isDistStale()) {
    execFileSync('pnpm', ['build'], { cwd: projectRoot, stdio: 'inherit' })
  }

  scratchRoot = await mkdtemp(join(tmpdir(), 'star-history-e2e-'))
  const bare = join(scratchRoot, 'origin.git')
  workspace = join(scratchRoot, 'workspace')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  git(scratchRoot, 'init', '-b', 'main', workspace)
  git(workspace, 'config', 'user.email', 'e2e@example.com')
  git(workspace, 'config', 'user.name', 'E2E')
  await writeFile(join(workspace, 'README.md'), '# e2e\n', 'utf8')
  git(workspace, 'add', 'README.md')
  git(workspace, 'commit', '-m', 'init')
  git(workspace, 'remote', 'add', 'origin', bare)
})

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('action end-to-end (mock GitHub API)', () => {
  it('writes one SVG per theme and commits/pushes as github-actions[bot]', async () => {
    const result = await runAction()
    expect(result.stderr).toBe('')
    expectSuccess(result)
    expect(result.stdout).toContain('wrote assets/star-history-light.svg')
    expect(result.stdout).toContain('wrote assets/star-history-dark.svg')

    const lightPath = join(workspace, 'assets/star-history-light.svg')
    const darkPath = join(workspace, 'assets/star-history-dark.svg')
    expect(existsSync(lightPath)).toBe(true)
    expect(existsSync(darkPath)).toBe(true)

    // 3 history dates + the today anchor = 4 chart points per SVG.
    for (const path of [lightPath, darkPath]) {
      const svg = readFileSync(path, 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).toContain('class="xkcd-chart-xyline"')
      // showDots is disabled, so no per-record dots are drawn
      expect(svg.match(/class="chart-tooltip-dot"/g)).toBeNull()
      expect(svg).toContain('owner/repo')
    }
    // jsdom (cssstyle) + svgo serialize the hex dark background as #0d1117
    expect(readFileSync(darkPath, 'utf8')).toContain('background:#0d1117')

    // Commit identity and message come from git.ts.
    expect(git(workspace, 'log', '-1', '--format=%an|%ae|%s').trim()).toBe(
      'github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com|chore: update star history chart',
    )
    expect(git(workspace, 'rev-list', '--count', 'HEAD').trim()).toBe('2')

    // The chart commit was pushed to the origin remote.
    const bareHead = git(join(scratchRoot, 'origin.git'), 'rev-parse', 'refs/heads/main').trim()
    expect(git(workspace, 'rev-parse', 'HEAD').trim()).toBe(bareHead)
  })

  it('is idempotent on rerun (no empty commit)', async () => {
    const before = git(workspace, 'rev-parse', 'HEAD').trim()

    const result = await runAction()
    expectSuccess(result)

    expect(git(workspace, 'rev-parse', 'HEAD').trim()).toBe(before)
    expect(git(workspace, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })

  it('renders a multi-repo comparison chart', async () => {
    const result = await runAction({
      INPUT_REPO: 'owner/repo, other/repo',
      INPUT_THEME: 'light',
    })
    expect(result.stderr).toBe('')
    expectSuccess(result)
    expect(result.stdout).toContain('wrote assets/star-history.svg')

    const svg = readFileSync(join(workspace, 'assets/star-history.svg'), 'utf8')
    // one line path per repo, and both labels appear in the legend
    expect(svg.match(/class="xkcd-chart-xyline"/g)).toHaveLength(2)
    expect(svg).toContain('owner/repo')
    expect(svg).toContain('other/repo')
    expect(svg).toContain('background:#fff')
  })

  it('writes a PNG alongside the SVG when output-format is both', async () => {
    const result = await runAction({
      'INPUT_THEME': 'light',
      // getInput('output-format') reads INPUT_OUTPUT-FORMAT (hyphen, like action.yaml).
      'INPUT_OUTPUT-FORMAT': 'both',
    })
    expectSuccess(result)
    expect(result.stdout).toContain('wrote assets/star-history.svg')
    expect(result.stdout).toContain('wrote assets/star-history.png')

    const png = readFileSync(join(workspace, 'assets/star-history.png'))
    // PNG magic bytes; proves sharp rasterized the chart rather than copying bytes.
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('writes a per-repo radar SVG when radar is enabled', async () => {
    const result = await runAction({
      INPUT_RADAR: 'true',
      INPUT_THEME: 'light',
    })
    expect(result.stderr).toBe('')
    expectSuccess(result)
    expect(result.stdout).toContain('wrote assets/star-history.svg')
    expect(result.stdout).toContain('wrote assets/star-history-radar.svg')

    const radar = readFileSync(join(workspace, 'assets/star-history-radar.svg'), 'utf8')
    expect(radar).toContain('<svg')
    expect(radar).toContain('font-family:xkcd,cursive')
    // all six axis labels are present
    for (const label of [
      'Stars',
      'New Stars',
      'Issues Closed',
      'Contributors',
      'Pushes',
      'Forks',
    ]) {
      expect(radar).toContain(`>${label}</text>`)
    }

    // The radar SVG is part of the chart commit.
    expect(git(workspace, 'log', '-1', '--format=%s').trim()).toBe(
      'chore: update star history chart',
    )
  })

  it('suffixes the repo into the radar file name for multi-repo runs', async () => {
    const result = await runAction({
      INPUT_RADAR: 'true',
      INPUT_REPO: 'owner/repo, other/repo',
      INPUT_THEME: 'light',
    })
    expect(result.stderr).toBe('')
    expectSuccess(result)
    expect(result.stdout).toContain('wrote assets/star-history-radar-owner-repo.svg')
    expect(result.stdout).toContain('wrote assets/star-history-radar-other-repo.svg')

    expect(existsSync(join(workspace, 'assets/star-history-radar-owner-repo.svg'))).toBe(true)
    expect(existsSync(join(workspace, 'assets/star-history-radar-other-repo.svg'))).toBe(true)
  })
})
