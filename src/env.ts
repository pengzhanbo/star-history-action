// oxlint-disable no-process-env
// Runtime configuration comes from environment variables set by the GitHub
// runner; reading them here keeps all process.env access in one file.

export const GITHUB_API_URL = process.env['GITHUB_API_URL'] ?? 'https://api.github.com'
export const GITHUB_REPOSITORY = process.env['GITHUB_REPOSITORY'] ?? ''
export const GITHUB_SERVER_URL = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'
export const GITHUB_EVENT_NAME = process.env['GITHUB_EVENT_NAME'] ?? ''
export const GITHUB_HEAD_REF = process.env['GITHUB_HEAD_REF'] ?? ''
export const GITHUB_REF_NAME = process.env['GITHUB_REF_NAME'] ?? ''
export const GITHUB_WORKSPACE = process.env['GITHUB_WORKSPACE'] ?? ''
