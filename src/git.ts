import { execFileSync, spawnSync } from 'node:child_process'
import { info } from '@actions/core'
import {
  GITHUB_EVENT_NAME,
  GITHUB_HEAD_REF,
  GITHUB_REF_NAME,
  GITHUB_REPOSITORY,
  GITHUB_SERVER_URL,
} from './env.js'

export interface CommitOptions {
  cwd: string // workspace root (git repo root in production)
  files: string[] // chart files, POSIX-relative to cwd, added verbatim
  token: string // for authenticated push URL
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || String(error)}`)
  }
}

export function commitAndPush({ cwd, files, token }: CommitOptions): void {
  // On pull_request events the head ref is the source branch — for forked PRs
  // the default token cannot push there at all, and even in-repo PRs the chart
  // should not be committed onto a feature branch. schedule/push/workflow_dispatch
  // runs own the write-back, so skip it entirely here.
  if (GITHUB_EVENT_NAME === 'pull_request') {
    info('pull_request context: skipping commit and push')
    return
  }

  runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  runGit(cwd, ['add', '--', ...files])

  // `git diff --cached --quiet` exits 0 when nothing is staged: idempotent
  // reruns must not produce empty commits.
  const diffCheck = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (diffCheck.status === 0) {
    info('no chart changes; skipping commit and push')
    return
  }
  if (diffCheck.status !== 1) {
    const stderr = diffCheck.stderr?.toString() ?? ''
    throw new Error(`git diff --cached --quiet failed: ${stderr.trim()}`)
  }

  runGit(cwd, [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    'chore: update star history chart',
  ])

  if (GITHUB_REPOSITORY) {
    // Real runner: authenticate the push with the action token.
    const host = new URL(GITHUB_SERVER_URL).host
    const pushUrl = `https://x-access-token:${encodeURIComponent(token)}@${host}/${GITHUB_REPOSITORY}.git`
    // env.ts defaults unset vars to '' (not nullish), so `??` would never
    // fall through; `||` handles empty GITHUB_HEAD_REF on push events.
    const branch = GITHUB_HEAD_REF || GITHUB_REF_NAME || 'main'
    runGit(cwd, ['push', pushUrl, `HEAD:refs/heads/${branch}`])
  } else {
    // Local/dev run: rely on the origin remote and ambient credentials.
    runGit(cwd, ['push', 'origin', 'HEAD'])
  }
}
