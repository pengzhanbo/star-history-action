import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Intercept all git invocations to assert how the runner-mode push URL and
// branch refspec are built, without any real git/network activity.
const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}))

async function loadCommitAndPush(): Promise<
  (typeof import('../src/services/git.js'))['commitAndPush']
> {
  vi.resetModules()
  const { commitAndPush } = await import('../src/services/git.js')
  return commitAndPush
}

function pushCall(): string[] {
  const calls = execFileSyncMock.mock.calls as [string, string[]][]
  const push = calls.findLast(([, args]) => args.includes('push'))
  expect(push, 'expected a git push call').toBeDefined()
  return push![1]
}

beforeEach(() => {
  execFileSyncMock.mockReset().mockReturnValue(Buffer.from(''))
  spawnSyncMock.mockReset().mockReturnValue({ status: 1, stderr: Buffer.from('') })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('commitAndPush (runner mode)', () => {
  it('pushes with the token-authenticated URL and GITHUB_HEAD_REF branch', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', 'feature/x')
    vi.stubEnv('GITHUB_REF_NAME', '')
    const commitAndPush = await loadCommitAndPush()

    commitAndPush({ cwd: '/workspace', files: ['assets/star-history.svg'], token: 'sec ret' })

    expect(pushCall()).toEqual([
      'push',
      'https://x-access-token:sec%20ret@github.test/owner/repo.git',
      'HEAD:refs/heads/feature/x',
    ])
  })

  it('falls back to GITHUB_REF_NAME, then main, for the branch', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', '')
    vi.stubEnv('GITHUB_REF_NAME', 'release')
    const commitAndPush = await loadCommitAndPush()

    commitAndPush({ cwd: '/workspace', files: ['a.svg'], token: 't' })
    expect(pushCall()[2]).toBe('HEAD:refs/heads/release')

    vi.stubEnv('GITHUB_REF_NAME', '')
    vi.resetModules()
    const fresh = await loadCommitAndPush()
    fresh({ cwd: '/workspace', files: ['a.svg'], token: 't' })
    expect(pushCall()[2]).toBe('HEAD:refs/heads/main')
  })

  it('commits with the github-actions[bot] identity', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', 'main')
    vi.stubEnv('GITHUB_REF_NAME', 'main')
    const commitAndPush = await loadCommitAndPush()

    commitAndPush({ cwd: '/workspace', files: ['a.svg'], token: 't' })

    const calls = execFileSyncMock.mock.calls as [string, string[]][]
    const commit = calls.find(([, args]) => args.includes('commit'))
    expect(commit).toBeDefined()
    expect(commit![1]).toEqual(
      expect.arrayContaining([
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '-m',
        'chore: update star history chart',
      ]),
    )
  })

  it('skips commit and push when nothing is staged', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', '')
    vi.stubEnv('GITHUB_REF_NAME', '')
    spawnSyncMock.mockReturnValue({ status: 0, stderr: Buffer.from('') })
    const commitAndPush = await loadCommitAndPush()

    commitAndPush({ cwd: '/workspace', files: ['a.svg'], token: 't' })

    const calls = execFileSyncMock.mock.calls as [string, string[]][]
    expect(calls.find(([, args]) => args.includes('commit'))).toBeUndefined()
    expect(calls.find(([, args]) => args.includes('push'))).toBeUndefined()
  })

  it('throws when the diff check fails', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', '')
    vi.stubEnv('GITHUB_REF_NAME', '')
    spawnSyncMock.mockReturnValue({ status: 2, stderr: Buffer.from('boom') })
    const commitAndPush = await loadCommitAndPush()

    expect(() => commitAndPush({ cwd: '/workspace', files: ['a.svg'], token: 't' })).toThrow(
      'git diff --cached --quiet failed: boom',
    )
  })

  it('stages only the listed chart files', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.test')
    vi.stubEnv('GITHUB_HEAD_REF', '')
    vi.stubEnv('GITHUB_REF_NAME', '')
    const commitAndPush = await loadCommitAndPush()

    commitAndPush({ cwd: '/workspace', files: ['a.svg', 'b.svg'], token: 't' })

    const calls = execFileSyncMock.mock.calls as [string, string[]][]
    const add = calls.find(([, args]) => args.includes('add'))
    expect(add![1]).toEqual(['add', '--', 'a.svg', 'b.svg'])
  })
})
