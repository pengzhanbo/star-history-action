# Repository Guidelines

## Project Overview

**star-history-action** — a GitHub Action (TypeScript, ESM) that fetches a repository's star history and writes a chart SVG into the workspace repo, then commits and pushes it as `github-actions[bot]`. Declared in `action.yaml` as a **composite action**: inputs `repo` (default `${{ github.repository }}`), `token` (default `${{ github.token }}`), `output-directory` (default `assets`), `output-filename` (default `star-history.svg`), `svg-width` (default `960`), `theme` (`light`, `dark`, or both). `runs` first installs the action's own dependencies (`pnpm/action-setup` + `pnpm install --frozen-lockfile` in `${{ github.action_path }}`), then executes **`dist/index.js`** (built by tsdown from `src/index.ts`). Dependencies are **not** bundled into `dist`; the install step provides `node_modules` at runtime. No outputs, no branding.

The pipeline is fully wired and was verified end-to-end against a mock GitHub API (`GITHUB_API_URL`): both themes, single theme with custom filename, full and sampled (order-agnostic) history, commit/push, and idempotent reruns.

## Architecture & Data Flow

Pipeline:

1. Composite `runs` in `action.yaml`: set up pnpm (version from the `packageManager` field) → `pnpm install --frozen-lockfile` in the action directory → `node dist/index.js` with every input mapped to an `INPUT_*` env var (`@actions/core` reads them).
2. **Entry** — `src/index.ts`: `parseInputs()` (`config.ts`) → fetch records + logo (`services/api.ts`) → render one SVG per theme (`render.ts`, jsdom + `XYChart`) into `output-directory` under `GITHUB_WORKSPACE` → `commitAndPush()` (`git.ts`, identity `github-actions[bot]`; authenticated push via `GITHUB_REPOSITORY` on runners, `origin HEAD` locally). Failures surface through `setFailed`.
3. **Fetch layer** — `src/services/api.ts`: `request()`, `getRepoStargazers()`, `getRepoStargazersCount()`, `getRepoStarRecords()`, `getRepoLogo()` against `GITHUB_API_URL` (default `api.github.com`; per-page pagination; token auth header; rate-limit constant `DEFAULT_MAX_REQUEST_AMOUNT = 15` in `covert.ts`). `getRepoStarRecords` is order-agnostic: it reads page 1's `Link` header for the page count, detects whether page 1 is oldest-first or newest-first from the repo `created_at` distance, and either counts every stargazer per day (full history) or samples boundary pages (±100 stars per point in sampled mode).
4. **Rendering layer** — `src/charts/`, two families:
   - **D3 line chart** (`xy-chart.ts` + `draw-*`/`add-*` helpers + `ToolTip.ts`): mutates a live `SVGSVGElement` in place (DOM appended via d3-selection; serialized externally for image export).
   - **Satori OG-card family** (`radar-svg.ts`, `card-landscape1.ts`): pure and import-free — radar returns a full standalone SVG **string** (base64-embedded as `<img>` in the card); card returns a plain `{ type, props: { children } }` element tree (private `h()` helper, satori/React-compatible) sized 1200×630.
5. **Output** — per theme, the serialized SVG (`jsdom` `outerHTML`) is written verbatim; no PNG/svgo processing in the action. `src/render.ts` is the jsdom bridge: it pins `clientWidth` to the `svg-width` input (jsdom has no layout) and passes `chartWidth` so a non-empty title logo lands on-canvas; only the XY-chart family is used today.

Data contracts: XY points `{ x: Date | number, y: number }` (`XYPoint`, private to `xy-chart.ts`); dataset `label` follows `owner/repo` semantics (owner uniqueness gates title/legend logos; lowercase label match gates moltbot/openclaw easter eggs). Radar `RepoAttributes` are 0–99 percentile values. Records are `{ date: 'YYYY-MM-DD', stars: number }[]` ascending by date.

## Key Directories

| Path            | Purpose                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`          | Source root: `index.ts` (entry), `config.ts` (input parsing + file naming), `env.ts` (runner env reads), `git.ts` (commit/push), `render.ts` (jsdom SVG bridge), `utils.ts` (`formatDate`)                                                                                                          |
| `src/services/` | GitHub API client (`api.ts`) + request constants (`covert.ts`)                                                                                                                                                                                                                                      |
| `src/charts/`   | All rendering: `xy-chart.ts` (line-chart orchestrator), `draw-*` (append-to-selection D3 helpers), `add-*` (one-shot defs: font/filter), `get-format-*` (pure formatters), `ToolTip.ts` (class, default export), `radar-svg.ts`, `card-landscape1.ts`, `types.ts`, `index.ts` (barrel)              |
| `src/common/`   | Shared assets: `colors.ts` (dataset hex palettes), `fonts.ts` (inline base64 xkcd woff)                                                                                                                                                                                                             |
| `dist/`         | Build output (tsdown): `dist/index.js` + `dist/index.d.ts`. Dependencies stay external; imports resolve against the `node_modules` the composite action installs at run time. Committed — NOT gitignored; marked `linguist-generated` in `.gitattributes`; excluded from oxlint via `.eslintignore` |

## Development Commands

Package manager **pnpm** (corepack `pnpm@11.24.0`); Node **>=24** required (`engines`). Single-package pnpm workspace.

| Command       | Action                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`  | `tsdown` — compile `src/index.ts` → `dist/index.js` (ESM, deps external) + `dist/index.d.ts`; rewrites package.json entry fields; `clean` wipes dist |
| `pnpm lint`   | `oxlint . --type-aware --type-check && oxfmt . --check` — static + type lint, then format check                                                      |
| `pnpm format` | `oxlint . --type-check --type-aware --fix && oxfmt .` — auto-fix both                                                                                |

