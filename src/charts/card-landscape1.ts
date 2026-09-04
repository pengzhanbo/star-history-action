// oxlint-disable max-lines max-lines-per-function

/**
 * Clean OG card layout (landscape1) — uses the h() helper pattern.
 * Works with both satori (backend) and React (frontend).
 *
 * 1200×630 layout: left side = repo info + stats, right side = radar chart.
 */

/**
 * Lightweight element builder — avoids React runtime dependency
 *
 * @param type - Element type
 * @param props - Element props
 * @param children - Element children
 * @returns Element object
 */
function h(type: string, props: Record<string, any> | null, ...children: any[]): any {
  const flat = children.flat(Infinity).filter((c) => c != null && c !== false)
  return {
    type,
    props: {
      ...props,
      children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat,
    },
  }
}

// Gentle organic wobble via layered sines, so the seal keeps the hand-drawn feel
//
// 通过叠加正弦波产生柔和的有机抖动，让印章保持手绘质感。
const wob = (a: number): number => 1.4 * Math.sin(a * 3 + 1.2) + 1 * Math.sin(a * 5 + 0.7)

/**
 * Build a scalloped rosette path (certificate-seal edge) with a slight hand-drawn wobble.
 *
 * @param cx - Center x coordinate
 * @param cy - Center y coordinate
 * @param r - Radius of the rosette
 * @param depth - Depth of the rosette
 * @param scallops - Number of scallops in the rosette
 * @returns SVG path string
 */
