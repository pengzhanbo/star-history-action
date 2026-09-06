# star-history-action

[English](README.md) | 简体中文

一个 GitHub Action，用于获取仓库的 star 历史，并将 xkcd 风格的 SVG 图表提交回仓库。

以下是生成的图表示例：

<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="assets/example/star-history-dark.svg"
  >
  <img
    alt="Star History"
    src="assets/example/star-history-light.svg"
  >
</picture>

## 快速开始

在需要追踪的仓库中添加工作流。以下示例会每天刷新图表，并在每次推送到 `main` 时刷新：

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

> [!NOTE]
> 若要绘制运行工作流的仓库本身，可以省略 `repo` —— 它默认取当前仓库（`${{ github.repository }}`）。

## 定时更新

该 action 通常由 `schedule` 事件驱动。可以配置任意 cron 表达式：

| 频率 | Cron 表达式 | 含义            |
| ---- | ----------- | --------------- |
| 每天 | `0 0 * * *` | 每天 00:00      |
| 每周 | `0 0 * * 1` | 每周一 00:00    |
| 每月 | `0 0 1 * *` | 每月 1 日 00:00 |

```yaml
on:
  schedule:
    - cron: '0 0 * * 1' # 每周，周一
```

定时任务使用 [UTC](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule) 时间，
请按你的时区调整小时。建议始终保留 `workflow_dispatch` 以便手动触发刷新。

在触发列表中加上 `push`，可以在每次提交时保持图表最新：

```yaml
on:
  schedule:
    - cron: '0 0 * * *'
  push:
    branches: [main]
  workflow_dispatch:
```

## 对比多个仓库

向 `repo` 传入多个逗号/空格分隔的 `owner/repo`，即可在同一坐标系中为每个仓库绘制一条折线：

```yaml
with:
  repo: vuejs/core, facebook/react, sveltejs/svelte
```

> [!IMPORTANT]
> 多仓库（以及私有仓库）追踪需要 **Personal Access Token（PAT）**，而不是默认的 `${{ github.token }}`。
> 自动生成的 `github.token` 只能访问运行工作流的仓库，无法读取其他仓库的数据。

创建一个 fine-grained PAT（`Settings → Developer settings → Personal access tokens`），
对要绘制的仓库授予 **只读** 权限，然后将其保存为 Actions secret：

```yaml
with:
  repo: vuejs/core, facebook/react, sveltejs/svelte
  token: ${{ secrets.GH_TOKEN }}
```

## 输入参数

| 名称               | 必填 | 默认值                     | 说明                                                                                                                                     |
| ------------------ | ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`             | 否   | `${{ github.repository }}` | 要绘制图表的仓库，例如 `pengzhanbo/star-history-action`。用逗号/空格分隔（如 `a/repo1, b/repo2`）可在一张图中对比多个仓库。              |
| `token`            | 否   | `${{ github.token }}`      | 对目标仓库具有读取权限的 GitHub token。多仓库/私有仓库请使用 PAT。                                                                       |
| `output-directory` | 否   | `assets`                   | 图表的输出目录，相对于工作区根目录。                                                                                                     |
| `output-filename`  | 否   | `star-history.svg`         | 输出文件名。缺失或未知的扩展名（识别 `.svg`/`.png`/`.json`）会根据 `output-format` 列表自动补全。配置双主题时会追加 `-light`/`-dark`。   |
| `svg-width`        | 否   | `960`                      | 生成的 SVG 宽度（像素）；高度为宽度的 2/3。                                                                                              |
| `theme`            | 否   | `light`                    | 图表主题：`light`、`dark`，或用逗号/空格分隔的 `light, dark` 以同时输出两种主题。                                                        |
| `output-format`    | 否   | `svg`                      | 输出格式：`svg`、`png`（由 SVG 栅格化）、`json`（结构化记录数据），或任意组合（如 `svg,png,json`）。                                     |
| `radar`            | 否   | `false`                    | 是否同时为每个仓库渲染一份雷达图，展示仓库健康指标（stars、new stars、pushes、contributors、issues closed、forks），各项均按 0–99 计分。 |
| `cache`            | 否   | `false`                    | 增量抓取：读取上一次运行的 `<stem>.cache.json` 作为基线，只抓取自基线以来新增的 stargazer，大幅降低大历史仓库的 API 配额消耗。           |

## 速率限制

该 action 通过 GitHub REST API 读取数据，而 GitHub 对每小时请求数有限制：

| 认证方式                          | 主速率限制                |
| --------------------------------- | ------------------------- |
| 未认证                            | 60 次 / 小时（按 IP）     |
| Personal access token（PAT）      | 5,000 次 / 小时           |
| Actions 自动生成的 `github.token` | 1,000 次 / 小时（每仓库） |

每次运行的请求量：每个仓库最多抓取 **15 页**（约 1,500 颗 star），更大的仓库会采样，因此请求数保持平稳。
`radar: true` 每仓库约增加 4 次请求；`cache: true` 会让后续运行只抓取自上次运行以来的最新页面。
使用 PAT + 每周调度时，单次运行仅消耗每小时配额的极小一部分。action 会对 `403`/`429` 限流响应退避重试，
若重置时间临近会等待至多一分钟。

## 特性

- **多仓库对比** —— 一张图、每个仓库一条折线，并带有按仓库区分的图例（同 owner 时显示头像）。
- **增量抓取** —— `cache: true` 时，后续运行只抓取上次运行之后新增的 stargazer；无新增时跳过提交，重复运行保持幂等。
- **输出格式** —— `svg`（默认）、`png`（由 SVG 栅格化并内嵌 xkcd 字体）、`json`（结构化 `{ date, stars }` 记录，便于下游工具使用），可任意组合。
- **企业版支持** —— 支持 `GITHUB_API_URL`，GitHub Enterprise 实例同样可用。
- **部分成功** —— 对比多个仓库时，某个仓库抓取失败只会以 warning 跳过，而不会导致整个运行失败。
- **提交与推送** —— 图表以 `github-actions[bot]` 身份提交并推送到当前分支；`pull_request` 事件中完全跳过写回。

## 在 README 中嵌入图表

生成的 SVG 是独立的——xkcd 字体已内联——因此它可以在任何地方渲染，包括你自己仓库的 GitHub README。

**单主题**：使用相对于仓库根目录的路径引用图表：

```markdown
![Star History](assets/star-history.svg)
```

**双主题**（`theme: light, dark`）：action 会写入两个文件——`star-history-light.svg` 和 `star-history-dark.svg`。使用 `<picture>` 元素，根据访客的配色方案自动切换图表：

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

注意事项：

- 如果修改了 `output-directory` 或 `output-filename`，请相应调整路径。
- 工作流会提交并推送图表，因此运行完成后图片即会更新。
- 如果 README 位于子目录中，请在相对路径前添加 `../`。

## 许可证

MIT
