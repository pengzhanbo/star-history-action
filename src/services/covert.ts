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