function rosettePath(cx: number, cy: number, r: number, depth: number, scallops: number): string {
  const step = (Math.PI * 2) / scallops
  const parts: string[] = []
  for (let i = 0; i < scallops; i++) {
    const a0 = step * i
    const a1 = step * (i + 1)
    const mid = (a0 + a1) / 2
    const r0 = r + wob(a0)
    const rc = r + depth + wob(mid)
    const r1 = r + wob(a1)
    const x0 = cx + Math.cos(a0) * r0
    const y0 = cy + Math.sin(a0) * r0
    const xc = cx + Math.cos(mid) * rc
    const yc = cy + Math.sin(mid) * rc
    const x1 = cx + Math.cos(a1) * r1
    const y1 = cy + Math.sin(a1) * r1
    if (i === 0) {
      parts.push(`M ${x0.toFixed(1)},${y0.toFixed(1)}`)
    }
    parts.push(`Q ${xc.toFixed(1)},${yc.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

/**
 * Data contract for the landscape1 OG card.
 *
 * landscape1 分享卡的数据契约。
 */
export interface Landscape1Data {
  /**
   * Repository name in `owner/repo` form / `owner/repo` 形式的仓库名。
   */
  name: string
  /**
   * Repository description / 仓库描述。
   */
  description: string | null
  /**
   * Star count / star 数量。
   */
  stars: number
  /**
   * Fork count / fork 数量。
   */
  forks: number
  /**
   * Primary language / 主要编程语言。
   */
  language: string | null
  /**
   * License name / 许可证名称。
   */
  license: string | null
  /**
   * Creation date ISO string / 创建日期 ISO 字符串。
   */
  created_at: string | null
  /**
   * Owner avatar, base64-encoded for embedding / 内嵌使用的 base64 头像。
   */
  avatarBase64: string
  /**
   * Radar chart SVG, base64-encoded for embedding; null hides the chart /
   * 内嵌使用的雷达图 SVG base64；null 时隐藏雷达图。
   */
  radarSvgBase64: string | null
  /**
   * Weekly metric percentiles (0–99) / 周度指标百分位（0–99）。
   */
  attributes: {
    stars: number
    new_stars: number
    pushes: number
    contributors: number
    issues_closed: number
    forks: number
  } | null
  /**
   * Global rank; falsy/0 hides the seal / 全球排名；0 或缺失时隐藏印章。
   */
  rank: number | null
  /**
   * star-history.com logo, base64-encoded / base64 编码的 star-history.com logo。
   */
  logoBase64: string
}

const LANG_COLORS: Record<string, string> = {
  'TypeScript': '#3178c6',
  'JavaScript': '#f1e05a',
  'Python': '#3572A5',
  'Go': '#00ADD8',
  'Rust': '#dea584',
  'Java': '#b07219',
  'C++': '#f34b7d',
  'C': '#555555',
  'C#': '#178600',
  'Ruby': '#701516',
  'PHP': '#4F5D95',
  'Swift': '#F05138',
  'Kotlin': '#A97BFF',
  'Dart': '#00B4AB',
  'Shell': '#89e051',
  'Lua': '#000080',
  'Scala': '#c22d40',
  'Elixir': '#6e4a7e',
  'Haskell': '#5e5086',
  'Zig': '#ec915c',
  'Vue': '#41b883',
  'HTML': '#e34c26',
  'CSS': '#563d7c',
  'R': '#198CE7',
  'Svelte': '#ff3e00',
  'MDX': '#fcb32c',
  'Nix': '#7e7eff',
  'OCaml': '#3be133',
}

/**
 * Compacts a number to a short string with K/M suffixes.
 *
 * 将数字紧凑格式化为带 K/M 后缀的短字符串。
 *
 * @param n - The number to format / 待格式化的数字
 * @returns Compact string (e.g. `1.2M`, `12.3k`, `42`) / 紧凑字符串（如 `1.2M`、`12.3k`、`42`）
 */
function fmt(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return n.toString()
}

/**
 * Formats an ISO date string like `Sep 2024`.
 *
 * 将 ISO 日期字符串格式化为 `Sep 2024` 形式。
 *
 * @param s - ISO date string / ISO 日期字符串
 * @returns Short month-year string / 简短的「月份 年份」字符串
 */
function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

const WOBBLY_PATH =
  'M10,3 C25,1 75,2 90,4 C96,9 98,25 97,50 C98,75 96,91 91,96 C75,98 25,99 9,96 C3,91 2,75 3,50 C2,25 4,9 10,3 Z'

const SEAL_LAYER_BASE = {
  position: 'absolute' as const,
  width: 160,
  height: 160,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
}

/**
 * Builds the engraved text layer of the rank seal; call twice — once for the
 * emboss highlight (offset/opacity), once for the dark stamped ink.
 *
 * 构建排名印章的压印文字层；通常调用两次——一次用于高光浮雕
 * （偏移/透明度），一次用于深色压印墨色。
 *
 * @param rank - Global rank shown as `#N` / 展示为 `#N` 的全球排名
 * @param date - Current date string shown under the rank / 排名下方展示的日期字符串
 * @param colors - Text colors for label/rank/date / 标签、排名、日期的文字颜色
 * @param offset - Layer offset in px / 图层偏移（像素）
 * @param opacity - Layer opacity (undefined = full opaque) / 图层透明度（不传则为不透明）
 * @returns An `h()` element tree for the layer / 该层的 `h()` 元素树
 */
function sealTextLayer(
  rank: number,
  date: string,
  colors: { label: string; rank: string; date: string },
  offset: { top: number; left: number },
  opacity?: number,
): any {
  return h(
    'div',
    {
      style: {
        ...SEAL_LAYER_BASE,
        top: offset.top,
        left: offset.left,
        ...(opacity != null ? { opacity } : {}),
      },
    },
    h(
      'span',
      {
        style: {
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: colors.label,
        },
      },
      'Global Rank',
    ),
    h(
      'span',
      {
        style: {
          fontSize: rank >= 10000 ? 32 : 42,
          fontWeight: 'bold',
          lineHeight: 1,
          color: colors.rank,
        },
      },
      `#${rank}`,
    ),
    h(
      'span',
      { style: { fontSize: 10, marginTop: 4, color: colors.date, letterSpacing: '0.05em' } },
      date,
    ),
  )
}

/**
 * Builds the full 1200×630 landscape1 OG card element tree.
 *
 * 构建完整的 1200×630 landscape1 分享卡元素树。
 *
 * @param data - Card data / 分享卡数据
 * @returns A plain `{ type, props }` tree consumable by satori or React /
 *   可被 satori 或 React 消费的纯 `{ type, props }` 元素树
 * @example
 * // Build the tree, then render it with satori:
 * const tree = buildLandscape1({ name: 'owner/repo', stars: 1234, forks: 56 })
 *
 * // satori(tree, { width: 1200, height: 630, fonts }) will then rasterize it.
 */
export function buildLandscape1(data: Landscape1Data): any {
  const [owner, repoName] = data.name.split('/')
  const langColor = data.language ? (LANG_COLORS[data.language] ?? '#6b7280') : null

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: 1200,
        height: 630,
        backgroundColor: 'white',
        fontFamily: 'xkcd',
        padding: '40px 48px',
        position: 'relative',
      },
    },

    // Gold-foil rosette rank seal (top-right)
    data.rank && data.rank > 0
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 10,
              right: 24,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: 160,
              height: 160,
              transform: 'rotate(-8deg)',
            },
          },
          // Rosette seal shape
          h(
            'svg',
            {
              viewBox: '0 0 160 160',
              width: 160,
              height: 160,
              style: { position: 'absolute', top: 0, left: 0 },
            },
            h(
              'defs',
              null,
              // Metallic gold body — light catches the upper left
              h(
                'radialGradient',
                { id: 'sh-seal-gold', cx: '38%', cy: '32%', r: '80%' },
                h('stop', { 'offset': '0%', 'stop-color': '#fdf4c2' }),
                h('stop', { 'offset': '32%', 'stop-color': '#f0d06a' }),
                h('stop', { 'offset': '62%', 'stop-color': '#d8a83c' }),
                h('stop', { 'offset': '86%', 'stop-color': '#b4832a' }),
                h('stop', { 'offset': '100%', 'stop-color': '#8a5f16' }),
              ),
              // Inner stamped disc — slightly deeper tone than the rim
              h(
                'radialGradient',
                { id: 'sh-seal-disc', cx: '40%', cy: '34%', r: '78%' },
                h('stop', { 'offset': '0%', 'stop-color': '#f7e49b' }),
                h('stop', { 'offset': '50%', 'stop-color': '#e0b84e' }),
                h('stop', { 'offset': '100%', 'stop-color': '#a87c1f' }),
              ),
              // Diagonal foil sheen
              h(
                'linearGradient',
                { id: 'sh-seal-sheen', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
                h('stop', { 'offset': '0%', 'stop-color': '#ffffff', 'stop-opacity': '0.6' }),
                h('stop', { 'offset': '35%', 'stop-color': '#ffffff', 'stop-opacity': '0.12' }),
                h('stop', { 'offset': '60%', 'stop-color': '#ffffff', 'stop-opacity': '0' }),
                h('stop', { 'offset': '100%', 'stop-color': '#5a3c0a', 'stop-opacity': '0.32' }),
              ),
              // Specular light streak across the foil
              h(
                'linearGradient',
                { id: 'sh-seal-streak', x1: '0%', y1: '100%', x2: '100%', y2: '0%' },
                h('stop', { 'offset': '38%', 'stop-color': '#ffffff', 'stop-opacity': '0' }),
                h('stop', { 'offset': '50%', 'stop-color': '#ffffff', 'stop-opacity': '0.28' }),
                h('stop', { 'offset': '62%', 'stop-color': '#ffffff', 'stop-opacity': '0' }),
              ),
              h(
                'clipPath',
                { id: 'sh-seal-clip' },
                h('path', { d: rosettePath(80, 80, 61, 6.5, 32) }),
              ),
              // Soft drop shadow
              h(
                'filter',
                { id: 'sh-seal-blur', x: '-15%', y: '-15%', width: '130%', height: '130%' },
                h('feGaussianBlur', { stdDeviation: '1.8' }),
              ),
              // Foil grain texture
              h(
                'filter',
                { id: 'sh-seal-grain', x: '-5%', y: '-5%', width: '110%', height: '110%' },
                h('feTurbulence', {
                  type: 'fractalNoise',
                  baseFrequency: '0.9',
                  numOctaves: '2',
                  result: 'n',
                }),
                h('feColorMatrix', {
                  in: 'n',
                  type: 'matrix',
                  values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0.6 0.6 0 0',
                }),
                h('feComposite', { operator: 'in', in2: 'SourceGraphic' }),
              ),
            ),
            // Shadow — soft offset
            h('path', {
              d: rosettePath(82.5, 84, 61, 6.5, 32),
              fill: '#3f2d0538',
              filter: 'url(#sh-seal-blur)',
            }),
            // Gold rosette body
            h('path', {
              'd': rosettePath(80, 80, 61, 6.5, 32),
              'fill': 'url(#sh-seal-gold)',
              'stroke': '#7a5a16',
              'stroke-width': '0.8',
              'opacity': '1',
            }),
            // Foil sheen overlay
            h('path', { d: rosettePath(80, 80, 61, 6.5, 32), fill: 'url(#sh-seal-sheen)' }),
            // Specular streak, clipped to the seal
            h('rect', {
              'x': '0',
              'y': '0',
              'width': '160',
              'height': '160',
              'fill': 'url(#sh-seal-streak)',
              'clip-path': 'url(#sh-seal-clip)',
            }),
            // Rim shading between scallops and milled ring for depth
            h('circle', {
              'cx': '80',
              'cy': '80',
              'r': '58',
              'fill': 'none',
              'stroke': '#7c5714',
              'stroke-width': '5',
              'opacity': '0.16',
            }),
            // Milled ring — engraved ticks with an embossed highlight twin
            h('circle', {
              'cx': '80',
              'cy': '80',
              'r': '55.5',
              'fill': 'none',
              'stroke': '#8a621a',
              'stroke-width': '2.2',
              'stroke-dasharray': '2 2.1',
              'opacity': '0.85',
            }),
            h('circle', {
              'cx': '80.6',
              'cy': '80.7',
              'r': '55.5',
              'fill': 'none',
              'stroke': '#fff3c0',
              'stroke-width': '0.8',
              'stroke-dasharray': '2 2.1',
              'opacity': '0.5',
            }),
            // Inner stamped disc with groove
            h('circle', {
              'cx': '80',
              'cy': '80',
              'r': '51',
              'fill': 'url(#sh-seal-disc)',
              'stroke': '#8a621a',
              'stroke-width': '1',
              'opacity': '1',
            }),
            h('circle', {
              'cx': '80',
              'cy': '80',
              'r': '49.5',
              'fill': 'none',
              'stroke': '#ffefad',
              'stroke-width': '1',
              'opacity': '0.5',
            }),
            // Grain texture across the whole seal
            h('path', {
              d: rosettePath(80, 80, 61, 6.5, 32),
              fill: '#6e4f12',
              filter: 'url(#sh-seal-grain)',
              opacity: '0.25',
            }),
          ),
          // Engraved text — light emboss highlight below, deep stamped ink on top
          ...(() => {
            const date = new Date().toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
            return [
              sealTextLayer(
                data.rank,
                date,
                { label: '#fff6cc', rank: '#fff6cc', date: '#fff6cc' },
                { top: 1.2, left: 1.2 },
                0.85,
              ),
              sealTextLayer(
                data.rank,
                date,
                { label: '#61430e', rank: '#43300a', date: '#5c3f0c' },
                { top: 0, left: 0 },
              ),
            ]
          })(),
        )
      : null,

    // Main content row: left info + right radar
    h(
      'div',
      { style: { display: 'flex', flex: 1, gap: 32 } },

      // Left column: avatar + info
      h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            justifyContent: 'center',
          },
        },

        // Name (full width, above avatar row)
        h(
          'div',
          {
            'data-repo-name': true,
            'style': {
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              fontSize: 34,
              fontWeight: 'bold',
            },
          },
          h('span', { style: { color: '#a3a3a3', fontWeight: 'normal' } }, owner),
          h('span', { style: { color: '#d4d4d4', margin: '0 5px' } }, '/'),
          h('span', { style: { color: '#171717' } }, repoName),
        ),

        // Avatar + description row
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', marginTop: 16 } },
          // Wobbly-framed avatar (fixed 140×140 square)
          h(
            'svg',
            {
              viewBox: '0 0 100 100',
              width: 140,
              height: 140,
              style: { flexShrink: 0 },
            },
            h(
              'defs',
              null,
              h(
                'clipPath',
                { id: 'wobbly-clip' },
                h('path', {
                  d: WOBBLY_PATH,
                }),
              ),
            ),
            h('image', {
              'href': data.avatarBase64,
              'x': '0',
              'y': '0',
              'width': '100',
              'height': '100',
              'preserveAspectRatio': 'xMidYMid slice',
              'clip-path': 'url(#wobbly-clip)',
            }),
            h('path', {
              'd': WOBBLY_PATH,
              'fill': 'none',
              'stroke': '#525252',
              'stroke-width': '1.2',
              'stroke-linecap': 'round',
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', marginLeft: 24, flex: 1 } },
            // Description
            data.description
              ? h(
                  'span',
                  { style: { fontSize: 20, color: '#525252', lineHeight: 1.5 } },
                  data.description.length > 120
                    ? `${data.description.slice(0, 117)}...`
                    : data.description,
                )
              : null,
            // Meta: language · license · since
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  marginTop: 14,
                  fontSize: 18,
                  color: '#737373',
                },
              },
              data.language
                ? h(
                    'span',
                    { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                    langColor
                      ? h('span', {
                          style: {
                            width: 11,
                            height: 11,
                            borderRadius: 6,
                            backgroundColor: langColor,
                          },
                        })
                      : null,
                    data.language,
                  )
                : null,
              data.license ? h('span', {}, data.license) : null,
              data.created_at
                ? h('span', { style: { color: '#a3a3a3' } }, `since ${fmtDate(data.created_at)}`)
                : null,
            ),
          ),
        ),

        // Stats: absolute numbers
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 24, marginTop: 60 } },
          h(
            'div',
            {
              title: `Stars: ${data.stars.toLocaleString()}${data.attributes ? ` · Top ${100 - data.attributes.stars}%` : ''}`,
              style: { display: 'flex', alignItems: 'center', gap: 8 },
            },
            h(
              'svg',
              { viewBox: '0 0 24 24', width: 24, height: 24 },
              h('path', {
                'd': 'M12 2L14.9 8.6L22 9.3L16.8 14L18.2 21L12 17.3L5.8 21L7.2 14L2 9.3L9.1 8.6Z',
                'fill': '#facc15',
                'stroke': '#a3a3a3',
                'stroke-width': '1.2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
              }),
            ),
            h(
              'span',
              { style: { fontSize: 36, fontWeight: 'bold', color: '#171717' } },
              fmt(data.stars),
            ),
          ),
          h(
            'div',
            {
              title: `Forks: ${data.forks.toLocaleString()}${data.attributes ? ` · Top ${100 - data.attributes.forks}%` : ''}`,
              style: { display: 'flex', alignItems: 'center', gap: 8 },
            },
            h(
              'svg',
              { viewBox: '0 0 32 24', width: 30, height: 24 },
              // Fork: tines
              h('path', {
                'd': 'M3 2V10',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              h('path', {
                'd': 'M7 2V10',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              h('path', {
                'd': 'M11 2V10',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              h('path', {
                'd': 'M15 2V10',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              // Fork: neck
              h('path', {
                'd': 'M3 10C3 13 5 14 9 14C13 14 15 13 15 10',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              // Fork: handle
              h('path', {
                'd': 'M9 14V22',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.8',
                'stroke-linecap': 'round',
              }),
              // Knife: blade
              h('path', {
                'd': 'M22 2C22 2 25 3 25 8C25 11 24 13 23 14',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
              }),
              h('path', {
                'd': 'M22 2V14',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.4',
                'stroke-linecap': 'round',
              }),
              // Knife: handle
              h('path', {
                'd': 'M22 14V22',
                'fill': 'none',
                'stroke': '#a3a3a3',
                'stroke-width': '1.8',
                'stroke-linecap': 'round',
              }),
            ),
            h(
              'span',
              { style: { fontSize: 36, fontWeight: 'bold', color: '#525252' } },
              fmt(data.forks),
            ),
          ),
          data.attributes
            ? h(
                'div',
                {
                  title: `Contributors: ${data.attributes.contributors} · Top ${100 - data.attributes.contributors}%`,
                  style: { display: 'flex', alignItems: 'center', gap: 8 },
                },
                h(
                  'svg',
                  { viewBox: '0 0 32 24', width: 30, height: 24 },
                  // Left person: head + body
                  h('circle', {
                    'cx': '7',
                    'cy': '6',
                    'r': '3.5',
                    'fill': 'none',
                    'stroke': '#a3a3a3',
                    'stroke-width': '1.3',
                  }),
                  h('path', {
                    'd': 'M1 22C1 17 3.5 14 7 14C10.5 14 13 17 13 22',
                    'fill': 'none',
                    'stroke': '#a3a3a3',
                    'stroke-width': '1.3',
                    'stroke-linecap': 'round',
                  }),
                  // Right person: head + body (slightly behind)
                  h('circle', {
                    'cx': '22',
                    'cy': '6',
                    'r': '3.5',
                    'fill': 'none',
                    'stroke': '#a3a3a3',
                    'stroke-width': '1.3',
                  }),
                  h('path', {
                    'd': 'M16 22C16 17 18.5 14 22 14C25.5 14 28 17 28 22',
                    'fill': 'none',
                    'stroke': '#a3a3a3',
                    'stroke-width': '1.3',
                    'stroke-linecap': 'round',
                  }),
                ),
                h(
                  'span',
                  { style: { fontSize: 36, fontWeight: 'bold', color: '#525252' } },
                  String(data.attributes.contributors),
                ),
              )
            : null,
        ),

        // Stats: weekly numbers
        data.attributes
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  marginTop: 14,
                  paddingTop: 14,
                  borderTop: '1.5px solid #f0f0f0',
                },
              },
              h(
                'span',
                {
                  style: {
                    fontSize: 16,
                    color: '#a3a3a3',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  },
                },
                'Weekly',
              ),
              h(
                'div',
                {
                  title: `New stars: ${data.attributes.new_stars} · Top ${100 - data.attributes.new_stars}%`,
                  style: { display: 'flex', alignItems: 'baseline', gap: 5 },
                },
                h(
                  'span',
                  { style: { fontSize: 34, fontWeight: 'bold', color: '#525252' } },
                  String(data.attributes.new_stars),
                ),
                h('span', { style: { fontSize: 15, color: '#a3a3a3' } }, 'stars'),
              ),
              h('span', { style: { fontSize: 14, color: '#d4d4d4' } }, '\u00B7'),
              h(
                'div',
                {
                  title: `Pushes: ${data.attributes.pushes} · Top ${100 - data.attributes.pushes}%`,
                  style: { display: 'flex', alignItems: 'baseline', gap: 5 },
                },
                h(
                  'span',
                  { style: { fontSize: 34, fontWeight: 'bold', color: '#525252' } },
                  String(data.attributes.pushes),
                ),
                h('span', { style: { fontSize: 15, color: '#a3a3a3' } }, 'pushes'),
              ),
              h('span', { style: { fontSize: 14, color: '#d4d4d4' } }, '\u00B7'),
              h(
                'div',
                {
                  title: `Issues closed: ${data.attributes.issues_closed} · Top ${100 - data.attributes.issues_closed}%`,
                  style: { display: 'flex', alignItems: 'baseline', gap: 5 },
                },
                h(
                  'span',
                  { style: { fontSize: 34, fontWeight: 'bold', color: '#525252' } },
                  String(data.attributes.issues_closed),
                ),
                h('span', { style: { fontSize: 15, color: '#a3a3a3' } }, 'issues closed'),
              ),
            )
          : null,
      ),

      // Right column: radar chart
      data.radarSvgBase64
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 580,
                flexShrink: 0,
              },
            },
            h('img', {
              src: data.radarSvgBase64,
              width: 560,
              height: 560,
            }),
          )
        : null,
    ),

    // Branding footer (pinned bottom-right)
    h(
      'div',
      {
        style: {
          position: 'absolute',
          bottom: 20,
          right: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        },
      },
      h('img', { src: data.logoBase64, width: 24, height: 24, style: { opacity: 0.6 } }),
      h(
        'span',
        { style: { fontSize: 19, color: '#b5b5b5', letterSpacing: '0.02em' } },
        'star-history.com',
      ),
    ),
  )
}