**No `test`, `typecheck`, `dev`, or `run` scripts exist.** Type checking rides on oxlint's `--type-aware --type-check` and tsdown dts emission (tsc is never invoked directly). `tsconfig.json` feeds the editor/oxlint/tsdown only.

## Code Conventions & Common Patterns

- **Formatting** (enforced by oxfmt preset, `oxfmt.config.ts`): no semicolons, single quotes, `trailingComma: all`, 2-space tabs, sorted imports (`sortImports` with type/value groups, no blank line between). **Never hand-format** — run `pnpm format`.
- **Modules/imports**: ESM everywhere with explicit `.js` suffixes on relative _and_ package imports (`dayjs/plugin/duration.js`, `../common/colors.js`). NodeNext resolution.
- **Naming prefixes** (semantic, keep consistent):
  - `draw-*` (`draw-axis.ts`, `draw-labels.ts`, …) — D3 helpers that **append to a passed selection**: signature `(selection: D3Selection, configObject) => void`, mutate only, return void.
  - `add-*` (`add-font.ts`, `add-filter.ts`) — one-shot global `<defs>` appenders: `addFont` injects the `'xkcd'` @font-face; `addFilter` injects `<filter id='xkcdify'>` (feTurbulence + feDisplacementMap wobble). **`addFilter` must run before any element references `url(#xkcdify)`.**
  - `get-format-*` — pure formatters, no deps, reused by axes + tooltip: `getFormatNumber`/`getNumberFormatUnit` (K/M compaction, thresholds 1e6 / 300), `getFormatTimeline`/`getTimestampFormatUnit` (dayjs human durations: `'day one'`, `'a day'`, `'N days'`, …).
  - Renderer files named by artifact: `xy-chart.ts`, `radar-svg.ts`, `card-landscape1.ts`.
- **Three rendering styles**, chosen by need: d3 append-chains mutating a live element (line-chart family); `parts: string[]` + `join('')` string assembly (`radar-svg.ts`); `h()` object-tree for satori/React compat (`card-landscape1.ts`). No React/canvas dependency.
- **Options/defaults merge**: shallow spread `{ ...themeDefaultOptions(transparent), ...initialOptions }`, selected by `theme === 'dark'`; `transparent: boolean` swaps `backgroundColor` under both themes. Light vs dark palettes come from `common/colors.ts` (`colors`/`darkColors`, 20 entries; `colorsCompact`/`darkColorsCompact`, 9 — compact palettes for backend SVG gen), dataset `i` → `dataColors[i]`.
- **`envType: 'browser' | 'node'`** gates environment-dependent code (responsive sizing + viewBox + animation `<style>` with `@keyframes lobster-swim` only in browser; tooltip window handlers early-return in node). Node-safety: `typeof` guards around `getBBox`/`getComputedTextLength` (e.g. `draw-labels.ts`); `ToolTip` construction with empty items never measures.
- **Type locations**: shared cross-cutting types in `src/charts/types.ts` (`D3Selection`, `Position` = `'down_right' | 'down_left' | 'up_right' | 'up_left'`, `LegendPosition` = `'top-left' | 'bottom-right'`); renderer-specific option/config interfaces stay **colocated** in their renderer (`XYChartConfig`/`XYChartOptions` in `xy-chart.ts`; draw-* files declare private `*Config` interfaces).
- **Lint suppressions** are inline and file-scoped where functions are legitimately large: `// oxlint-disable complexity max-lines-per-function` (xy-chart.ts, card-landscape1.ts). Don't add new suppressions without matching existing ones. `env.ts` carries a file-scoped `// oxlint-disable no-process-env` (runner env is the action's only config source).
- **Cross-file contracts to respect**: `<filter id='xkcdify'>`; clip ids `clip-circle-title-${text}`; CSS classes `.xaxis`, `.yaxis`, `.xkcd-chart-xyline`, `.xkcd-chart-xycircle-group`, `.chart-tooltip-dot`, `.browser-only` (removed during image export), `.moltbot-emoji`/`.prey-emoji` (easter eggs). Font is always family `'xkcd'` sourced from `xkcdFontUrl` (`common/fonts.ts`); the card tree declares the family but the host must supply the font at satori render time.
- **Barrel gap**: `charts/index.ts` re-exports only `./xy-chart.js` + types — `renderRadarSvg`/`buildLandscape1`/draw-*/ToolTip are **not** exported there; consumers must deep-import (`./radar-svg.js`).

