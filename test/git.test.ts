import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Local/dev branch of commitAndPush: GITHUB_REPOSITORY is empty, so the push
// goes to the `origin` remote instead of an authenticated runner URL.
let commitAndPush: (typeof import('../src/services/git.js'))['commitAndPush']

let scratchRoot: string
let workspace: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

beforeAll(async () => {
  vi.stubEnv('GITHUB_REPOSITORY', '')
  vi.stubEnv('GITHUB_HEAD_REF', '')
  vi.stubEnv('GITHUB_REF_NAME', '')
  vi.resetModules()
  ;({ commitAndPush } = await import('../src/services/git.js'))
})

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'star-history-git-'))
  const bare = join(scratchRoot, 'origin.git')
  workspace = join(scratchRoot, 'workspace')

  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  git(scratchRoot, 'init', '-b', 'main', workspace)
  git(workspace, 'config', 'user.email', 'setup@example.com')
  git(workspace, 'config', 'user.name', 'Setup')
  await writeFile(join(workspace, 'README.md'), '# scratch\n', 'utf8')
  git(workspace, 'add', 'README.md')
  git(workspace, 'commit', '-m', 'init')
  git(workspace, 'remote', 'add', 'origin', bare)
})

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('commitAndPush (local mode)', () => {
  it('commits chart changes as github-actions[bot] and pushes to origin', async () => {
    await mkdir(join(workspace, 'assets'), { recursive: true })
    await writeFile(join(workspace, 'assets/star-history.svg'), '<svg/>', 'utf8')

    commitAndPush({ cwd: workspace, files: ['assets/star-history.svg'], token: 't' })

    const last = git(workspace, 'log', '-1', '--format=%an|%ae|%s').trim()
    expect(last).toBe(
      'github-actions[bot]|41898282+github-actions[bot]@users.noreply.github.com|chore: update star history chart',
    )
    // the push landed on the origin remote
    expect(git(workspace, 'rev-parse', 'HEAD').trim()).toBe(
      execFileSync('git', ['-C', join(scratchRoot, 'origin.git'), 'rev-parse', 'refs/heads/main'], {
        encoding: 'utf8',
      }).trim(),
    )
  })

  it('is a no-op when nothing changed (idempotent reruns)', () => {
    commitAndPush({ cwd: workspace, files: ['README.md'], token: 't' })

    const countBefore = git(workspace, 'rev-list', '--count', 'HEAD').trim()
    expect(() => commitAndPush({ cwd: workspace, files: ['README.md'], token: 't' })).not.toThrow()
    expect(git(workspace, 'rev-list', '--count', 'HEAD').trim()).toBe(countBefore)
  })

  it('skips the write-back on pull_request events', async () => {
    // Forked PRs cannot be pushed to with the default token; the chart does
    // not belong on the feature branch, so commitAndPush must be a no-op.
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
    vi.resetModules()
    const pullRequestMode = (await import('../src/services/git.js')).commitAndPush
    await mkdir(join(workspace, 'assets'), { recursive: true })
    await writeFile(join(workspace, 'assets/star-history.svg'), '<svg/>', 'utf8')

    expect(() =>
      pullRequestMode({ cwd: workspace, files: ['assets/star-history.svg'], token: 't' }),
    ).not.toThrow()

    // No commit was created and the file is still untracked (git collapses a
    // fully untracked directory to `?? assets/` in --porcelain output).
    expect(git(workspace, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(workspace, 'status', '--porcelain')).toContain('assets/')

    // Restore non-PR mode for the tests that follow (they run sequentially
    // against the module-level GITHUB_EVENT_NAME read at import time).
    vi.stubEnv('GITHUB_EVENT_NAME', '')
    vi.resetModules()
    ;({ commitAndPush } = await import('../src/services/git.js'))
  })

  it('throws when cwd is not a git work tree', () => {
    expect(() => commitAndPush({ cwd: scratchRoot, files: ['a.svg'], token: 't' })).toThrow(
      /git rev-parse/,
    )
  })

  it('throws when a listed file does not exist', async () => {
    expect(() => commitAndPush({ cwd: workspace, files: ['missing.svg'], token: 't' })).toThrow(
      /git add/,
    )
  })
})
