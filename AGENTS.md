# Repository Guidelines

## Project Overview

**star-history-action** — a GitHub Action (TypeScript, ESM) that fetches a repository's star history, writes a chart SVG into the workspace repo, then commits and pushes it as `github-actions[bot]`. Declared in `action.yaml` as a **composite action**: `runs` first installs its own dependencies (`pnpm/action-setup` + `pnpm install --frozen-lockfile --prod`), then executes **`dist/index.js`** (built by tsdown from `src/index.ts`). Dependencies are **not** bundled into `dist`; the install step provides `node_modules` at runtime. No outputs, no branding.

Key inputs: `repo` (comma/space-separated, supports multi-repo comparison), `output-filename` (default `star-history.svg`), `svg-width` (default `960`), `theme` (`light`/`dark`/both), `output-format` (`svg`/`png`/`json`, multiple formats allowed), `radar` (additionally outputs a per-repo radar SVG), `cache` (incremental fetch: the previous run's `<stem>.cache.json` is the baseline).

## Architecture & Data Flow

1. **Entry** `src/index.ts`: `parseInputs()` → (when `cache` is on) `readCacheRecords()` loads the baseline → `fetchDatasets()` fetches records + logo per repo in parallel (`Promise.allSettled`; failing repos are skipped, and radar metrics are fetched when `radar` is on; `json` format skips the avatar request) → when `json` is included, `writeJsonExport()`; when `svg`/`png` is included, `render.ts` renders one SVG per theme (jsdom + `XYChart`) → all writes go through `common/output.ts` `writeOutput` → `commitAndPush()` (skipped entirely on `pull_request` events).
2. **Fetch layer** `src/services/api.ts`: paginated fetch, order-agnostic full/sampled star records (reads the `Link` header for the page count and detects ordering; page 1 is reused, never refetched), incremental records (`getIncrementalStarRecords` + `mergeStarRecords`, falls back to a full fetch when the baseline is out of reach), logo. `request()` retries 5xx/network errors with exponential backoff, and only waits on rate limits (403/429 + `x-ratelimit-remaining: 0`) when the reset is within 60s. Radar metrics in `src/services/radar.ts` (~4 requests per repo, mapped to 0–99 percentiles).
3. **Rendering layer** `src/charts/`: D3 line-chart family (`xy-chart.ts` + `draw-*`/`add-*`); Satori OG-card family (`radar-svg.ts`, `card-landscape1.ts`, pure and import-free). The x-axis font is `'xkcd'`, inlined as a **woff2 subset** at render time.
4. **Output** when `png` is included, bytes go through `common/raster.ts` `rasterizeSvg` (resvg explicitly loads the xkcd font to avoid falling back to a system font) then sharp palette quantization (~65% smaller, pixel-lossless).

Data contracts: records are `{ date: 'YYYY-MM-DD', stars: number }[]` ascending by date; radar `RepoAttributes` are 0–99 percentiles; dataset `label` follows `owner/repo`.

## Key Directories

| Path            | Purpose                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`          | Entry `index.ts`; `config.ts` (input parsing + naming), `git.ts` (commit/push), `render.ts` (jsdom bridge), `utils.ts`                                                 |
| `src/services/` | GitHub API client `api.ts` + constants `covert.ts` + incremental cache `cache.ts` + radar `radar.ts` + dataset orchestration `fetch.ts` + JSON export `json-export.ts` |
| `src/charts/`   | Rendering: `xy-chart.ts`, `draw-*`, `add-*`, `get-format-*`, `radar-svg.ts`, `card-landscape1.ts`, `types.ts`                                                          |
| `src/common/`   | `colors.ts` palettes, `fonts.ts`, `font-subset.ts`, `raster.ts`, `output.ts`                                                                                           |
| `dist/`         | Build output, committed (not gitignored); excluded via `.eslintignore`                                                                                                 |

## Development Commands

Package manager **pnpm** (corepack `pnpm@11.25.0`); Node **>=24**.

| Command       | Action                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| `pnpm build`  | `tsdown` — compile `src/index.ts` → `dist/index.js` (ESM, deps external) |
| `pnpm lint`   | `oxlint . --type-aware --type-check && oxfmt . --check`                  |
| `pnpm format` | `oxlint . --type-check --type-aware --fix && oxfmt .` — auto-fix         |
| `pnpm test`   | `vitest` — unit + hermetic end-to-end suites                             |

## Code Conventions & Common Patterns

- **Formatting** (enforced by oxfmt): no semicolons, single quotes, `trailingComma: all`, 2-space indentation, sorted imports. **Never hand-format** — run `pnpm format` before committing.
- **Modules/imports**: ESM everywhere, with explicit `.js` suffixes on relative and package imports (e.g. `../common/colors.js`). NodeNext.
- **Naming prefixes**: `draw-*` D3 helpers `(selection, config) => void`, append in place; `add-*` one-shot `<defs>` appenders (`addFilter` must run before any `url(#xkcdify)` reference); `get-format-*` pure formatters.
- **Three rendering styles**: D3 in-place mutation (line-chart family); `parts[] + join('')` (`radar-svg.ts`); `h()` object tree (`card-landscape1.ts`). No React/canvas.
- **Node-only rendering**: no responsive sizing, no viewBox toggling, no animation, no interactive tooltips; `getBBox`/`getComputedTextLength` need `typeof` guards.
- **Type locations**: shared types in `src/charts/types.ts` (`D3Selection`, `LegendPosition`); renderer-specific interfaces stay **colocated** with their renderer (`XYChart*` in `xy-chart.ts`).
- **Cross-file contracts not to break**: `<filter id='xkcdify'>`, `.xaxis/.yaxis/.xkcd-chart-xyline/.xkcd-chart-xycircle-group/.chart-tooltip-dot`, font is always `'xkcd'` from `common/fonts.ts`.
- **Barrel gap**: `charts/index.ts` exports only `xy-chart.js` + types; `renderRadarSvg`/`buildLandscape1`/`draw-*` require deep imports (`./radar-svg.js`).
- D3 uses **modular** imports (`d3-axis`/`d3-scale`/`d3-selection`/`d3-shape`), never the monolithic `d3`.
- **No bundling**: tsdown externalizes all `dependencies` by default; don't add `deps.alwaysBundle`/`copy` (jsdom needs a real `node_modules`).

## Runtime/Tooling Preferences

- **Runtime**: Node >= 24, ESM. pnpm is bootstrapped by `pnpm/action-setup`; no corepack at runtime.
- **Oxc-first toolchain** (no Prettier/ESLint/tsc): tsdown builds, oxlint + oxfmt check, types via oxlint `--type-check` and dts emission.
- **Style enforcement**: `pnpm lint` fails on format drift; always run `pnpm format` before committing.
- Docs live in `README.md` (usage + inputs) and `LICENSE` (ISC).

## Testing & QA

- **Vitest** (jsdom environment), suites in `test/`: unit tests for `config.ts`, `services/api.ts` (fetch-mocked, incl. incremental fallbacks), `render.ts`, plus a hermetic end-to-end `action.e2e.test.ts` (runs the real `dist/index.js` against a local mock GitHub API, asserting commit author, branch, chart files, idempotent reruns, and request counts).
- **`src/services/git.ts` is not unit-tested** (commit/push shells out to a real `git`; already covered end-to-end). Don't add a unit test for it.
- QA surface: `pnpm lint`, `pnpm build`, and `pnpm test --run` (single pass; without `--run` it's watch mode). Coverage is enabled, no thresholds.
- **Fixing lint errors**: any lint error from `pnpm lint` should first be fixed by running `pnpm format` (auto-fix) before manually editing; re-run `pnpm lint` afterwards to confirm it passes.
