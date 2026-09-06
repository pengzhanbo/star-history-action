/**
 * Maximum number of GitHub API requests the action makes per run.
 *
 * 动作单次运行最多发起的 GitHub API 请求数。
 *
 * This mirrors the per-hour request budget of an unauthenticated GitHub API
 * token. Staying under it keeps the action functional even when rate limits
 * are tight.
 *
 * 该值对应未认证 GitHub API 每小时可用的请求额度。保持在其范围之内可以让
 * 动作在速率限制较紧时依然可用。
 */
export const DEFAULT_MAX_REQUEST_AMOUNT = 15

export const API_PER_PAGE = 100 // GitHub API max items per request
export const REQUEST_TIMEOUT_MS = 15000 // 15s timeout for GitHub API calls

// Number of attempts per request, including the first one.
export const RETRY_MAX_ATTEMPTS = 3
// Exponential backoff base delay (ms); the nth retry waits base * 2^(n-1).
export const RETRY_BASE_DELAY_MS = 500
// Longest we will sleep for a rate-limit reset; anything further fails fast.
export const MAX_RATE_LIMIT_WAIT_MS = 60_000

export const REPO_INFO_ACCEPT = 'application/vnd.github+json'
export const STARGAZERS_ACCEPT = 'application/vnd.github.v3.star+json'
