import { execFileSync, spawnSync } from 'node:child_process'
import { info } from '@actions/core'
import {
  GITHUB_EVENT_NAME,
  GITHUB_HEAD_REF,
  GITHUB_REF_NAME,
  GITHUB_REPOSITORY,
  GITHUB_SERVER_URL,
} from './env.js'

/**
 * Options for committing and pushing the generated chart files.
 *
 * 提交并推送生成的图表文件的选项。
 */
export interface CommitOptions {
  /**
   * Workspace root — the git repo root in production.
   *
   * 工作区根目录，在生产环境即为 git 仓库根目录。
   */
  cwd: string // workspace root (git repo root in production)
  /**
   * Chart files, POSIX-relative to cwd, added verbatim.
   *
   * 图表文件路径，相对 cwd 的 POSIX 路径，按原样加入暂存区。
   */
  files: string[] // chart files, POSIX-relative to cwd, added verbatim
  /**
   * Token used to build the authenticated push URL.
   *
   * 用于构造带认证推送地址的令牌。
   */
  token: string // for authenticated push URL
}

/**
 * Runs a git command and throws a readable error on failure.
 *
 * 执行 git 命令，失败时抛出可读的错误信息。
 *
 * @param cwd - Directory to run git in / 执行 git 的目录
 * @param args - Git arguments after `git` / `git` 之后的命令行参数
 * @returns The trimmed stdout of the command / 命令的 stdout 输出（去除首尾空白）
 * @throws {Error} With the captured stderr when the command exits non-zero /
 *   命令以非零状态退出时抛出，包含捕获的 stderr
 */
function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || String(error)}`)
  }
}

/**
 * Commits the chart files as `github-actions[bot]` and pushes them.
 *
 * Idempotent: runs with no staged changes skip the commit. On `pull_request`
 * events the whole write-back is skipped — forked PRs cannot be pushed with
 * the default token, and the chart does not belong on a feature branch.
 *
 * 以 `github-actions[bot]` 身份提交图表文件并推送。
 *
 * 幂等设计：无暂存变更时跳过提交。在 `pull_request` 事件下整个写回过程会被
 * 跳过——fork 的 PR 无法使用默认令牌推送，图表也不应提交到特性分支。
 *
 * @param options - Commit and push configuration / 提交与推送配置
 * @example
 * commitAndPush({ cwd: workspace, files: ['assets/star-history.svg'], token })
 */
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
    'chore: update star history chart [skip ci]',
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
