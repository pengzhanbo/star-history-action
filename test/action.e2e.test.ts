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
function runAction(): Promise<{ status: number | null; stdout: string; stderr: string }> {
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
    if (url.pathname === '/repos/owner/repo') {
      res.end(JSON.stringify({ stargazers_count: 260, created_at }))
      return
    }
    if (url.pathname === '/repos/owner/repo/stargazers') {
      const page = Number(url.searchParams.get('page') ?? '1')
      if (page === 1) {
        // GitHub-style Link header advertising the last page.
        const base = `${serverUrl}/repos/owner/repo/stargazers?per_page=100`
        res.setHeader(
          'link',
          `<${base}&page=2&per_page=100>; rel="next", <${base}&page=3&per_page=100>; rel="last"`,
        )
      }
      res.end(JSON.stringify((starsByPage[page] ?? []).map((starred_at) => ({ starred_at }))))
      return
    }
    if (url.pathname === '/users/owner') {
      res.end(JSON.stringify({ avatar_url: `${serverUrl}/users/owner/avatar.png` }))
      return
    }
    if (url.pathname === '/users/owner/avatar.png') {
      // The action base64-encodes the avatar as an inline <img>; it only
      // checks status + content-type, so the bytes themselves are irrelevant.
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from('fake-png-bytes'))
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
      expect(svg.match(/class="chart-tooltip-dot"/g)).toHaveLength(4)
      expect(svg).toContain('owner/repo')
    }
    // jsdom (cssstyle) serializes the dark hex background as rgb()
    expect(readFileSync(darkPath, 'utf8')).toContain('rgb(13, 17, 23)')

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
})
