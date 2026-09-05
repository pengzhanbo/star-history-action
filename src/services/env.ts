// oxlint-disable no-process-env
// Runtime configuration comes from environment variables set by the GitHub
// runner; reading them here keeps all process.env access in one file.
//
// 运行时配置来自 GitHub runner 注入的环境变量；在此处统一读取可以保证所有
// process.env 访问集中在单一文件中。

/**
 * Base URL of the GitHub API; honoring `GITHUB_API_URL` also supports
 * GitHub Enterprise Server instances.
 *
 * GitHub API 的基础 URL；识别 `GITHUB_API_URL` 同时也兼容 GitHub
 * Enterprise Server 实例。
 */
export const GITHUB_API_URL = process.env['GITHUB_API_URL'] ?? 'https://api.github.com'

/**
 * The current repository in `owner/repo` form; empty on local runs.
 *
 * 当前仓库的 `owner/repo` 标识；本地运行时为空字符串。
 */
export const GITHUB_REPOSITORY = process.env['GITHUB_REPOSITORY'] ?? ''

/**
 * Base URL of the GitHub server, used to build the authenticated push URL.
 *
 * GitHub 服务器的基础 URL，用于构造带认证的推送地址。
 */
export const GITHUB_SERVER_URL = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'

/**
 * Name of the event that triggered the workflow (e.g. `push`, `pull_request`).
 *
 * 触发工作流的事件名称（例如 `push`、`pull_request`）。
 */
export const GITHUB_EVENT_NAME = process.env['GITHUB_EVENT_NAME'] ?? ''

/**
 * Head ref (source branch) of a pull request; empty outside PR events.
 *
 * 拉取请求的源分支引用；非 PR 事件时为空字符串。
 */
export const GITHUB_HEAD_REF = process.env['GITHUB_HEAD_REF'] ?? ''

/**
 * Name of the branch or tag the run is based on.
 *
 * 运行所基于的分支或标签名称。
 */
export const GITHUB_REF_NAME = process.env['GITHUB_REF_NAME'] ?? ''

/**
 * Absolute path of the checked-out repository on the runner; empty on local runs.
 *
 * runner 上检出仓库的绝对路径；本地运行时为空字符串。
 */
export const GITHUB_WORKSPACE = process.env['GITHUB_WORKSPACE'] ?? ''
