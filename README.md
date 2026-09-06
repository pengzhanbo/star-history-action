# star-history-action

English | [简体中文](README.zh-CN.md)

A GitHub Action that fetches a repository's star history and commits an
xkcd-style SVG chart back into the repository.

## Getting Started

Add the action to a workflow. The example below refreshes the chart on a
schedule and on every push to `main`:

```yaml
name: Update star history

on:
  schedule:
    - cron: '0 0 * * *' # daily
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: pengzhanbo/star-history-action@v1
        with:
          repo: pengzhanbo/star-history-action
          token: ${{ github.token }}
```

## Inputs

<!-- markdownlint-disable MD060 -->

| Name               | Required | Default                    | Description                                                                                                                                                           |
| ------------------ | -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`             | No       | `${{ github.repository }}` | Repository to chart, e.g. `pengzhanbo/star-history-action`. Comma/space separated (e.g. `a/repo1, b/repo2`) to compare multiple repos in one chart.                   |
| `token`            | No       | `${{ github.token }}`      | GitHub token with read access to the target repo. Use a PAT for private or GHES targets.                                                                              |
| `output-directory` | No       | `assets`                   | Directory to write the chart into, relative to the workspace root.                                                                                                    |
| `output-filename`  | No       | `star-history.svg`         | Output file name. Must end with `.svg`. When both themes are configured, `-light`/`-dark` is appended before the extension.                                           |
| `svg-width`        | No       | `960`                      | Width of the generated SVG in pixels; height is 2/3 of the width.                                                                                                     |
| `theme`            | No       | `light`                    | Chart theme: `light`, `dark`, or comma/space separated `light, dark` to output both.                                                                                  |
| `output-format`    | No       | `svg`                      | Output file format: `svg` (default), `png` (rasterized from the SVG), `both`, or `json` (structured record data instead of charts).                                   |
| `radar`            | No       | `false`                    | Also render a per-repo radar SVG chart of repo health metrics (stars, new stars, pushes, contributors, issues closed, forks), each scored 0–99.                       |
| `cache`            | No       | `false`                    | Incremental fetch: read the previous run's `<stem>.cache.json` as a baseline and only fetch stargazers added since, slashing API quota on repos with large histories. |

<!-- markdownlint-enable MD060 -->

## Behavior

- **Data source**: the GitHub REST API (`GITHUB_API_URL` is honored, so GitHub
  Enterprise instances work too).
- **Multi-repo comparison**: pass several comma/space-separated `owner/repo`
  values to `repo` and the chart draws one line per repository on shared axes,
  with a per-repo legend entry (and avatar when the repos share one owner).
- **History fidelity**: up to 15 pages are fetched per repository.
  Repositories whose history fits within that budget (≈1,500 stars) get an
  exact per-day series; larger repositories are sampled at evenly spaced
  boundary points (each within ±100 stars of the real count).
- **Incremental fetch**: with `cache: true`, the previous run's
  `<stem>.cache.json` (committed alongside the charts, containing the same
  `{ date, stars }` records) becomes the baseline. Subsequent runs walk only
  the newest stargazers pages until they dip below the baseline date — a
  handful of requests instead of the full history — and merge the increment
  onto the baseline. This is most effective for repos with 1,500+ stars: the
  per-run request count stays flat as the history grows. A fresh/absent
  baseline, an oldest-first GitHub instance, or an increment that outgrows the
  budget degrades gracefully to a full fetch. Without new stargazers the cache
  bytes are unchanged, so reruns stay idempotent.
- **Rendering**: a hand-drawn xkcd-style line chart, with the xkcd font
  embedded inline so the SVG renders standalone anywhere.
- **Commit & push**: the chart is committed as `github-actions[bot]` and pushed
  to the current branch on the default remote. Reruns that produce no changes
  skip the commit, so the workflow is idempotent. On `pull_request` events the
  write-back is skipped entirely — forked PRs cannot be pushed to with the
  default token, and the chart does not belong on a feature branch.
- **Output format**: SVG by default — `output-filename` must end in `.svg`.
  With `output-format: png` or `both`, the chart is rasterized to PNG(s) via
  resvg (the `.png` name mirrors the `.svg` one, e.g. `star-history-light.png`).
  resvg loads the xkcd font from the action's `assets/xkcd.ttf`, so the PNG
  text style matches the SVG instead of falling back to a system font; the
  result is then palette-quantized via sharp for a ~65% smaller file with
  pixel-identical output.
- **Radar chart**: with `radar: true`, a per-repo radar SVG is written alongside
  the history chart, one file per theme like the history chart itself — for a
  single repo/theme that's `<stem>-radar.svg`; multiple repos append
  `<owner>-<repo>` and both themes insert `-light`/`-dark` before the extension
  (e.g. `star-history-radar-owner-repo-dark.svg`). Six metrics (stars, new stars
  over 30 days, pushes, contributors, issues closed, forks) are fetched from the
  GitHub API and mapped to 0–99 scores on a log scale, so the radar compares
  metric intensity rather than raw counts. The xkcd font is inlined as a woff2
  subset (same as the history chart). Radar output follows the same
  `output-format` rules as the history chart: with `png`/`both` a PNG twin is
  rasterized per theme/repo at the radar's native 400×400 size, and both the
  SVGs and PNGs are included in the same commit as the history chart.
- **JSON export**: with `output-format: json`, no charts are rendered; instead
  the fetched records are written as `star-history.json` (the `output-filename`
  stem with a `.json` extension) as `{ updatedAt, repos: [{ repo, records,
radar? }] }` — `records` is the ascending `{ date, stars }` series and
  `radar` holds the 0–99 scores when `radar: true`. The JSON is theme-agnostic
  (no `-light`/`-dark` variants) and holds every repo in one file, ready for
  downstream tooling (badges, custom frontends, archives).
- **Partial success**: when several repos are compared, a repo that fails to
  fetch (404, rate limit, no stars) is skipped with a warning instead of
  failing the whole run — the survivors still chart and commit. The run only
  fails when every repo fails.

## Embedding the chart in your README

The generated SVG is standalone — the xkcd font is inlined — so it renders
anywhere, including in the GitHub README of your own repository.

**Single theme**: reference the chart with a relative path from the repository
root:

```markdown
![Star History](assets/star-history.svg)
```

**Both themes** (`theme: light, dark`): the action writes two files —
`star-history-light.svg` and `star-history-dark.svg`. Use a `<picture>` element
to swap the chart automatically with the viewer's color scheme:

```markdown
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="assets/star-history-dark.svg"
  >
  <img
    alt="Star History"
    src="assets/star-history-light.svg"
  >
</picture>
```

Notes:

- Adjust the paths if you change `output-directory` or `output-filename` (for a
  single theme, the file keeps the input filename; for both themes, `-light` /
  `-dark` is inserted before the extension).
- Relative paths resolve against the repository root on the branch the README is
  rendered from. The workflow commits and pushes the chart, so the image updates
  once the run completes.
- If your README lives in a subdirectory, prefix the relative path with `../`.
- The `alt` text keeps the chart accessible and is shown when the image cannot
  load.

## Development

```bash
pnpm install
pnpm lint   # oxlint (type-aware) + oxfmt check
pnpm build  # tsdown → dist/index.js
pnpm test --run  # vitest, including a hermetic end-to-end run
```

`dist/index.js` is committed so the composite action can run `node dist/index.js`
after installing production dependencies.

## License

MIT