## Important Files

| File                                                       | Role                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action.yaml`                                              | Runtime contract: composite action — `pnpm/action-setup`, `pnpm install --frozen-lockfile`, then `node dist/index.js` with all six inputs mapped to `INPUT_*` env vars |
| `src/index.ts`                                             | Action entry: parse → fetch → render → write → commit/push; errors → `setFailed`                                                                                       |
| `src/services/api.ts`                                      | GitHub REST client: repo info, paginated stargazer fetch, order-agnostic star records, repo logo (base from `GITHUB_API_URL`)                                          |
| `src/charts/xy-chart.ts`                                   | Main line-chart orchestrator + `XYData`/`XYChartData`/`XYChartConfig`/`XYChartOptions` contracts                                                                       |
| `src/charts/card-landscape1.ts`, `src/charts/radar-svg.ts` | Satori OG-card + radar SVG generators (pure, import-free, not used by the action yet)                                                                                  |
| `package.json`                                             | Scripts + deps (runtime deps include `jsdom` — installed by the action at run time); `packageManager` feeds `pnpm/action-setup`                                        |
| `tsdown.config.ts`, `tsconfig.json`                        | Build config (ESM, dts, clean, exports rewrite; deps external by design) / type config (extends `@tsconfig/node24` + `strictest`, lib `ESNext+DOM`, `jsx: preserve`)   |
| `oxlint.config.ts`, `oxfmt.config.ts`                      | Lint/format presets from `@pengzhanbo/oxc-config` (node rules scoped `['src/**/*.ts']`; regexp plugin on)                                                              |
| `.eslintignore`                                            | Excludes generated `dist/` from oxlint                                                                                                                                 |
| `.env`                                                     | Local only (gitignored): `GITHUB_TOKEN` for dev API calls. Not referenced by action.yaml; never a runtime input                                                        |

## Runtime/Tooling Preferences

- **Runtime**: Node >= 24 (`engines`); `type: module` ESM. The composite action's shell steps use the runner's PATH Node (GitHub-hosted runners default to a current Node); `pnpm/action-setup` bootstraps pnpm itself, so no corepack dependency.
- **Package manager**: pnpm 11.24.0 (`packageManager` field; lockfile v9.0). `pnpm-workspace.yaml` declares a single-package workspace (`shellEmulator: true`). The action installs with `--frozen-lockfile`; the lockfile must stay in sync with `package.json`.
- **Toolchain is Oxc-first, no Prettier/ESLint/tsc**: `tsdown` (Rolldown) builds; `oxlint` (type-aware) + `oxfmt` lint/format; TypeScript 7 (tsgo) powers types via oxlint's `--type-check` and dts emission. Editor support via **oxc-vscode** extension (`.vscode/settings.json`: oxfmt owns import sorting — `organizeImports` disabled; `formatOnSave` on).
- **Style enforcement**: `pnpm lint` fails on format drift; always run `pnpm format` before committing.
- D3 is modular (`d3-axis`, `d3-scale`, `d3-selection`, `d3-shape` + `@types/*`) — do not import monolithic `d3`. Utility helper package: `@pengzhanbo/utils` (e.g. `uniq`).
- **No bundling**: tsdown externalizes every `dependencies` entry by default; do not add `deps.alwaysBundle`/`copy` hacks — jsdom and css-tree read package-relative runtime assets, which only works with a real `node_modules` (bundling them forced fs/`Module._load` redirects; that machinery was removed when `runs` became composite).
- No docs/README/LICENSE-equivalent content: this AGENTS.md is the primary orientation document.

## Testing & QA

- **No test infrastructure exists** — despite `vitest@^4.1.11` and `@vitest/coverage-v8` in devDependencies, there is **no test script, no vitest config, and zero test files** (no `*.test.*`/`*.spec.*`/`__tests__`). Do not assume vitest is configured; a test-related task must add config + script from scratch.
- QA surface today: `pnpm lint` (oxlint type-aware + oxfmt check) and `pnpm build` (tsdown dts emission doubles as typecheck). End-to-end behavior is exercised hermetically against a local mock GitHub API (`GITHUB_API_URL`) with `GITHUB_WORKSPACE`/`INPUT_*` env in a scratch repo, including commit author and push assertions.
- Coverage expectations: none defined.
- Given the renderers, a future test setup likely needs a DOM-ish environment for `xy-chart.ts` (it requires a real `SVGSVGElement`; node guards exist for text measurement; `jsdom` is already a runtime dep) while `radar-svg.ts`/`get-format-*` are trivially testable pure functions.
