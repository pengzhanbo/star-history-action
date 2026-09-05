import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getInput, info, setFailed } from "@actions/core";
import { execFileSync, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { optimize } from "svgo";
import { isInteger, promiseParallel, range, uniq, withTimeout } from "@pengzhanbo/utils";
import { scaleLinear, scaleSymlog, scaleTime } from "d3-scale";
import { select } from "d3-selection";
import { curveMonotoneX, line } from "d3-shape";
import dayjs from "dayjs";
import { axisBottom, axisLeft } from "d3-axis";
import duration from "dayjs/plugin/duration.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import imagemin from "imagemin";
import imageminJpegtran from "imagemin-jpegtran";
import imageminPngquant from "imagemin-pngquant";
//#region src/common/constants.ts
const REQUEST_TIMEOUT_MS = 15e3;
const REPO_INFO_ACCEPT = "application/vnd.github+json";
const STARGAZERS_ACCEPT = "application/vnd.github.v3.star+json";
//#endregion
//#region src/env.ts
/**
* Base URL of the GitHub API; honoring `GITHUB_API_URL` also supports
* GitHub Enterprise Server instances.
*
* GitHub API 的基础 URL；识别 `GITHUB_API_URL` 同时也兼容 GitHub
* Enterprise Server 实例。
*/
const GITHUB_API_URL = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
/**
* The current repository in `owner/repo` form; empty on local runs.
*
* 当前仓库的 `owner/repo` 标识；本地运行时为空字符串。
*/
const GITHUB_REPOSITORY = process.env["GITHUB_REPOSITORY"] ?? "";
/**
* Base URL of the GitHub server, used to build the authenticated push URL.
*
* GitHub 服务器的基础 URL，用于构造带认证的推送地址。
*/
const GITHUB_SERVER_URL = process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
/**
* Name of the event that triggered the workflow (e.g. `push`, `pull_request`).
*
* 触发工作流的事件名称（例如 `push`、`pull_request`）。
*/
const GITHUB_EVENT_NAME = process.env["GITHUB_EVENT_NAME"] ?? "";
/**
* Head ref (source branch) of a pull request; empty outside PR events.
*
* 拉取请求的源分支引用；非 PR 事件时为空字符串。
*/
const GITHUB_HEAD_REF = process.env["GITHUB_HEAD_REF"] ?? "";
/**
* Name of the branch or tag the run is based on.
*
* 运行所基于的分支或标签名称。
*/
const GITHUB_REF_NAME = process.env["GITHUB_REF_NAME"] ?? "";
/**
* Absolute path of the checked-out repository on the runner; empty on local runs.
*
* runner 上检出仓库的绝对路径；本地运行时为空字符串。
*/
const GITHUB_WORKSPACE = process.env["GITHUB_WORKSPACE"] ?? "";
//#endregion
//#region src/config.ts
/**
* Chart themes supported by the action.
*
* 动作支持的图表主题。
*/
const THEMES = ["light", "dark"];
/**
* Type guard narrowing a string to a known chart theme.
*
* 将字符串收窄为已知图表主题的类型守卫。
*
* @param value - Theme string to validate / 待校验的主题字符串
* @returns True when the value is `light` or `dark` / 当值为 `light` 或 `dark` 时为真
*/
function isTheme(value) {
	return THEMES.includes(value);
}
/**
* Reads and validates all action inputs from the runner environment.
*
* 从 runner 环境中读取并校验全部动作输入。
*
* @returns The parsed and validated configuration / 解析并校验后的配置
* @throws {Error} When a required input is missing or a value is invalid / 当必填输入缺失或取值非法时抛出错误
* @example
* // On a GitHub runner, inputs arrive as INPUT_* env vars.
* const config = parseInputs()
*/
function parseInputs() {
	const repo = getInput("repo") || GITHUB_REPOSITORY;
	if (!repo) throw new Error("repo input is required");
	const token = getInput("token");
	if (!token) throw new Error("token input is required");
	const outputDirectory = getInput("output-directory") || "assets";
	if (isAbsolute(outputDirectory)) throw new Error(`output-directory must be a relative path, got "${outputDirectory}"`);
	const outputFilename = getInput("output-filename") || "star-history.svg";
	if (outputFilename.length === 0 || outputFilename.includes("/") || outputFilename.includes("\\")) throw new Error(`output-filename must be a file name without path separators, got "${outputFilename}"`);
	if (!/\.svg$/i.test(outputFilename)) throw new Error(`output-filename must end with .svg, got "${outputFilename}"`);
	const rawWidth = getInput("svg-width") || "960";
	const svgWidth = Number(rawWidth);
	if (!Number.isInteger(svgWidth) || svgWidth < 1) throw new Error(`svg-width must be a positive integer, got "${rawWidth}"`);
	const themes = [];
	const rawTheme = getInput("theme");
	if (rawTheme) for (const value of rawTheme.split(/[,，\s]+/)) {
		const theme = value.trim().toLowerCase();
		if (!theme) continue;
		if (!isTheme(theme)) throw new Error(`theme "${value}" is invalid; use light, dark, or light, dark`);
		if (!themes.includes(theme)) themes.push(theme);
	}
	if (themes.length === 0) themes.push("light");
	return {
		repo,
		token,
		outputDirectory,
		outputFilename,
		svgWidth,
		themes
	};
}
/**
* Maps the requested themes to concrete chart file names.
*
* 将请求的主题映射为具体的图表文件名。
*
* @param config - Parsed action inputs / 解析后的动作输入
* @returns One entry per theme: single-theme runs keep the input filename;
*   multi-theme runs derive `-light`/`-dark` variants /
*   每个主题一个条目：单主题运行保留输入文件名；多主题运行派生
*   `-light`/`-dark` 变体
* @example
* getChartFilePaths({ ...themes: ['light', 'dark'], outputFilename: 'chart.svg' })
* // [{ theme: 'light', file: 'chart-light.svg' }, { theme: 'dark', file: 'chart-dark.svg' }]
*/
function getChartFilePaths(config) {
	if (config.themes.length === 1) return [{
		theme: config.themes[0],
		file: config.outputFilename
	}];
	const i = config.outputFilename.lastIndexOf(".");
	const ext = i > 0 ? config.outputFilename.slice(i) : ".svg";
	const stem = i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename;
	return [{
		theme: "light",
		file: `${stem}-light${ext}`
	}, {
		theme: "dark",
		file: `${stem}-dark${ext}`
	}];
}
//#endregion
//#region src/git.ts
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
function runGit(cwd, args) {
	try {
		return execFileSync("git", args, {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		}).toString();
	} catch (error) {
		const stderr = error.stderr?.toString() ?? "";
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`);
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
function commitAndPush({ cwd, files, token }) {
	if (GITHUB_EVENT_NAME === "pull_request") {
		info("pull_request context: skipping commit and push");
		return;
	}
	runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	runGit(cwd, [
		"add",
		"--",
		...files
	]);
	const diffCheck = spawnSync("git", [
		"diff",
		"--cached",
		"--quiet"
	], {
		cwd,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	if (diffCheck.status === 0) {
		info("no chart changes; skipping commit and push");
		return;
	}
	if (diffCheck.status !== 1) {
		const stderr = diffCheck.stderr?.toString() ?? "";
		throw new Error(`git diff --cached --quiet failed: ${stderr.trim()}`);
	}
	runGit(cwd, [
		"-c",
		"user.name=github-actions[bot]",
		"-c",
		"user.email=41898282+github-actions[bot]@users.noreply.github.com",
		"commit",
		"-m",
		"chore: update star history chart"
	]);
	if (GITHUB_REPOSITORY) {
		const host = new URL(GITHUB_SERVER_URL).host;
		runGit(cwd, [
			"push",
			`https://x-access-token:${encodeURIComponent(token)}@${host}/${GITHUB_REPOSITORY}.git`,
			`HEAD:refs/heads/${GITHUB_HEAD_REF || GITHUB_REF_NAME || "main"}`
		]);
	} else runGit(cwd, [
		"push",
		"origin",
		"HEAD"
	]);
}
//#endregion
//#region src/common/colors.ts
/**
* 20-entry color palette for light-theme datasets.
*
* 浅色主题数据集的 20 色调色板。
*/
const colors = [
	"#dd4528",
	"#28a3dd",
	"#f3db52",
	"#ed84b5",
	"#4ab74e",
	"#9179c0",
	"#8e6d5a",
	"#f19839",
	"#949494",
	"#1a9988",
	"#c75dab",
	"#6a8e2f",
	"#d4583b",
	"#3767b0",
	"#e8a735",
	"#7c4dff",
	"#00897b",
	"#c2185b",
	"#5c6bc0",
	"#e67e22"
];
/**
* 20-entry color palette for dark-theme datasets.
*
* 深色主题数据集的 20 色调色板。
*/
const darkColors = [
	"#ff6b6b",
	"#48dbfb",
	"#feca57",
	"#ff9ff3",
	"#1dd1a1",
	"#f368e0",
	"#ff9f43",
	"#a4b0be",
	"#576574",
	"#00d2d3",
	"#f78fb3",
	"#badc58",
	"#ff7979",
	"#7ed6df",
	"#f9ca24",
	"#b388ff",
	"#4dd0e1",
	"#ff80ab",
	"#9fa8da",
	"#f5b041"
];
//#endregion
//#region src/charts/add-filter.ts
/**
* Injects the `xkcdify` wobble filter (feTurbulence + feDisplacementMap).
*
* Must run before any element references `url(#xkcdify)`.
*
* 注入 `xkcdify` 抖动滤镜（feTurbulence + feDisplacementMap）。
*
* 必须早于任何引用 `url(#xkcdify)` 的元素执行。
*
* @param selection - Root selection to append the `<filter>` into /
*   要追加 `<filter>` 的根 selection
*/
function addFilter(selection) {
	selection.append("filter").attr("id", "xkcdify").attr("filterUnits", "userSpaceOnUse").attr("x", -5).attr("y", -5).attr("width", "100%").attr("height", "100%").call((f) => {
		f.append("feTurbulence").attr("type", "fractalNoise").attr("baseFrequency", "0.05").attr("result", "noise");
		f.append("feDisplacementMap").attr("scale", "5").attr("xChannelSelector", "R").attr("yChannelSelector", "G").attr("in", "SourceGraphic").attr("in2", "noise");
	});
}
//#endregion
//#region src/common/fonts.ts
/**
* The xkcd font, inlined as a base64 woff data URL.
*
* Embedded so every generated SVG renders standalone without external fetches.
*
* xkcd 字体，以内联 base64 woff data URL 形式提供。
*
* 内嵌以保证生成的每个 SVG 都可以独立渲染，无需发起外部资源请求。
*/
const xkcdFontUrl = "data:application/font-woff;charset=utf-8;base64,d09GRk9UVE8AAJx4AAsAAAAAxwwAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAABDRkYgAAAFGAAAlcwAAL0RC0F+QkZGVE0AAJsAAAAAGgAAABw+UK5QR0RFRgAAmuQAAAAcAAAAHgAnAJFPUy8yAAABZAAAAFUAAABgWJzhv2NtYXAAAAM4AAABywAAAyqDxHFiaGVhZAAAAQgAAAAxAAAANsz4KqBoaGVhAAABPAAAAB4AAAAkCEQESmhtdHgAAJscAAABXAAAAiwGQwpzbWF4cAAAAVwAAAAGAAAABgCLUABuYW1lAAABvAAAAXkAAALBbi7owXBvc3QAAAUEAAAAEwAAACD/gwAzeJxjYGRgYADiynnODfH8Nl8ZuJkjgCIMWyZ9YYDTwv++sSxgDgVyORiYQKIAPLQLYwAAAHicY2BkYGAO/feNwZflBAMQsCxgYGRABd0AbW8ElwAAAABQAACLAAB4nGNgZlzLOIGBlYGBSYcpnIGBoRxCM85i0GK4y8DAzMDKzAAGDQwM7UwMDA4MUBCQ5poCpBT+/2eK+M/A4MscysgF5DOC5BjXMgUwKAAhIwBQMwyLAAAAeJyNkE1OAkEQhV8D/hs3GuOyVwYTBjSewMzCDWEhCfuhaaADTJOexsjaA3gTt17B6Dm8gCfwTdMo0Y1MQn1Vr6rrB8ARniGw+g3wFlngQNxGrmBHqMhVxh8j13AsXiJv4VB8RN7GfmWXmaK2R+81VJUscCpakSs4Et3IVcYnkWs4F0+Rt3Am3iNv40R8IoXFHEs4GIwwhodEHQoXtCYonlGLHC08YEJlgATDEClzVaSyvo8FyZILNKilJI2MMYN7kgzdZvzKmoL+DbXNWhOUBJ1g19maGYpahilrrtHEJW2bEUWtfEkDqZ0vnRmNvayrC2nmSz+2eethogbJ0OZeKv45019464qGTJ3OvLnXMrWzmc0LeeNXqrF50rF5GdZOmWwqr5uXsm2Uzgt2WZ9Aokvrwok8w2wju8qZOZ07jjPiOlMO7Ojq0WKauf/V/px4Myf5/WZYa1WTfL/fC4cq4hElruKh0NOu4F7yipv8tPgzRJzhC2aqiNgAAAB4nI3RW08TQRgG4HdpOYggUBHb0uo4nNSWgwfkoBVBhXLSgoooAuVQjED4CSCnBLjzksQ7Em4Jl/4AErjlGjbwGyThBjK8u7MEDWCc5Nmv8+10951ZAMkAXBQmNx3A4BVJhewadt+FdLvvxqY9F/yVgX5MYhXr2MAWtrGDQ8NjxFwrwieCIiL9MiSjMi4Tckwp/ktg4MLVXhH4Y/WwHFVK7as99UutqZ9qWf1QC2pCdav8o10r1V7YTJhdZq1ZYIrdY530wpGLvHO9JSxiHCPMzmFUOF2vnQ7cD+znDdAk1dOqw7q37ojThsNau+UYpG3HEO04hunQkeArPBpGWWMaxvgJVjR8ZxyvxsQQPo3ZIQIadwER1LgfiIiGb4D0a5hiDWmYZo1qmGGNa5hlZT7JXJhjZSbJLPgK4/eMDVhgxhT846j1MJJc7uSU1LQr6VczMq9lZed4rufeyLvp9fnzA8Fbt8UdWVBYVFxy9979ULi0rLziwcNHjyufVFXX1D59Fnle9wL1DS9fvW5sija3tLa1v3kb6+h89/5D18fuT597vvT2WWc9qA/zP8as9Z3m5vVk+rQ7Ze39bIyPLC0mLn/G0N/TE5rzdrgAeJxjYGYAg/8NDMYMWAAAKBQBtgB4nDx8CYBkVXlutWPDiZpRp+2X5CUCmmhMosY9xriAiIKgICr70MzSM9PTe3d111516+5nvXvtW+/brDDADLuggKKRTYEBFWNekpdoFvN81b7OS95/irxUTfdUd1Xduvec//+W//yn+2Kvf32sr6/vjcnRAwe/emBmZCoe63tdrC924/YnY9uf6tv+9Ou2P7Nr+7dff9FPX7f8H2/addFXFv/jTa+/6A2xtx55539Q+l8P3nRha6f9e69f+PXf9789Fnvdm98M32Oxt8D3XX/wVvn4A/DtAXVP7F3y4Cj25th/i7099sex98U+EPt87KrYNbFrY1+L3Ri7JbY3dkfsQOxQbCQ2FpuMzcTmYtlYMYZjYawRW4mdjj0Q+2bsO7Hv9X2w73N9185NjHzoQx+77LX/Piv/+8CHP3fF+L4DM5MT1x6Zmzi8b2ZufGzfXPzA0OTk0ORVQ0dSU0eGJ4amhmaGJocm4GtuaOKKocsuH7r28qHrrx26fOjKK4au+NrQ164Z+uwVQ9dfP3T9NUOXXTN0zbVDX7586LLrhr76taFrZ/YdHDmwb+yrI4fH941MxIcPz+wb2zc1NTOZHJ6e2zc2MRnv/T82PDvbe3B4ZnhffHim93j/vpmh//xZPj8EP8998PMf/viHPvj+D1w+OZWaGTl8JH7Jew780SUjU6n4kcmJP5Xz8r5DkxPxSw7At5mR/XPxyZnZ915yuTzKyPzwJZdPjo9PTsxecln8tWdHJife9+XJCfnr4ZkDI/vGLvnw+z9wyTUjB4YnZod7R3ttmt93/fDhubF9M/JXl/znzMOtL/a62K7Y62P9sQtiF8aOxH4j9obYG2Nviv1mbDdM2ltib43tiQ3E3hYbhAn8rdhvx34n9t9jvxv7PZjMi2IXxy6JvSP2ztjvx/4g9q7Yu2N/GHtP7I9gkv8k9l6Y6PfH/hQm+4OxD8U+HPtI7KOxj8X+LPbx2J/HPhH7i9gnY5+KfTr2mdilsc/GLo99LnYFBMUXYldCYHwxdjUEx5diX4YAuS72ldj1sa9CoHw9dgMEy02xmyFgbo3dBkFze2wo1oEQORm7M/ZQ7LFYO5bos/rsPtxH+mhspI/18T7R5/S5fV6f3xf0hX1RX6mv3Ffpq/bV+up9jb5mX6uv3dfpW+hb7FvqW+5b6VvtW4NQvSxGZczuggF5vG9uF7vg9y984Tdu+I0H3jD+xve9qf2b2m/+y+4bdp9587m3Drz14MAlb8ODZ37ra789+zvp/779e+/+vb98+3MX8Yv1Sz71Dvb7Y3+gv/vGP5x4z11//LY/6Xtv+X1b73vy/c//6f/6QP1Df/Lhz3/kwEdbf/auj9/75//3E+f+4gef/NdPK59xLt132eHPTlyufc684tor7v78v1z5m1f+3y/uuvqt17z9S9/88qPXWl/54vWzX33v1/Z//aYbbr5x+eY33Hz3LU/d+tJt5/YWb39m6Bf7bt3/y4PewROH3nnonw5/f+TS0bePKeM/nvzc1JHp52Y/Hl+ff3fipdR9mWtzuwpvV/Lahw1qX0VfEDX3j/xM9JXK9bVP11eb/95542Jn+aaVq9dm1s9vXr4VP0aOt068cGrPvcP3Pn72c3O7d27YvdO494UvvDKg/GD7lcHDCraCo1zlo0JDA5cKg16Ld/rxR1je01x9PR+ygAUudSgXnLPI4w5tI3oneYG9jAYU+g/MyJ012qavOcgQNk0ZaP3ftEFCMSecCIvpVKWYZgrJnGUWk1oGz3lJL+mrLkWMurZje5YgFVqGT3AdweEfFTQKo3JQqpftBsJVXFZD07UFHJOml22Kdu9c13nlM+cHYt2P/vq6wSnVs42EmYd35rhCbP2r2tVkwteQZ/R7etledhpCiNBHzQtpzTnrf4P53GeMcxJxJvjc44aHdF+jcxraebMyaNu2QSwYCZy1U3QerpEcwioewjfzYkNxbU7roiUCEpRcn3J2D7ySLbNjrMmXaYQjq+OHuYrpYjpP5yilhoF2v/Kv35195Znn93S//sS1T9XPD8S3/6D7rkGPNlmDbcGweiXHJ8etQK/a7AhN0zlShLtGKEWElV9ljIq/1NdqZS+o6FXsYpdy6pohpvAKGGOEA41N4zzJEoMi5QJe5WV3vfJT6owHKO1qZn9O1UeNuD5BSvowMkZncX+eFIhNihZlrIIGjjGfdXjTucdOkNPkJK5aMDGYpagiJ49YRFOogaiNFaxYCWvUStk5+yZsEWxilejEJHAqcDxMkUkz1pyhwYjZ1KKqlS0WNEUj8mZQgxQZCRQU5j275JVcx647NfFQ4FCP5v8U3qNyetictHx7zkQpy7A11dApYQrPCj0yGoW7wkWGKqwfF2gBT+Mjdsoy4cgmNalGia87lmPCqWBh+yaCa4CwiqgHk82YjN6AOx6P3A4P4YnQ/ykNEHXu9xx4nlK4TJvOkmmyl2DHCLOhXiIR8XDgIc9teMLnHg0xt4XzcwcO6TCI4DINnApFO+h7gxQftXSSsTFhgnHqQ5QtwMUtI7G4zPqrrMI5hDglMFxW/hPUQruD1kt7um+9b//qo984fPbo3Q+/PPBo96rtfxy0DDNBkiSDTZsadFY1LMu2SW+ICYO7BU8gxRCWBrfkKFaIaSTglRhmgNiY3+BkRD7MBiqCk7XlcLTzApKqVXTgpJiN5+A+YSWwwlK2iuTsFUtKWQ+LLUhGH3PL1apwrr7J00baNBnJIDtuB9GYm3PyHHMMaW2H8ROHF7OoorIj/WyWKhyjgUVGuAFzkWesjEPCqOOige+EFVHjW6i1eOFS2UtdTDXHdlRXCUxeYDpgAGngYtsrccEC0iSLFDAAcbgxCPPQWa94InQ9txJtHKcuZfCs45eqZ0QHiRZ5DDesZWUp1VajVEV1UoArMzgJIcEc7oktUkIkatr9j2iClxb9OmPYt0OjlzqYyskcCgoUDTyuUMJZXZwkTsbJCQyAYmsYwhbbLGvCS3UGqVWkZKWfdogvh4kwjSGNwaCb6NzORwdp3MjSOLVtbNhINflaP1tzynQBRcGFPfgkApt5WkSf2z9o30JNC9LDcqzQdokPONBmImj6db8kADSs/SSLupe+d9AxhSXnnRVZgR+yx7UZM01wNqsoqq4BSPkFg5b7yZPsfghhh30TBsgPnRavcccu5dDOhTvvG6QzdJ5hbtg4yVCK9Yum2PSe8Z4guOS4gObyxpJw6nFykM6g3b/afsd3b/vRFwGu7vruX70wcFO3f9satCE7MOSvDjGOBioaTqbNIrYwRJxhpffitHpZ59aHlAivuZHXLi20mouoUgcYX6psRCu5DdvDHmWUySE3PJcaDhr4eLqcL48zlGB5XDDRtz41iJV+feSGL2UDQ1CHLJEGDUXJXeAihAsTDOLC9xteBDntGJ4J59FdOzOIqc1sboqM0OF0sgWbQtqoxCDm4eHrrpuZmZ21DGQZBgxA0dh7w/6vDd9USNAchdns5CoaoIREv069g6qtu+6pNCuNv//HcoXS8y/VG37gewzi4ybHK/kXU4fBPCJWNpZzFF2zk4DP1qlObjUnrtG/bicp9kYpZjbEi1mbLxVPjjzSOrmGji0zUW+Wy9UVtkBdJmPYzzeTdd0brQBjcXiHiwCyBIaQSFVMih7biQGe5DJKQVGShaxZtBnEiumRGm+Klt8WmBEX7qiCH9QAmXc/duer2xe82NdNvLir+yfb3x+cxkmrqFu2BbBh08SMntdyRLen7FF3sn7YVVrjvo5CGAFFNyx4HS6aU+OQuBDwBCeG7b31a0pD7am74mg5S2kdQMHrpcx9FNKSBSLk58rnTp5+BFWUft8oF1w9yvlWRH16ekl4TkBKpod5aq2HPjDlqBgV/UJJieDa3aDh3WMuIDvKOf1JzwL0wrZpWpamMtNUkK2lav2JRrydrKFCFEX9ruf5QpTry6cEZAkTlAmXtUjHfPILD+z1M9zhMwS1PjlYtyOzmqvmQcIkgbksU9UyuXShoMB1GiLjj99vriBzLViucZA0HI5DPeIR9OLOtwY9q6yEKmqmDbXfNnO5QmF6WtFnzKxNaEHknHhZC3XfKpsr+WcbrXuXEER5pr+TXpxt5UCPPLq9t0v7ll7e9dCvvzaYxoQUgb3gyhOQtlmqkXeTWQ6YKb+YXsn5NoqsJeEEkLU9WmCehGa3AqMmSImepM8ER5SXkblFfEtYIs2SNnzKx9rd5K5u9pODoMUkCka0VgxStYkNtZpdTG4VN+zAaJi1yVfI82t/h/wF4TZOdO459XDFc7jjcOGGPnNLSITFdn96UxdjmaJZ0GyrWEzNQpgQyGecLwxflT1kFU0Fmwh+IcEPYgICA+dvtuaAbObIYXK5n6rcFo74hWgGRbOrt1QTtfmlmYVUuegQj1ZpqwbUunvnM3f9+q2DOvCqkbRyBAuDW57umvXsPTfJYBOaq0XpxgE3g4Tijbuq0MWUuFXcoivGPuXK1B37b9XVomIZSibLzQTCGgCoTg1fKamB7tCI3xflWGth69TKydpKUGvdTR0EpAEh6ji1p7BDJCg6wYL4pXHS3LJ89bi+VlzW2khbHH1odt0ItMh2bRde+J98YDmHShpkoQk8inY/1Z359tef2dMdeWmg053frg0aJhBCyk6DjDnM4ixOLaYBWgP4FGAeUjXFS1dQpmyQXK4IQcd0XvRzUS4obEx0Uq2M7ozjSXyZmteBIEAfpWma65EeaU+BdkTH6KHh/sR8KiVPhsp0gwmxLQvUKIibArc7uUahxOt15IBQlif82CPwyHMw1s0Z6yNO2kn79iZugURwXVSKsM+3xGPiNKshXukvZz2zmq6lO0mQMSRirgBFJCGZRHUnCOq+n6ihoj+/nFhCLdx/0j4tqIcG7pAhepFH/YhXmIddO9BrdjsuFR4Zh/hOcwA7trC2uYkq1UoF0juyg3wrvWSIhKpZupFOzc0aejaFcK2fVPF9VolAjDCXl9R10DB83AdmJRSuFEL8kW7m/BfP7+keeeUTPxm4rnv82UEqtRtEL1tlj9JVtgZupArTS3z8qH2cnMV1168jDgSLI1yhdd03XUaG+K38DpES6MyFA3fQBbxKSvaSsWK6lpNl8xYkNdGSaOA6swC0n+NZ/jEMEZ6DCdlPbzZsIFYXeI2oWMOKbWEFrtYo6DlP8QpewbFB8Q1c9whvRN/g6AQjn+snd+BxkGWQ8Y7m54RbUgI1sj0XTh2EJSVA6gwCswqGAbIit/PJl/q6l/zdoIqnVPhcApduWhqE3yyfJBl1rjgzfRh4hRYy3EDMMORjneFaxtMrhuAubwmALnbilAhYTw+hcm35AWfDWRWV4jGzYcEg6B5mGsTwVnf+J5e+smfg0q7oPj04oGTwBP4oHiYzkiaJaRs4oSmQxqWJ0D7jBWyRt+HqLj3JzosNvsK+zdY40Bfz3Aj0L2nhZSIM3/AIBTExy3Zej+clMq1lun19S7/a9eDfD2ayYBiyMHJF+AAbm3JcGHYKwSy3F/SyVcIlH7mAX4wGLCpXVvwKaekV+zVb44DVg9g3hOGi+aZhJFJod/edf7X3+QGl+7G/GaQOkKjDvNICgxAqL0pZ4FaqWw5QEsSyU1pmICwupaK2IUO7eUwK5vo6HJg1j0uh0zrBeRRufUcHY+lpgcUI1bkmJkt5y4pjVc1ZKhDgGPgqqoNxQcW872p5mB4drI559IsStmwQQUrSTubHwRxamq31zI9u60rcmC7Ow290KdOzo/IDUyOgHyidu91QtLxwjGxu1E6HmpD+Cj7EtwOrqgOlchSIeom5MNIVuBoQZgTed/x75CLaOM4u3n1sO/fLvvZPuuGPd3UfWh0Ek8zkLXAjtxZ4TrlaqYalsOQ4nePyakH+Oog7ftNrlo5BDm2wBq1D4gHNUJe3M3+t1YBpXOIgHCVPFsuFmhJlQ1OYjqTruTAn5l2bGZ7lGBxsqIiXjIvA0MF12WKCKbZJiqZhwR1L4Jzp0Qf4FgMVi5kJvVCYn7oUJJYFSWSpE9YhupcOB4drR7nJYQAR1VtTjuKox45W1Yq2qDSNyPLoEu3QEvMgvl0geeTShTJYrHdvjwx6BqHL5Dhpmm2lpXh6abI55N9Gv4Lofj3eXxjOTE3PHhk9oB4sx/3pjcJSfolxa0E/Tu52jot2+RtOiID9yk45XCivAJKJzqojg9IUMngfWX9517e3nxqcMSFydVOjafExNk1vJxNkL965wdyPU4w4OpCDKQgKrZMAMWDvfCHvz4ruR51umk/kXrRaphgHMRbN/vgTP5EZl97+p8EEntXGsiOZRG5+fnLKNPSEVQAm1ITOSUUPrNAE4+RanAkhbaqE/kcfKkdh0PZLXiM6EzTtKu6Yrg12NsxJImZSRNhOEbhlQhvV5s1CcuQ1tsA2MrXRQ8DiRNXU4vTk4UOqmskVsunMxNT1X5FzVIhzguQswg9qMC8ds2+BNsc+ZiAqwdzJOgwRoHJZSCMWsTL3eEm8Qlq0RCsQMZF9t1vGLjmFGeCkAoqe1vzI9Xwa0lKlWowMT5e5KFTQYRrhjoqRRXrnzKb5UQkut7FrgD1tSeVgJpQijsL+WuWZZ8tV149C36tVFldLpUYjKstQFkI4nh9VvQgC2nGAtgS4FshuMIzA88GiqDKYiV461FgD8XXcAZIRRBIH15e0uhVaPqUiHF4ueCa3BGGI8JEAhDbGEqEZubiIR0iBoN3r6fPb177S1/0/53d1/1f3Q4PUtgqmUpyfHlWMojlnTRI0RWaD/skoBXpQ96ce1NtERgZHqpO2+4/o2nx9f2nCrtSnQB3lAq2ZKhtPJE8o69ay23HuEaWoZ25hnNlKJ4jC0tIJOXvyZJsL5XvI3b1RZ0Dy6jf1RaMlrGxDLemuLkxuODL/5nxbaN5NJSATylUYVj/0wnr74e8BtLmBA68Bk1H2ABtB/nCBgoq1XgA6sDl4Vl8VGabSrJAKQ+bnYevjxjRBt5O8MQnBCYitgXS1nJQbd/E6rbMAzmFRHOOnGDoGYwWCxJg5It8NtAU3rWio+QSmhbSah3lOI3OG2p1kM+0Fq/C+CB8rrBdbRUd3dO92CsbLSFAF7SbdlX/88x91pxN72i/f/kr38p985i+vfOEzPxlYj/399v8YTMOImKamanESJypRQAjp2l57Hg2ciZnDSpEMkSmnEGXqMxuZM+CHzpaFLPEwTst0q1QSaOBgrOrcy4UNAA9yDn3mwoF9MXoZv91LcYMrPUItMJVnGQk11/RNTj26CBCBQgFB5iHzTD8cw16wNnHNvJf9jfe3oIUUtuD8M1tgdRIaq2hgf8xqmi3sGGWLjRs5O48BKgemFMotfJFKg9uYwpPkg3ge4Wz/wKlY6oIROm0dUIaVOUOxFTsD00696Am36a+5i6wiOY1zBGMAV+PQdXSfX7v1ot3PNX+4/bEXbvzhnn/9UfcPnxk4u33l9v8eHHjxtvzO7xpftEy4PsBsbrAEyZGCLNeBWCEFexZ/iEwhfBvLhakg6xoefBgkBfaM034Qul4jbAcnKseM5jyqZpw0388mqGWM6sMsKMaNXGJS1TCMOyGKMqtO2wjmmM76WSfvGY4BAS9lquEafrFUrKstMzIpraEKmJWLchSDWyAmLtqaNks1pwBnp0mBDcFKHIsWHQvJOpIUsStT5aJrAQJK4U4lKJfB9Di4YpYsdE/uGW+r5fCVSq/0A+bT5ce3qHgNFcr1pYfAOhPmlJ0oaDm/1BeJa/RMpzwUdYotENflTLUQIBNsVE/lQxoYAkyzyPv7xYyZtidVbAOf+WwTsbOUBsLjp9waXWYPiw5MxtnjzjfcTlj1ym0ztMHcmI7uCl91kObYNG8B3nf/x0/AlsGkaHgkQeDjyWu2G2zkXGLqcOJIfi45bMVBbRXsItLj2k04g3Ps6zzpjPk5bz48un776nyor+bq2sOz36vcvYQC1wOBxKjvhX6z2mr3khmuv1Kt3yUWGeQ+XUC0WtjQAhu0BKCdO7UqS0WKo3gH2yPshsK8eUsmXkQqSBdpJ1gL9MX3fLdxtn6mvnh8Y3M18ktwWBfgFPlu0+QluDchRBxLSBLIlXQ26SrMwOgX//bxQQ9kDkuzBFa1bG4mn5/NDc8dYoeWMqViqNbURu4USC/mNMON0nrJJCeiB6pn7KUJtFvd5uc/+/LVj+3pnvtb0PSf3P7ZYDLD2MUAJeCzQGrP2zkyY86DljBMRcWmk/CPcrzOFpkJ5wNS2wNZEMjTY6ukRU6QJZAK7V4pFJu2aRRHPk8xkvrDUi3VLNi6ngDxNlrYa8xCABvpy4lCTTtr55A+bhwtzKopbAB/Gp65UKjoFQsUQa/cyOQah0Dl1XAxvNs/UTlXethbCxb9VX+Fan6ntNW+r7Ja21i4E+wV8IYU9QMfYJUFdhFoJAa40CRM9cCwQ/BJkgUeZuwib+ed9PMX7Z7Ybr7c13Wf3dX90jZIf3ooXShOzWeU5MjUrf5tp4Zr2VKxpqLI0I3+TGHkSDFjqHq2d0UgSW07f4Ro1gTf60LmwchhKaIOB5pjgU6TdGs79pmxH5jPdhquzatexVtZDMvI8TyfA222z4qSW3NOSU+MfUiwJX2p0MAC95yJGN3KlVRf65XofDf0Qz8qOW6lybVw1WsxTloIRp6AxwrVdVtgnl+kFir4/dRJbtigHORqj+0koryTd4osDUjELYWih/9s0DUh4eGwIC5I78wtqnIDRIeUMHGeVo2ihgrFMYAXk379mBYUI70hArextbVY9kRFlGgA7w9UpO3og45dViN1Y9ovODNOnKRMRU+nZotaAlTnPr6PF93iCjKqznJ/8M1j992/2a5g2syh3Ub3DIz+3u2dQYXM6UVD1tBtQKiJpKaPjs9NFsZBwGsEZ0fZbbWjqDq5Fj+ulu0zxAFegSRhdf5oe6mKCnf0U9NI2KZtpa8zZsyEEsdxUrQytgF8mLdySJvpFwAwwkDLWv+yRiSgCFAy8iIczoUDWN8Rtdb3omPlu/y10ikUHXPXq6tOUDkJstJzvR7UebKMBiagRJrUzvmo4JFKPwFBpAM4aqHpZZoAkr3aMAyrWxCyrjpezQikclVgcDWzpk7QqU8NbhorM9VhoVOaS2eS89nx7HAyrk+TeVJ0jEituif8Gmrcdeb0neUKuLKalMQb3z7fTXcv6Ot0d+16Yjs1mFYmrvQVRgIj1BugJUrC564bgOTzItf1vNIyB4ldJqEVYMfuAS3p2RvFL5A8KYR5DeV3fjZomaYlCVmZBVaPl9J1w7c9M6IoKIH+haG+mMsKo5D1LcFDN4icklvBC4YrbYlcUNScjIfiQUFXCnCe8z/+lz/+EVjDy7YvGOwtDbiuzwWN6KIZqSXLyXngyamsvGmOygFtDDyVkDrYtnp3k9hy2Up6GDsF3KOTCU+uSwqbm26R45LdMao8DDlfKINcpNUmu/jGna3BpAUBVAQpa+nEpGPkZiOTPqLECaSobttAwBikkKyZUfgRWXDBruIWQpANoKYA1AVvlQBjgWqk13Fc4SI/Wjjn1kBsy+UqHhzjZQrDANfkko65ZFdwScpWOdkCe0VXVqlkfQLtvrH70Pa5waJ5y03JWSnI5ODnlXzu8OGDR6aTeTVXsOSw25igHDg0nCFFzDnYh0ZyaW4lvjHmqdW5lWx9vppcnK6nkK8FmgBCAb1pcSvQPKNaKFkVR65MVJqVFvPVCNkCXAOgB5B/NL3s2zOr45tlPHw8W73lkWxF9wxfQqBYX5C6amP95Zd//gvb0qsYQlcN5xdAJ2po96vdq+8cee6fXv7is3sGLum+sn3N4PvpzkVqQlft2zDJIlCLqUDvd+XiL3A+wA5w0+P8Hu9eb5Z0PypAnfIlpyEakKRo4C0gDpggPo4cH+iTedYKrsFVuFqQZFMmOmoUrSFpP360c+XguHmYHXRu8nYuV22Vyqq3rDqAdFKtKYOqctUXbhfZJBiWSuK1chzHgLK91eqALvMF/g33+26bopCu4EX8mHmCrftw+JKo85AtcM8Dz+SxACRL1TKtCBUXDxbGQS/cePf2yUEVHBq29Jzt/PyPzv/F5oRUZ+tzYIqIoetGNn/LDdkcSqbzWduw9SOHpNUePmLr2LYM21aLTK8kKylKSzZIrpJTLXteAHAhM0CADg4CP6g3F1eqrXp7pV5dQF64sbmyuLTQaPEIpCX4J7PDgmQAJk7IsliunA/RdOvgicMn89V8ScYQ6AqRXLrloaKbDogzP4d2z010f7Ov/e1d3T8FBiM4bxbtAoCQoivG2GzPT8BN19Kzet4G8YdTyJrqD8BzLeAqHNHzQLSJHhdIUHX9Enf9uuM2m2h5uR5u+Bt+m3X0Rc0HccYMbkkEsSasopGZOQyjkc3NZ/fPjCbnMpZWiINvS7OZYM5LCMXBEM96SfExEiTiVbftwyh4pXbimLGAI0I8Vwjfcfhi6d6NpTZqVDeOQZ71FFUQNu/02m6LL9htXNEWTIAaLAmcOrmGCbgxX9eYXMXA3HCPhHkaZ1cUTQPV/00MGnYyoQEUGXkYxiR1FubLSkllAOAejUQoOG+2UWuBRv00AmlQUqPptTwzqQ6gg3b/tP5CX/d9z+3qjm//7iDIxXghnZ4pzNDbaIJYrhqmLNbKVYsCMr9GGm5doCXv9CmOpQmDu1ZJRQbkBNh2YVWtOq1RwcoAJAIuHhJl45TrLS6V/zF1mjJtvae1QSVapdy6UkXZ9vi6JiwG5MxVf94rgOjS6TTZb48qo2nNOjyqFdHwrXs/VRwu3A6SdoruZ5qbcFP+rNOrAsk1rvqU6IEl2N8oD/pFL4GoCEFiOJKS7E3cYfez71bPtVDTb5bB3UhAA4YjgenbDu6ZeEC01xbsHaRHKo1r+7LX5kfxJBl1Ct5Ebfpu407jpDgVrTbvP/fc1hpq1GqgyNaC01pHCay1iTAvTD/nFmoHnaHijJkvZGwBMIl9GuAHcFgsGT6QWhkUM9MD2dYgVV6mZsuasw22qRAMuVkjqZt2b329J9wzOXj6Z/sGZceJoQCiqwDmICTB1WBDN/ViIVdIa6Zc/JSQDNo0FBXuhbXqImXNUi0MRAgsyrvixT0Lz3ULz3/u5YGnu1Pbfz+YxnP5dPrA/ukvJm9QJowksKCFdThoMvdnxrB6PR5xhhCobAtkHfipDl2joSNqogxsUKdV8PdbvMa3RBWUtn+XzCV4ht3p/NK800Rstn/gVT6Mb8AJcz+hS/nIKJsCsKoaOMCKAAuAkk9z7q2ysvMt/CPzXhLiOimZZ5N/o3awa0Z2oLVMUawjrTwBbgL3RggVohEnbqG7PjoYGqWUn3YLIFDAPHvT8Cyu/AWMGdWoygy280G5PgpEHIjAa2E3qAvfq4iodGLxdKtRLpVJRUW7k13/V923v7Jn6cUbXuxe/8OBv+v+fPvUIKZKb1lefiQIUay4WX8UkLvIitRmGreNIkd5vh/sk02mdekmFcugOWoXQH6BoJOky0wGztJgs7RIdWdSpJ2kc6ssQvIx9zY08CLL8ZvZ7fz9PAViV3dAW4EFAlyvKOfmW7ZHQrkeWMWPsrIoi43QE2VvoSPRUlbZgxIWbsNrYiHqSCzajxolKzTKtmsFySV56jBrjhYkItUj7I5ObyQEc2AwNpuOw3r21ROLi6VKY6G0xFtS7b1W6Dkna94quEsCwoNQZFMjwBTtxA4OljB8quyIsiKzogMRmsIA+aJoE3sPjRemlKQBusSgM1nLALkhV6NnKCsXItU370yenTuWrCqO7ekgR90iM9xZZ07dq6g28JxqZ01Cx1gK4s2GgTmwQF0ky3Y2Q3ipH1iuQYHHrO9a95rnyMv6KviGECDGV+ueKDlnQ3DHJwSni0BpzWd+3td+aVfX2P73QRXPaXl9Oj98x+gNmanEMFaJDXODLVOdAYkvu1QwwrY+ZaWMWXuWpmkR/BmGrzEA/XiUcrPNr58+cF8arRUfwcuBz8HBQBQ/tRH6rrtYleb02JYXhVUnxAHCAaWZSiEymCrrtyC5LALGKZ9M3TEzpcwUbzFmyijrp1pa1faMilXWO+BnjpMT3hMhOBuY0Ebtvub60klU7axvVvx6WLdrakXfmg3+q0r/GkZFtsMQZ77jOSU4JRbySrYNSeOlm6pf9ONVE8YRvjjSvTEnAwjw4OoPttXEnsWffO7Zgae3+7YbEOWJhjxY0VX8+YrKUuFk9Y5gH0vTDMNEw/OmbqOkKkqZueS0bbAs1ZmUejt92s7r7PeQm60KvQUNvEonISWkQJNsQF8rCDdIxQztNVIRsqPBoWiR/mzFDxmLvJK3WetU15YatVOnpA8Lwl6BBDgULmjhFPdBhFbdqt+Bi2qxiteyuMRQEuAGRFVZDjLJbBWWKEu3wDYHuNcF1IvUTENG6p7sYMUoWxQidS1RUjvJjdloJkj7eTyBU+pBPZMdueWmqRRK5IcTKWNOH8pMU50SIUo88P6KPcwf9/7BfBDcTpX4CLcKdNU/FjyeWQWRv9Q98dPuHYk9x1+66jzA6APbTw9miGencMZO2VkyaRf0GX1CJyRhgB6xTarSAgheZJnKvIw3rgkduQX6qX56HRmzD8LoFXf+G4mLSZaX/XmmKde2iUQwmxulnERVaTWQb91lNAB2v1MugahaCzaDx2tn/DW+xiseXQe6Za91DjqqXOmi8Db3KjMDFzeLJ/WE+d4p05NLsdhB2AOcvk9816nwbyC29SDtf4y1cVV3MYgNUAvLZcd1Xb5scYR5v/DyPXo0edYtijzYZ4DtafEFc9JEpy6kbdKBtwRMql3AqZJzrrbgPhCc9VeZb3pW5AQ2ahgN7oZy3dQBFyVKti8rRNRhjaIAI+Il+SGGEnSeGaBD7tku/Kxv6Qe7uh/afmFw3ppIGjlsy94eQzVnTFCp6pg5k/oATxV33ojj1qS+H1kzZjzIOqqLF+wqXIIvIhCRHuQnrYjQqTiLrIz4ggMgisTWPaJ/ia+CKN50tkStLuCkYIipL6WxryyBiGEK4Dya5FU2asftr1nzGKmEtfv5RvRkeNpbwE7YiJo2+aEakSWzROswZaukRldxi6AWacDRSry2addwZER2bylfKts5dql3iwNoytG89wkvbcv10Mb57kdf7Dv+N13jhV3dm7dfGjSo3utwkP2LGh2aymTTmb2ftFPE1BK0105IJMRaX8JZnGAZnuKHhfCmnLlw0jUZqUz3UhAzDBB76lDJCC1fj+yaadJFbUVds1edEqSVbJxxgYWRx0GtE59873uyJiBcB+5+1FtMcmWbYvkEryB3kwWkQhp2vZeJ8hOqaacInFXgoNnErJinaPRqDUwmwRcD5gG+AhvaLM9nHLukeuYPwiapk6pkcUMbtjWkzeXnEnPx6XxxXlcsm2b5USdRirfTNcyVBa1uRSRE9rKxiLfwKnVEg0fSg7Jy9S4vZL1rpLzU8iPkeEJWisTSQuiW/Q2naTWtZd23Xbtu3lmoWhUTssfBJVnNZm7oRqUlWo2HadCls2HeTfiKMx0JPOWjpDvOZ8HDprrK+S+/vOf+l7qXvnrF+YGp7uPdnw7GWf/AqVvETt8skfW1Cqu5Pya/kGsgEMxweMzm6BzMHShVy8B56+PmToyMgWGY0i7p1ZZ1kFeqnSQZe4piR0UcuJP3BLPUehGMbxukquyDgLmRJU+gGuR16CmxJU7RkjiF+Gq/LwIegZ6vgsRDA1PfKZ1y6hhFBB/pJ0maobJF8F0854wyq55xjRKWBWSHtyIQXZ5VQWaTnGaPo4Ej/KeV7jvIX8MxyF2ipJTB1bIER3O8f+BIJocL+Ms0h8fwLJ4lCQppuXPfyvz2N4E9nvvCCwOv3rP9xOAlbxh4+h1vGHj1nW/Y/c8P/Wv3uRcO/3BPd+0FAMXnt58dvC4/b37BmJBFd90AjYAzeI7akVFVT5ptZ8Hd8ECtcwqDkC1/2c+TS+nX09flpooJ00yn5uIGnjJQyswG/dmgUNaqlq9EJrcBIfL2vGnbEPwZppbnhLEyyaXs9yzfqoPUaRgLWgfEUsPdqDkygoXDfffYcSYQ8wJyEaEAQ2613TkLYqvn0R3fv7cnmb9vg/giEY0QbRt3qqfsil2SgbUgpKE/5bkve5tkiYBkdXyHUt4USxTCzIwstp+hK5mFP59Du1vr37/phQGl+8z2zwZ1MpWW9R1VLSi3DF1+aX7eUPM5WXiUK2yMQd4FiAR2k5TtRZuwFvOA5HyjQwBBaAfeztMQ6EAfhbx9jZsTujNGJQkrTJfe/pPuR8jOG8k+qgrDy3p4mS9xh3ll7rKI3ofoL+l9/YG1AmbKMe8dldphGUw9w4EWqcfH7rmxMsNtqjED8UxQkCTs9OzbquzP6kUhpyGILF6lHaOClKXEcd0zvPSizL6RE5OrqWaijimln31Ya5gRJYaDbHhbWG4t/8OvakHJ21p2y6UFLia3EBYFpkEgkfp838kXdp3dPjdoWKSIryUz+DBOWLfTOXvIuJR92J/wpqqTZcU3CPWAK411JaBtuslrXtNb9Rb8Bxpn/FW8Cp9UWgzqjGPg6NCM/qv86Ohs2p12EqDp5m1w/8Zk/spMRiBD9nt6xbb5mHiMn6LfcDfdTed/4uP4LPEMV9YvExTNU8xUHe3+y+7fvdSNPb+n/eJVL1/zRPfe8wN/vX3h9i8GZf95r1lWNk/juQy4EjoxpuYzs4TNjSYmJkZM2Xaeris1I1SqRmCAvZRRNLolm2vkOgF2cq5sjScZYPtsBufZzhvp1/hNLMtyIL1kf02GF9DA87zAxtgMu4E2nWGe5Rm5JeK7ICBkFZFwS2DXYrQBOPDXIYuYDNLvchbViezyYdJePe+U2QP2Ci6TsuzItR4EZgqMvyUuvAVCbIMcR+TJqNBfyruysYK64PPCYgjGy7Hbdg0YYSXy3dWFUmXzLNo4e/qcrAv5KZFxJ8S7ZK87VUnRvsn4NNasjH0bPYjoCDWcnJNlGHyHEVhCijZH9MhYajxZFEICBsQODNAy3jn3OF10TgbPsS3yMHnIOm2W7KC4SgWi7sSa6qCiM8ZNYEpn+5XEns7Ll//o8093D54fqHT/8dd9g6qWH7NmjFH8GXEVO8pvpTOI7TX8fpCfZS1MLA49ET8xezJ1bOZs4rQRyiUS0lsZsEEcI4vnKzANhQsG1ousYORySpGP0kk08CTZeQubZkfRwDrf5+2lB+it3pddBQ1UIFtMmG/dU71exaDKF0UoZJmXnbFOwOsJeEqA7mX7JNmSBzpnb+J7EN6sT/ev3n78luN3VFP1uUqukjtzrYC8C21w1lYVAoTTBY9SRLHnuUFQFlW+7txHuv3mE3iTPes8wOrhcSeUnWWyidzT/GyAklGB5EGS3tl+sbv24q7udds/GJxRhD8zPzU3OTx7m5bVc6AjbG2aaEQxUrhgZ+wrWR6BscmxghijxE248/UDUaI+ujSzno3MkgHCDE6+zFGZ191QnKjcfezYGc/3fNnd0DreONY8Hi75W06D300XEFlnFWWtsJU4nqmB+Oy33OnFnvcEY6h541XV1cWYq4m0P+/Pqah22aCrtXJl33d90jDr5lK2kark2hNyvwB4PdXLwvDGER0yRvLjynRqVMmkp2+8KW9JN6LZaSNDc77iguwvo2I7dxeuEhAmOLAW7Pt5y3uifvfJR0uN9a1eXQVyDe0Ou9ZLe06/eNWL3aM/BNfz4e23DcpGBLC/DrsfTEOvdRnkUUP2I2CYVKuUK5lg5GR9t7dCS7jpH1zL+jbThS4yvkXSbtIdFTmMxs1pTbWSxYO5XE5KHtPOqVQzs/q8D+mPQpuk+kmRjpJJ/Amb0/cDi9D387HwgJNhYP8cywPUgQPTpteWBcEKD/G6Ddn5NJzHSXzOfoI1ZWdVCeJq03pGdLwz5U55uRH5x44TjgiT7Seu79dkd1a4wC7euaL7zsEt467petxXfLljxgQPSFxTmcwlconb4qNW3L6W5QQqcOmp1/lD/JtkQTISkXVYuZOEn6ie9O5R0e7u2xZe6D7y3K7uHds/H5RLVJikjBuG5iYO700OZ65Xx+0b3cMiTufDpKv6c5AhSzdF6ZX48tzDU01ZdZQqn6yJlttwNltVL3Q6jXIZhWFk9h9Pt/P1bCNDeRWGYGnZEb4nN3QhFiVa/UqpGMpVkOFFCCWWlCzMvAjC0XFrInDrtdO4jogj28rcyFoBZdkAJ1ql7dyG3lKXZs4q9Ww72UqXUD4crcjqjAXaIeelXZXm6ZSmmegHHx+UFBMWI6XsBV4l0xypHKkOOyl6Kx2lppU35q2ckkRqZqbenwszJd3NRxNNGRIA/qRIKC1kiwWCmcZUYQYGEtjXQGor6/MlDXS43Gdmx7MpbSJnsbg76yh+ooNyNSNQG1MPWjXyTXIKUmrBW2s/WGmVaqub1UopotTDKLRqTiWshi4tK2i3tb3y3J72Tz/x9Bef/+zLA52ut/3Pg4RkSZpca92YH0vpVrxg6eCRbIw1TT3sJtGA7aRtW0yjgY67F++8Rf9znCTDBH5+hNzWD7/M9vsJz1ihIUB8T0qDFhESeyJ4SSRLEmv4UXPMeYotsS3ZxbTR34qXC8cmTo5uTgQKt2TBqpxrjjeP+Dk/z7GnR6RX73ZZyVssg5OoM+fwC7KRlcjju2P3qYFMMNtBRnjHPZj0amvwY7aWraCppf6Kd7rVjE60GrWVpU5Lt6vNUpXgUBZARFAD7OvwMmKuVpZdlr21W663TVl7DqXfNQPJy9nApgh8E1cFqPk7PNtGOx/euWCQ1lcqj0dl/rgIiKzeBBAyvt3UUAkMej9NJsfGJo6OfenQqK7hPNYxjGDOps3+AZd2rG/ZVYhjHz63BJIkRLsb+ktd94W+7r+8tOve7sAgwKju6p7uqsDJej3VTh0bf3h6laLFC+6mdy622+fOLpyIzvqbrEa2yKbe0JbV9dG18QaaqYzT/iOsgG8tJM20aQOdTqgYF4tkETK+Salfbd35wLkHXdTiS1ZLrekN3ZH9JjaMAZVtxiUL8iwsN3mkO8Botmx4d3T5LE9VMmE6HC1pMDpYyg6xD/wH0u05U7eL5qFsKpPJTUyaxdSR2dHwqyLJzF4VxuIm4kVfrWcjFcw6yNs1ZyOqOOcXTlLw+riZbie9ND2EyBWFzNHh5LxpKWYBRiYF/sOgRWcqSlcPnzl6ivBcGSUbFk1lcnmSKyeFxXtlXA8mDO0+sa2/MPuDPd33/QiC+gfb/z44ht+XG9V0nLHz9pSRMKbwDDZ0PI5I2jf6I3VNa4tl0fEXHPSeC+nOG72dXfa7SY5Zsu+gbLjMoas2yF/u9XY4yT12SAjmk6fpGfw42bCfZd13SWdrl2E2PcIC9kiYI895qM1bQAdo4A4HdFRAKzB8jhMEQLZAcZ1+0zU900WjpP8QVfE4OERn4YfXPt+Ny3T8/varg7KKCBaWajP+pCj6hR79mMwIDke3OMPOAfewsReZR1L7pofzSVWZn5+a2jc8eqdSyZy0a9pp40l6jJ52zjvH4RREm3d6jTAeuHHIT75Oe6uwwtX9RIgSUX/eMAx1XksQk+hEsWXV2QCGh6DtWKp2FRm13s9u9/a7h4LR1rCrAOYBlnamXXMpWdVOWagFkr0BYBo5AqxMpyS3uC53opLrBYHjbB2795nK3Yh73GccwHaLb/B18hCWRtejnn2X+kjhDJBWQDnCnlWFtC/PLWpyM5fGMIzN7Pbzib72X+0CB/TUIMZmShvPXq9PYQOkSBEX9bH0NXbCni9m5P40uS6NMLYz1iQuyF2gKH97P6VGzWhkztqs8LjVURfMjl2d/y5wvafWZflbqxRrKLXanwWvkVLSRWwBqgMccMst8jlP5a/FmRWOgvPnpDwMqs2sfQ2y0wgmQF0Dk3MjPOrm3ZxTgIHNIT/RHPVNsA4mHEMVuGk0jSUwlXKxVZbEWgt+BXmlynEMMpnIfcFB4yW+4D24/HL0sLvMTH9VlP01bxF5i05bvkWrWHJflMwoV2dZOg+KXQE0737m3Kvd//nM3hc+++LAI9uz278aBDrJgaFTvJxrcSLyPO3dBiP/JTTg8q+zuAmiv0NgHKXw1I/Iba62ZqvZW2+75tBsPKv62mlzwVplHDFuBnI3A+FyJ4NsLDWiWZxWVMMy5w4cuXp+pKghA4wLFoavL1pLuIorvT4YiW0eXsGr2v/mD2qvIBAMNQojPfaIyYrCwOmiahRNgi2TT7gFPx1cKa5EbArcSZHNelfKZTN3HzxWvYRsbOCy9cuqTnpAirYLJxMVlrUWa/Nm2G61mk6weAYctNdrFDIcHTm6pwlL2L334cV8ybozf6K21Ar9wJMedH3D9REXS5u9tQ+QPH7QOe23opXAF6C64dy5z+WS6j04wGX8V6RsrVmnrQ5wmV3Nrxqe6UxHYMsGXAAfuS3YJrm83LndfrEzyC8A7X08ajmBX3G8zrHHfyXnzFOC/OrepfFjQ63p1tEojuRWgBJ2QXSAXHACp9cgyIXnhNLLYBf7BMwvTLpeLnRy7dmtsTOp5bGH43dih4P9aW16pbBx9rnN+9DKnbJSyioYtLHNbAHEW5p2M2paNVSgdWv2YHIS6UpmOj+P4gfTm/2z90ZzM/dPP1joyJ3n86uGAVOIAUOJbuumogHJ6gig3XL0lRscqzbRGq7Ey0m/4CnSEnuKp6DS/JHr+pNHEyNmMR/PJwpxJRkf9RLMOhGXZBGBOUO7n91+zwu7tq/b/vagRXr7HljeNCF4wOkWaNFQ912fnI6PaQWtoBYhbS17+CuyuPmp7oDmYX7oIa1s+kbZ8ottw1NdpDlZs1+1ValLdCsvCqJw/BofNO9LOxd0DoXZ2lwIgolRDGdvEZVo1jDJmvvNO6gb3Mi0QPOpT0/IvWhChLSD6Kb7fcD2OlkSbdGhPKxtPFSrrp1ZvXPzTGe1ueSV/XXEI8qMitbURdpCux8/8cPtN8+ffr6v+w/bL4FqMuG6cjSFDxqXKl/SprAOtiKjzRZydv1oaY6ROkV1Grgt3oY467AmK4tlZ811yDF3y33Ec8EwYDufR+nUl69Opw8duu5q2Z+cS2tqLjc1nE/Hx5OjxanCOLPbsygqPOVvsFPslDjBjrGKOGY/a1TpZlASQcBDHmnHTOBs8IFfYh/kX6WHrUPWftmD6zzwl+0F16vWo/Lyxr3nHnoYnX+52S7VvdCVreyyO1B4vqjZEXGwJ4WA5RsAxqyntHjGBa7nY0GB2WwfxAbavfOWD53f/tb5PYuvXvriwKsL278YZLP94HUT+LPkBpoVU+4QiI1b6SE6Rw7RNCtyHSyI0ECOjJFbrDK5HQ28CnpzDqvagaCwVFgsPFhZAwF7rywzMMkfQJjccZDvw2evk4ZsDNPhcREEgQaKQnX2M0Aukun9FQGF5i8aeHp2/QJal9unuCC/lE6M3kcflYtJ5+kilkrmx/xxxM9UcX8bdwc8JpvvZfmBipAtsw4RtqOFNruejlMAdYJkjwychzfXW7edZXOQ7RrRLZTWcFH2Z22/kNjTfdtzt/80+fyA272/u3sQxI5vhcWOp6rtYsdcURYBa23f8nsl9MAK9FrhOOT1wCOUZ1ckrI9+V/7FA8u3AeA9q1jRSnpJ4oXtmj4qVo1Ir6l13ppnBh1XZNeVLtfT01vXRKoDiChMRJsj5GKKGxOyGtQ8KruDq6NUkjezyjNgLohQHa066uSlqi3Hwb8Z5TlmAHoxqzpNLUTqI5ScuIrKWiYYbUdz88xgZk0JAIgYqfqAT0KeFCClQGGAG7mt3o5nuNku+M4wfj9MA0sfpxfvftf7X7n0O9tPnt/TnX3pU68MrD+3/R+DKWnHMUQ6kTuKwfnppk4Vd95N+Na9uEUiUCdIbtb2ARAXyCJFZwjX+nle7PwWvYp9wIzTd9Kb6V5iIKxkaL9KCzBBs/b1JM50WrRBlQ9MvbbCYVNLsVJWGk7M4GAIXmvVk3c4YRtFpkNatNwr1YJ5dvjd/D66QCsEcN4OmVzHBniVy+Yur7OS062AhRxYd+4yu3P4B+Q4DvTAdrB4TddavV7rafpnQHdZgWaceXOCod1T7b/7yD93P//iwB3dge3fGWRh85hcj/QqftWvBTXuIadUzfQHWiUHDk8L9Nc6XLkNst9cnK1lfUDYIBvokQ0GKBQVdyVyHKsOTOxCggizrNb1sunuvf/L30mDMUZidhmunbGLIFhFzpoxXKOQzSbU5OSX4jdirKqycQnsnKnqFAIG1CVk8UAHpkTuUikyWs80UxzXvEAc25SbTEW1TgXa/eRXXrny2T0Dl25ftjlokxF8QO5neS8eNnYucD7NQRCN29MUe1qUC/Ej5Pu4+y7uCgbJtEnRwwwsjtyt5sjfQZZ5rgeSp6K1+/WGLQzRazDXQbdPdP/m6T2dH179VPf6nw083f3Y9jsGAVQLFlb0sfFiLjmdT2cPFKeUeX6EqqwopYsz7RZg+v5TGcidtsUgVU+G5r2zDfKtmsuWapEfBaFXKUO8+rl+RxO6fKVjukYjsZwr8xJ3vbBVWgA68xU/27DKCPKwYdfMTVYPFktb3n29BU6HuLiBxQzoKIuaNrIwxv+/lwYeeDjCwOw2+EYOB1dlhZIjImbCIpN/tcMkSCdZzaDoyY8Pctl1CHdPc81QhakFAIIjWRC5OjFwzs7RLKKF4qSSTE9+8pOHv21E9gJdoVV/02+GnaXTrY7rnVgUFAXUTbjAR3++/dHEnruev/qpgc43AIZtEw42Bcg6jxV7ThTthHToBp0hc+SreM4esQ5af2jPG3eIRC0faY5e8yHt5BY4GETwNzBTvd0Jbm8jw5JawlV7i1ZF2z3VrlZgKNfuka363BOuX8XUbTrgxkTV6ajnlVM4KLYBtIwgW5N5aPrWa32FYBTjIgU0OakbJiambWJUNDNFEI+6yWr9YJsWWEOcw93XWaGsGKYpSlMTGyrqXr5TGizr0YTY715tTs8fVXOGWdBH0/Ps0ApKVWjQT12n6TSj+yzRPlNZabSWy8tll5V1tPuL23/wVF/369sjg5akCsCgw1OF/MzUxL78mK2ZmtxRVpjAgB7qkDWL9L3Rre1Rv7A67fa6B6Tk7GhVvGWeFQ1PyL+NQFGJPFmXILHY6yWXa0H1gFWVjlGyHVNojkn2KWhKv12bNm/XEm3jpLHlfiuqAyX5svfVr7rl5Yfvf6RDkUdBJsMbooJf9IuBKmVzvVdZ8inwslxpCpFbAy6Wm+blh4vCgloygEJ0z3Dzr3UTATEj3dvPCwbaPbf5zJ7uPecPPwom8qe/ftMglc2/RDdyO33mR0iKZCRez4aYqc5hMmvOWzpPwRTYcpOjTafSujk+O7kvf8hIGwVrCvzTiMg7iepkpKGNqZOFc7RNH3AduSuNuKzCloIIZCsFB+faJ5nPIdIC4bfZKluk/0Jq9lb4PDvD7hRn2D3sHtHhJyUjdfrlQmqBFbjuwPxahsWphq7aeWwwMsOEGxcZNmdfJ4N2jsxLrNIKRn/OyFqH9DnLIDPsdpb2zVPWhr9ZPwXif70cVkvLUcdBi84K9yEjUsce6qLv3PLkntVvA5i8rnvboOyo4biqPsbPOneKDbZaAugAO9xbpV9YDsqlplthi+KMujy1mqsebWedtDsdxA1kkWkT4oBNKwVjtjA0bIKfBP1qZTO56eJk+hbtK8FRxDWuSgcYzZey1cRKcj1/MvMP7t0t0C+9T4gC7qLe3+dhLmehUdGrtlBZBmJs1pw2rjJzIisUL1v7f4S9Z5Rd13UmKC66pLPGFuxGqXqmZ7pJtdwaW3K7bUvuWSPJpqhAkxRFiaKYwASCABErp5ffu/nek26+L6fKhUIhEAAJkAIYQIqkJMqSSDFJVLAcJGs5Ta9pv+Iqz5rZ+xbl/jn1FkGQVa/eveees/f37fBtUq5Tz647kRNzsA3eKZkAk3GtmJPBJwfXjVTtXgH7zESZlZhCHVPXVcYP0Sm2/RtFOLSytVpvk/5qE07AZmvBXdDIrvpW8uZVg19/4+qBsfUXI9gSB4iVlW3FnCqram7MMrR5DNgBncbi6gk2Sfh0gQ3lWYnOWQXHdowK1v7LChbkgJ3w7KHYWLCwPqSeljcKAF/ykGzI/fIg7IoxMRE+xI4QPueP13UwAbwvF11Jg3rc0t6mifG4NbjaWSYsromhb/sej2MShawzxHo2AHQLeMMXbZJNqyM2hAiWwhVGq81GO3ZP0iXm8q7eMgP40Uj3WMhIjbphgu0ziRe7YK9tIKA7xT+2b/uZpfu7+yNCb/XNa3c9t629svvr7kuvDb7w9AM/HP7FYG3r4yNZu2KVdeAkDh6CqRlKpzPlmcqoYwCWB8RiTtI5Yh9wx+KpoFAf941q/uyREAWV0EDQJpDyxOyxZUke807WgWJGYMjL2uembxk9Oj93rDTJ9/G7O+PAQTOLVpVYNaCmsGPiCAtxGf4OR1EcLDDUbRWluWSZyIxfaeSS8onJht5Vzmfx8McAxVb1Fj/ptmGtsfocbvMajy8AOKv66x28Z0BnbrXW6kT1Rr//hKwL3626CQk63gmv49bY15zH6Angtk1vlV2wIsfPY3HT8D/pwmKwin0ZoqAU+ChEHlU9NIOZhiM0oaGGAfYZgLFRwn1y2iRXPjeS0Jrt09iuq9gTBt+1YVeXaYVp4GbBJgA2VAk1AKrN84Oiqs+oY4Y+lqnoNis4R82sl+vM95Xj/Azhb5288mK76zO+YJFdf7D148zuxR9e/+LgY98bPnN+6+2Riulk5I3iEK8giGT4SVln+8P29UAqnAf4lDfjZgRtKjXNpYHAuqBQtjx/GVG9103Okfql+mZvI2k20VC0vKHIDG2hRLdZHxJ3kofex0qu09fbYMPhuPIAGyQxdxCLhJ8D8tDlSwAC3fPmE+qG0WNUq8PW8hyAyOXEBIw642KVyiiYUWLac6ZlwUECkwq2NoMiQo6NF01T2QveY6tgfOi3rSfsK4T1jWAIxQbKnOhALbBqentm6z++cNVzr1/9D1vFkQo9UtINh5qWTYs6K1XngoqLml20FWGKz8OCm8gLnMhLgMrVDHCevA6uhkosmKeBX/UiCrCawHEA/1RMfD4VK57G5xxybPuzI3rFuJ/dyb4K+2SvzEjVK0UzkbkA2wB78zzPx0oFQAgxYFarOmTFAIb69KRxOjjjLdGLZhX7NTBwAYZLWq4tCpxk37vrD7a/+MLW6cH7dw/2vXLzz774/O2v3vLifd8EcxxvnRjJW/PFFLaloiTWLLXU0fYjm7DYXlo5jwEaAoa5B5y04TG5TIZfEg3YrC3HtXwAV05Y9HSH3PT/7AW+5buBu1JP8IgIz/cBcP60WWt1kUHWawjekjpqJlwBX53g08VC4aDO+25HVnlLxmT4WenZAisKWY3XWJ/H4hRvsQZgoFCmvcsAun0y/DyvOTZKM/EAg/cyxAYC3qTwy18Ck73BIi6AGUjL5zwDfOT5ece0gRvMyXmsI3YPpu3nwN/SRlFk1I8IIGnPwqH5HP0Ke5gKOwvXyRwbCyKprVmqWbYMQ4c7MtOYiWs9NFemZipHR5jNYZtxgPyAPE2Rc3M1wCpAIgxZ8SivmCUjlWApYR8giQzPTrPlaZPHYgFN5HIlrUz3sYjhggXETrQ9cS2XLY4yHkb/9YdfGL5+8J7BjSMe7wEtbWqnj7Uyy2NP3rV5NNYiFdmVmzbnYV6TcKfJkB8u+L+qOHJ5WEtLUzCEGDLf8YjjUkw/yom1+y5pcaVhhsfOzi2XUZnBx97v6S5FOYlc5Aeev7HUb3bq0q2FoXei1652a5HXbgS+SOyImNXyggNstSwwl2uD9zKtz9+HbS73Hc2XNKOiGgYpV0Q85K76f8vPsCtc4uNhCO5CS+bArmHPruKYwCbh6pnOzNIn+Yf0P6CTzpedKWA6dFKYbJLOCjswQr1G26IrIh42pCsv8A3SDr8lrtm1fWLr/83sXn7lxte+8Pqwf2Vre8R2qGHlzDl4ROP8sL7976x91l521BsFWCOLYp4rgIS4InJS9ffz6dohjOxjbW29EFmBvUxDN0ICFhBRhf1XZYkdm2JHwMCpWeedNqznP2JW9xmgy+ck0FbZ4V35rKfKF5HVP+Mp/CJv4dV6fVMRXR7C+sPtT/mltNSPAWHeNfg3J175/BuDv3oNaOofbu0ZOaDPTWeOEC2vsSHAxtzSiaWxvUPsS86Cfi9V6e38GB/jdnK/sATuYpQ3MsHSi44gy+AQw6YbpsUzw31wAINPsoglInTrMpEJLnr9ArDfbhAnVRInoQk4Is7Kgptz/4w/wO+QuUgDNuz0USsTkbUXNUVAkueXv71yptnbPFUL61HbD+FkRhPene5X/TXtD5xJ/UtsgrBZzupFEuo9MdSDKwngC3bZYvQTnvMuBa+LDXvVWWKn9RZzsS+D8DC7qcVGmK0ZAEVHecW5r7zv6ME7TQ3OlGQddV1vE7NpebDvk8m2IknZZeDcyK5POatXLbw5+L0Xrx58buv6EQreHoibzQBR5bRcrlDQdMPkGMN1sRMbbLtD5iwR8o+z7TsAQxVcMHhxLipEZpWvorJD3UXRNGzYQNvkV63XjT5z2QJbYpdEVFuL+364uNhshkHVJ1WwyC6N7N6D4XgwW7tLlsMH+aeMQ3bWU2tWQFulUBAs3tnBA9KLql5HAkHjr9jLDMW3Eta2Ttl1VNU8iUWB+acwVOZ4zDO6pYVyHcCVj8QCfKkkZnDYMwBUD27Y+v0RystUo3lLMebmVW1+6t1GQ0stVSb0yeJ9sN/3EIA7tleKj3VHm/AbUAC1U3rM2Ag67ka9HvnYvwUgkq/1k6RabXbDxAsbbS/t7cIWAq8aLidnrCvqKrBxmsoKGpg9k2VcE29mGTZdoAaaX0iO+XM2MZlq2Zz8xUdHJK9PuVg0XpFqcEw5oOaLk3NT47mxvG5nYN/q2DqrLdK+tx5/s33x5OlaPfCAjjt1XHeJ1tm1EzBERGANJaxfo4iubaUJF7xL2/q113YvvP6F14BbTWx9GZ67xUyhiEOpRiDqAJVtnxctIE4Amim1DVUhlZJWRltOTXAFGrxjls1xoP+eLuZpESh/nhUIL9IDdAwzCzfT7WutR+xxtwCM16QelrvDPcu0uoRHvNrjTcI74LVC8HuDj2NBVh/sbMyrhHebxtAi8NAl67j+qHys2gt01o5jLwoaAAY1o9b1Ai9Ky6CiZeDMJ/mmdtapU8upm4uFTaVtxeMbmEQ3XcsjxWrBPxqRrCe4TUl4/UifNoxurl6RdpyNCp7iFrr/tXTfbeVZK8MngynfkrMNUgl110YDQ18fYuf5ORYSVg/joaTeSZbCflgTa2B3Fgbf/+7Vgw8M3hlx+MGHjYpRKWSMItELQwCdDpkAgu1RUeZgE9NCZ1NYfs6bqxV2onlgqXu5utbQenpi942zbAmoeSwj2fZ6YFWsh+m0f5Sgh0VQJudcLHvXpO4VqkfibFiINF+vZzfzTZ/U3MSN4npTBk5sth2rHJcS09ENIwB73xj9Fn2r8XPi9gFWREEsQrtK/eBU8qyMZU0Esl49I07yPhezkmTAr6PDZsyKrIi6lagS2X45LAeuLHsqbKMKJzbcEipEjFlYjW2mUaSZsmE7zDLTfjMTfN/gvZMjNTsxsROzpYLTpqsaNhSX99AcM5xi+UaqWkamTKbyBWPCvs8cbeXX509VX+ic7JxePXVqqdfoeV2D7CpjwvQTW58YOaAdK+VLiErfVbEF649NlrpeOGbO2wX47V8l/Dq3FtzpHvFMb9zNS2wesjB5scRhiaIQwJHdJTRky2yZvmot879CmoB6jtiGWOsttY6Hq+E39RNlUjd9p6q1S00nAQwdYLMmkB0RuV3OSu2Z1cnoWI0UgntqKM5yl4MF+jd2X7vq+EtXD/5k686ROUdzxor3TN1/T+MzfknQeqmdo/4itiGxjnzKq7vn+6SX1FzU6Ii/wlT72Ggmm4Wzbk3AEeNci8s1tQG+k4dazEK758gZJwtrrSmWwQwPyEK1UC+2stRaKZOeyuFAJbwGR6zuHgcL24mafqcd+EkShl+72Hwi+zpYSobQ0XWqyJQpeBAryXYUvxBKd1xgiK9kE8U2aEYlU6UJOlSkpVTHSCR+4vpRNYo63eOdTQUbSKrATYSIW8RPdpIvTkB9O2aoRw3HyhR515MoOvYng5+/fvPru4eVwe9s/fUIh0eGpgRNjaXaBaBZZUByZWPUmnPy9iQweDx495oWtZmmU/gXYMIKoEEaWbEJxEMsiNg3ZwE40gIYnjydYRVnzL8nGgtnZKE5157x7X5pPXfWPlsjEXhyYCv0OKxEFe5B9EQb7sgz4YQXJCkJTRsqlcZ0zM7aUo+ml9TT/FXewYJjEYXfdbFTWLgev8LJN98b8jjCHhyOum4c6IXHAdIYUvMOuIc4OchlNISiPsKVYbjprdf/UljHAkWqGJikukKv3TUav3bV4PnXrx5c2fqDkZKOnYrU5I6nVafhhM+IsqiA2bb5p8ESM1qmJWLuUwpHsvOVg8Y4PyYo1xIVDpbdd7r0ZTT4wRnZA4AVnw66Yc+yvLYH4GAqyYdwStMqI4whYPsMsa3iYUzyw5m1HZ3mbFOv8IP2vPaAf3vzvtaeEzNPa2TdWvIX/EejJzq1KsJfFEBqtWvNRqd63D8tsY/RIzJkP6GbdM1uVlYAT9ctkfWoXVDJrge2/jRz1eB9//3qn2z9xgh3TSw48eHE+jzQZIEVmeUYGpIAOeftr05HR0g45heCsWC8c0f1UJCL825R6p1sYkV2LQ1t9QApkMDvrqEia225efziXwt5anBV47HGOTfwayJCNc6xTprow+ozzi3bwi/dgbUtH648krm1cD+GSVGlg9iaOq1mSPaQ1R5STprNzA+1R0sXzJYT0QizZDrANrKrtfXBzO7ei1/+3hdeu/Kz//79m14dZoPB1n0jhmEfDsCqCYs9RIbb7DbbY3ezg7SgT5TuA9yUVRTB1LbetGvGqrEGcPcE4QlwqZD7BhZRhraryHlPtcsZS7d0Dk535harQsyyXkHxBGudNXlMW7RKhtdplW3SdedF+yxgmOGXkILAq2l485wM1/OY6C7Bj1kq//QQ34NVB3BNAM5KXBWzye2hgWgAHYhreEZzql9elcflyqO1ZTi1Xogq0PE46gcIpLFObwKL16q6xzEow+yEtq5t805tKAmiNPHn+UHQ7y8+HS6HS/XLHAgtY1E4+ACLaN83nEXaNRtaYAIESytrODalBqqhaWTXS1tXb2lYI25T29IVi6oYP7dgW+qKoc2N77sbQ+2f+c7EOik1XLOcKDHDAnxBWQm+0pYfEzip7oFfR+/JAiMw2tnv3Jjqw9q+SWLV0IdS5QowLscO2SZ1dFXTMvPH9hZLul6cs1QtJ83j86RfjN3jZ9r9k+eqjaT+zJWkhYIfrvQ9zn3LdXzbpaSlXtjbnXLtC9d5qZgDhgYSjjHsehWF0P0AjIMb1epqQl2tZtQnL02dHt2o1CoJkFcv03QQNNpfe4l0FrtLWEK0fprVWM0Ki4DO0gZnfxr5/67K9nXfkC9tfThz1cvfGNz+jasHz25/ZMTnJzco8HzX94Jqs7nJw1QmzJeh20R1NX/N2yTBZXpZv2yv0p55HLmpbMtFLnUst0xVlrE0hugV3boWbCCm9FWW5aN8LzzcCjUoZpIsNacUy7n5TKZAZnMHS2XXlGpsx1bNXmA9+qi44p0VdfE8sG/flGVOsHTCNA1TSOugeZBZ9DZ2kBfgSdlCg4c02jrQyJCo7NGumliP6kmEmUhfNOAot6JHu49urJwkYcKODaHxBrrxVeXA3IQNmwG9+kxZty240ilxWFTc+ZDMJdlwvpEFRomxOdNBCRtNBbSn+jp2XMYFiUQbltruFFbKj5UeL7n8FF/msWi4CUCcNA+fNlDyRoK1HIfr377t8p5vDfJPPvD87d9EvzQ3ODVCdZVew3g+j+5iatTBHnJwtmT0yJBg9+xBjZBjY2B9eW6M2Y4qiugwPPBHNq9rISWJU8UKBXEmwL3S8/GcYuMfGf5gzTvOGrLrfk34jmReWhMAP05XrKqIg8iHi6sT9KdmAM5Gh32vAGQ0XApvVhyZxU7V4Q+C2RAGrPL91BTEfu+wDwTcrPAyzzsVRhSaJEPNhqk1281WFDWbUXTpeeCHYTgURusbYSjlxglkAc02FiU0WmkdILxc32JpotTEahds9EewGsO2GSaYiW1s/7HNrx3+Nco+C1bcZvvActl0VlIHfwABIGc7IbA0NqhaMcrGDRs8d5z23Y77LOuJmkCBwIA/IxNGwOFi6cyv3gQHuVhI26j+z9/+8Q2vDDpvDfj3d58d3DmcvTh4Y8TmYCSAYBgloXAVsJwmSpIumB3Lo5FsuB4NKsRXncIQ1ayirRhZU5neq2SpbT5Cy8m9AeAGkdbd93NNjYR2qxj+qgJ++GJgduwe6zJPVH0gsBKJSHZHny7ikQfeJWKx0SNGpxIMVYKKKAP4tBg2el5EsV8zrXbWw0zH6jUXsXILf3frJJzOoL7uJkQGbgRr7InAX/K69qredSInNaXYg15stCK3TgCyYS5KsvN2i0Y0wCegtWhYOVeg2kVid/x4yI/DsFsL/arsyJ6sub7v+f4Cb/HIiHVXdcddgxE4FnaFK3xGLSlAZ1PhpPmMbRhlo8TpztMCJ3gNf1f0Rlii7O91lfZoWI6KruGXqwVZRqlkRSemZTgONuyUdJv//3S5bf/O9nt+tPXfXt/912/f9bc3vz380++/89tAilJVZJNhUiATZ+t6bMJOlz03MWv6UkHbVzhGzMrsI6aulKwCn+JHvEo3Xy8LjsSTIZVgcNZswC0Akio0L0vBDCojmCmjsj21Ng1O0de8nDsjS+b9Zl6fM9SKXbENXvRKWLcLq6CMsTKhM231SbrOTLsbhDJxA9kJFns8AUcHh6DacK9B7QDp1RbjS/Q8WzPPWhE2G2BUGJ9WbCd6x1iXsQjqQUPWpe9X/QgHUgRERnFPw/IebEAH92G4GvgSHUhexVMwjjsfVmKsGwjq1U4ATDYVxUSTNPwSHMW1eCVa8tacdbpktMuotBRh9M9x8QZNdzIkRc/imsBco+oQHb4FEHnX4EOD6uDzV21tbl0/wqMJTzdN2/YtqwzuVOjCGJvMajMV1Zutl6KvPJqGZQxX92arGW+Kz8MWyBqKrdoUluTQnGlX9AP7uUNQERD+FzwSXsF6ikahXnJpwJvci6uBJ1uNZoP0+3FUC1Yaa25Xi+0zs4vFqoHQHPY+kIqavmH3KHnC+v6VxiJ2AGHjrJcuIywfStel4eUdRTOExqi1/MzKjz716vD1a+/8+siwIj7KDtNZhuyDOib/kKtJS+iswgqMAZN0sGmU0IbpXSO5Tz2KyTlTqLKipWNQUsBDFVqxp53t/0UexdKNW3mRPmx/WbBHjY7Deeyhxg3G0xW3gQMo3A3eYJtsgT3Pv8b/gp6yIysp1FS3AawPqz2AMTl/w87yqv+U/xx36bP0AqulnTAIcCO1YWBiSeUqy1FwU4YN5w+PnMpMXiS7XnzlrT0/GNzw1vXP3PP27sGeH97y6vAHlrc+MqJxf8wFkp5YHXbWScQFsPS/8YTke4b4HaKcALbbnZaG74gaUfQfNTAQQYB4MvSAggESSH0boDlMxAMHI8MfsGq0K88QuVljQyFr0gYlwx86bb8sOkHdC3wZCc9ZsjvcRcUmM2BMZ7P2Hn7YI3f7PmMx91iC44REj7eJ2CgtDBk1MwEIIYsc40SapZlwofMVSr1JNyeuxyXHvou74cl/US9RxTEtuA6H7hSVcmaiQ7l+MLedGfkSkL4HdVj5CStrFa15w2aWYhRdGWTBp9HAxtkmGNyuy42QPFU9G5wFs3x9X2AuZI2/TDdYn3UY8nE4ymBAxUnHt4B47pdkn9x+nyiAN/nJ1v5fpqXW/XfeGrFYwQKDyObMVD0fiKVBx2cNrZCp7Kdj8Iw0zEM40TFP9ctLk1VrQe3ZJ6K6V/MQPYB55oFYX/YlqYcnLmMRPHaIS9/t4PgYe4VGTjV7GhslS2EhJnBmeYmSpd8bCUtMUeaVed2YUEjeGNJjwBRLfMVv1RtxIkREMaOA4cIGHA1wzPCsyfbv/MuJkd57T/PYvyiXxUlvwSNnwyFpgt1TvMPhfbLi5vmXnSJVOPUVT/VsHwC4r0eM+LxBsQWkW8XaDr+BFdpsA3NK7IqzbryqPFv8HqlcmXlp4vFy/8hZ3FiA/r1KLRMWA8PF2SI5eBoVnWhmuYJn1gELXioXpvKH84dnbmMKRx0c21LnPuFkiD1rTdrz1qTQzFEnTzM8C1bc9g0X84qs7jyGo0AAv9axNtGNsHDEX/YWvcXgrLcErx6YgMG/HXRH2srCWPtIbSYZA19Btz9eLpiANqTf7FxpnmkuVNvtto+7HDaGTXYt53++9YFfXrX686sHf/nOz0YUx6F3P/jx6wzjwMOZeYBvCrxoKxcriSb4guPJekJCAFoo8rKxDn8JLj+BSaRqXIOvdgNcaztIRAdYtONlu/mWIwo2+c/bT47MOTnnNvUBoxXfM3+sDC5pjEy8j3+Z3uh8wtl+j7jJL7o6RjJsgx4Bi29EamTVjGfYsyHxRUe25FPBL9sXwE17IvbrUdxJVfUjWI4m0HifGN5X2ZhdoiitOencqk47BpsHwi4CgGBoXQA0E4GVR8JGBPUS4d/pyKF177xbZw1a873ES8LQi5Kl6dW8xKYfJhz/S9YRi4jLQ+IUa9FUIQTeCyYsEj9qNIPBe8STHBalFcGRZn3COtSzwnJHslv4IT6Ge3fXU3f/cuvZt68a/Po73xzRwKTqRS1HaZz11Vg5Pn5xr6TNSru0OZuq/qMIR2CdKybwGRGG2QJwsGD2wR00nUXwnejJBZp7ATRUZv39feR3dz1TDi1XCyysZXOxVcmQtiSqb3HFIT/ZXhtxKFL4O/NjB6fuMopaybEBORZs07GVPZhFQmBInKI96ozSOe8rfrZ+x8nbzk1HVpTK1KJGemA2ncgma5VL9uP+m/GFU6uvtZ9gK/7z/lP8KWvTOuvzwuXC0/Nr9y6RqXrZPeTqKGIkDf8hrlnkr7evGvHtiEasSwMjHm/c599owos7ZkYfF+W5nKbbLOcAAM/A4ciBH8qEo1XLVWvHzpS/G307/KbfXXxi9dmlpSWHNNg5cJRk10L2td2PvXrb4DcHf/gPw/7g6XfoyHSlVFAmrbJUo0wydaqykbQCi9fCWtjoujW/H9QqPaI3HPFIlRS8oe2Z7Mjwmcl5pcQLHJhIvbB6JOSPbjTrzRriGIlPPGZuqU1yC5aLU3QcmimSQWf7KyOpDaRlC6i4jvMMvIyX5RW2/R66/e/YATjfurlXOETa6ripZ6dmKgd4htuiHMzW5jfUs5Un7Sts8D8DPGKD32SrNKEAU2a8rItlhaatYaN2qksC1l9hKjGu028K/7N3R/Wz8PAdT3W1cDbOxGXP9FIctzYGDwhzQYHTUzR+2jitr4hTUSQTCYZWdKsBnJeN9XqX1FqOkSwlS8Gy/1hw2X1JDH6bX3C+60RGR2+YrgaU0HKIZcMRAjPxjQH97s0/2D24/a8+++bwBwfKljNCWUH5V6rilFDUSBEsMJqAtE+DswfgHhEvDEO8rgjLXFvcdRIuM3XscCgHOrj5gsWvHfz77U+PDF/P+a3sM/C6AYj1LM2h3OuwAi6PXUNT9Et0Q5SGxLivdmgLSGvfBU+27q6IX4jv8cGHgRl5PElFOtPmKoBG2E9FRUGSvLxLUkq2P7z9KTiBmoP1hmUU46lYjl/yFFGOHRRT3BFmYzsl7gHzHZw9V0uwoi/N/fQxVYIyzG4S86jSrywyrgVqoIocrNE26Q3e84W/2X+8883h3xp86Z3/bQTMTCnNsNvCcisyhn/0JO9YLB1u5U56RsMBk+SBn2kaDS9uYLFOWpjsA2mquT0nBry8wsCjsvIGTzvLcWBLfgXosi9CLUVwOPkgj7MIK6EjMO/ombpuGkzxK2jF8AmFmovlE0kFSPv2H66PDPuG7ZT4HK8IMI1k+DbfOXkUs7etWUCRZVdxARhK7OhTwUEXRd6brgLo+EMpGL2W2wl+l7bSIg/PAdA5fBsOKboGPFOQSrkK0RWAT8FU1xzXadAmgJoq880q0mOBWA9DQKgGChwOUJavttQ2xmTg/vBzAPYFVqTXy9V0Clw6VtERJXHUxbgFAPY/eeGnVw2e2foFtn45FvyjaDgZTjeQ8KUa7Q78l1lWx6aOjhL8Kz7Z+dzM3MEjhm6ULc3WALfr7b2R4to4241Ia2l2Mbc+uzqzduxbn1ufX6rCLbmppKdww2o9vgYMfSD9oEFDta7WbIk9j2agJ8fO3f7cobUjK0bAcBZPUm3UTqyd2dxYW1v+xjfQZ/hBELTazMv2sz0tLitkIP/LCDhgr1LP9kw/SwsscG+945bbm517HiqUyiqKb+azlg50jem8xEbNoDkZKL6GQcvNY57uq8uzG3M1rVOONbI+celgy+wYrVojirywDpjPBYzgRTW1/uDpclJoGAEpNP/4RfApwoy0mBRa3dbQ8mK9vrKw2BVev1WPl5fqoSclhlRCP21A3Vnkja2/HbEpSnfmMsxqFQLTN5HwfuPWtemNiTNHTkw2KomC+Nw2zCNThyZuv+PYfl01DKSqDlUrapkacAwsaYIh0arl0JWMOTU7vqbGl1v9Xhz3F5rttROrS+uLi52lRVSHdVPpufYFhsMK7diKjboRHTw5szCf9kbrgR4d3RhbKSd6oEWOS5x0khh8A4VcIyUGn+Gr1bJOtmfB6aT8j9aM5Zm61i8IezG7MteoLM+Sbr5QHNI0AyOs1tjk2PyBCVs/PPngIaUcVXBTUMc2gjKY1IbeqnTDVnDpzPpaHLfrtXhjYWXRT7xoM5UB8OOgSpqrpsWQ/IRAHqM8dkDyEqz+PY+38rc8f+uV0M4LoggDrM/OilbK1AYrpHmCG2TXxuC6f/rY3w0rW+9/Z2bk3Xogb64KSFVm3BIjZWafGKIdu5UaqbQ1DO/bCCx21J5xuKsXwQNZfJxgk+y74yctwtX5ytB4fjZXzBu6pjsolZM1dNs2FFObOySUpcJqLqRVlwQy9MOoVj97GlCWC38NSa0+NHy9HBsaVuR95v+u348aD27Om+CTxpRTZpNumdvtUsh6TsPpRASLVNB+AZMCtgoH56Tos2VWJ3ShtjjUXPNDpHiBu9poRE8/nYZhsQLW7T8l6sHz6hOjzxFgR3E6U5MmJie3f2qkXqnf40zZR6cPTioY03P44PNDHbcpI5185F+eAI5bdh4aRYVOdEWWZc8CuHdcC556OVJa2mIl4P06Wagn1bATNMTaDgVEuU4VZUuTYw0UyXp70Pr54Hf/9ke/+NiPP/23uxf+bvivBn//Tmdk3KRsj/yiLPAjNhn+fpHmqclNVDMFn6zYCo6shA81TfBUeV4Utq8RF6O7/zp54Em6gUooy16L/wNd5Uvghsnwy5FcCjGQ0Upgv0s3cP1qi/nZRa2qJ2nIQsAimEKzMza5uP152A8P0T10+381N/gtdoYdK02D0bDhk1HTGYi6JrfvFIzAu7Zvob/H7uUTsiArQkG4iHrpkeWxBf4Y/3nvkkdW5HdqxyXZlHVzCBwPjyMXp++Ihhe22Cp23thSiYwA5RvnAHoSd1LOXvMg+6qxfVVu1p5ydEZKVAzeNyS+KZ7hvOW02AZQ/hA+KjJqsoWzFjA0K4FTBqTa1yKrZYOVMAMjGJMPssNMYyZ4dJslQ8yna2zNfpsbvuh5g8+EPbEEziNwqnbVr/KYLyRYKy1Fk7fFSepjix+N0OH+c//vB0/9w9VbN7zz8xGbFcvFUrFUrqTiCQ7K8tqmTU372CPY7gT/wyKWSbH9ohIYC8Wq7rJQxDIJ6g0fvgRPeP9ENSCJv7KC/Qxu4AdJFVxZWyRMGuHcghKUTLAopRFNu+tO01QqhRlbNeZdvV/sFwLR6TSb3Gr0wrjZqddIvV5rAnRvypYV2P5Yn3KDqsjlv7+dA/BkwD6qYNRTs2wb6GeWK3rZKBn33VuaM1Qla5aJWTbKlMLHXG+MafvcaX6YT3oZPx/NBNnGxE7/MeEsUWrl5amV7IqKgplwV/abvO4FsPQuX/ZeXDu9QurJKazrkdjWGgR+PQg8v3n+3TSIB2bse84i0V80LlrLQJaq4JYX5y8Xe8ce27N4W30a1gag4IX/OBLZie3TxO7kgnL7QPuD/Cb+MC0XjpbGDT6XnZ6/N3PAInnq8LK/v1GsFzbNmtEGMNq2v42jfkQAQHq19b36cdK9eObyQg2H2kR2w3SCutHSA1FrBqGfdpAF8C5AVLs2n7/zG0d/9qXvsNeHP/jyO+A0MR8FnLkyjwdM19M/VYkBEWFp/NphBeOc1NJmMn92DgyJFHWv6QMGreKIrI6fuE2wbLg1g7Aqw2gpaYTw5t/1qg2MT0i584+4FtAgUsUqTZSF/yGpVKZ5U3O01IJgjQ8xLF3Dh+DoqDYw+K/b7x8ZBpcVRu+uNpB0m/uh6yeLvny3jjUVRSWB21jh2PzvppY6/YYJzqvcYELjJa6VNR3gt2MjotF1S7cM2M6Go+ZQUZRh+ZBZhgdTIZYqGezDAp03CyytTUVPKDRR5BTTqzhOlYApEtcI1BMHuPdbaC2rcFwTXIl0GhBYwyCdH+J5YPjhCSwQ3pdJsizSunnCg4Rxvyqu2TX4nvz2oP3D276/e+G14TODc1ufH/n8+s2H7703n9fU4uzc0fID9l46D8yvLDSpclvO9fb3Z0mzsJ5fNnDqkktD5yLruBfCK93+MuxHHE3tchaUSWN0beqs1nA2WOwuhIAQ4eOXq9hSsLmw1GpVa9WVNdLpoYbITnWYEK5XXYq73tPWirVKXbPuoGoADniYO6FW55dGO4djXU7wB+gY405eHy/tubH8ELMdMOGEWupDFHgZvyHIpmMacHo1QGucA1LWVH2iVLLJhHaXM1tT/fkFKwHztgwcvxtsxEu1zVrSXWx2PK+TkMW6L3FGR0CbRWBziRoZbhrEFVRase05iQrQJvDagaj09Mb8so1RZNM1PWIiF3LJYOYTIx6vqlh+hhHdgC80ESELHrFT1tq+5EhySN+bnSe2rZQ1ZWZibP5gMatThooYAPy9qU7lpdoLta+3NzdPkVYbdhk4Eex4Jbu2frP++iD71mfe3j14CwWKTm79zoiWZo4cPj5WKebmLCd7UJkvHrAyVAcjiV+hiIjsMoO1ecPxWY1FhZNmyMTUZpo+9Cy/XFODbESGz8wmOa8C/k9GedfeCZy480KhWTgXBUUz9Z06+NysklGypWPgQBmzAFxp5rQ9ZU+7D4dT0gqKQYXEWc+qKrVKe0eTFPX2nU0lciVQIpfWrCcbGMURqOu54D5/CtBYFOwkAdI+h/Zm3CVBleaH6KTIeMVw1is1ckiahBOUnhrFlgisd/bsE2zDI215KsENngoo8Ed7vdpSc32t2onq1U2/5/dYz+iTwqW9Tx5YGe/CQfSpr9f0iEytPqRMFMj2P35xhGvrYGewBQZ7kQOf4KyudIyNDU5P7c7HecAZDPWmpvX8kFG0rLm58fF8ZUzNmRYgtWO8XC0vl5fpin/Gf5Tz2irpXWx3V0IpEgNsy9Z7MiPD343smEWiKX3W0ntqQ61VYq1qBtrCqKdiqIQq1CDaRCF7aHYiN17Zy3Hkg+JPVysL9obTA57W95aDRvM4qS/Xeo1mtYaT6MkuVnvzxh9/4vL939764zduAIJ/01vD7x1sbf23EaA2FPySlbPnuYqTxhkZBpv3e+ZXOdnHdXOooIDVyssjdeMVTh7lMj/kHqAH9Y+Z1/Eb9OsZfHcaTM3uLNPFNDBErSywnVFxVGkY6QTzLMsJx7PgZwDHUkzhfBa5sAfvgls766AAYN/DGmccgwPfXRLL7jL8qt2ropZOzDgLHAr8nYWog3OscI3Bk5PhD6WmloEbqQvpBWzd3NFb963EEDowGMtWXDL8Z5osiEmu8HHHScMYsG2lqKWV6olYk8+xrPsNIl8Us+5T8kn3tLhM+KNVMXRCbLgnIjj3QAZdz8PBVTLs4UC5/Jqxo+aFwm9FOF9w9I6+8tbgI9/64qu3fm/w8ed3P//6Ox97c/jUX269PAIPX9EMyzasdCDHzjw7IK4GmHZYPj0dG18vGCKY93PyiMx4E/JmeUweEtu/5WeFVa2AwTLDkmeT0KzxJb/lPlZfCTcilW/6p/2T4Tl70YlF5AWoWO2QRUdy360Gbs173DsH1/6YrMsGYPVFxhAvoOQ0alxKX8b+ipd4ZLgbyZ+GZ8UK9s/AolRraTSjLFRRig/IgpsRv+uUiVMIx3E6EzoX36pR30uHsIlAtJsChzid4I8S8ZZ9Qe/tSPLyevFS6VTma4e/PnFcrY6tY/764ErJJYacjXQb85XIiwwday7KCv7XzFQln53IH83dT2yE3bBSyuG02FhxlOKd2h3GrdZD8F/S9PdGWUYm2H0mDvIy4ZWlXyigUDagP0pUm/lDcJGDEd4iS+/zMYYslrwnPZTl9Bw0DYs0isnwn4NBkci3g5ilU3WlG1b1hulPLRz1b65g/YfDiQG+0znHWk4XuxmUx+HnvG8td/2nG9/014yQ9oDLEilj7Dd0Y8we+D4mGYAZYP0R89i7bIQw38BpBWC087IovyQr7JC9RwFGiQ2bcAoeLjHMi42VgRhsvbRvpK6dOpqUk3ITLExciPOI9LN8hk/xHMNO7i5lCsVB76em2TyY9QLQlQKcrW7QGnJjGWJ1V3MD56+1TiXtsNbph36EgNsE6v+Dzhtbn/7+Vf3XB5+9PPibt67e2t5aGdkJjTFhgosyYKEr1ULLcuf9qeBArligFBuciMOnJ9SCAWBWze4MS3ccZQpFqZ2KXTHm7Qk7AzuGfQVushiNegWv0jriOaFlAQEwcAAncExuGvibLGo7mdIRfS8nR3g+GCoEYHHao8ddr3JCXac14DPPRierZ5LN1a/1+km1k4Q4Q3Mdo/d0ZQJXBDlYaHdjz6tWPSzLCEqYjnY8E8xGoV6p5oKin5VlarBJDUv80jACP3RULZCje2bvMY7aGStrjlKF3STzctYtejo4EwO2ntrbVyuQX+UUQz3WWoXjc7BBUhWj2PiWsSlb4nTkuSSdTSqafq8ax+nMkobAUdY7g0Hgj15BOkSwEwXs5mjbEa9yZtfheHbcWLTl+aVW3K2ef7S5QIBB+2JHMAhHd8FXGNZPuB1Z87hoiga95NSJ1aM1Zc1s6vW5DbUxeRyTBrk67JsP7xmplSI7ggPqph/s2i5iEOvdCJvj6j7YAowE4GxBV9BaoT0XlJPDftY7SIs4YR5rWlLsC0DbpGbp4JGD+2c/s2/PSuFn2mX3YvuKV/fqOD63dzqukyBeWE6lboD6wb56u//G4OMXnvvRYPTVqwcvbP0ZjvWOvThowTFqs4RhSgdeuC5KHf6MZ8HJET2alAWmwhMyLfxstNWzBSw1PnZELR26V5nN30HMrHmEF9M6EnAzYsqfTG47cef5qdAKEK84G5UQmwxCGrCqc1o0XR+smi+q4ngtCrFeDS7Z7fRxIIAX9YEk+GDIR3FAoGdUs229HrqpDEQERjSskiAS6aWyDmo68kVxXrwsL6MWfj9fNXuVb927MkvOH2rO1R7wSrKUVvDZvk0ivSGG1mF1wygIBGoXpiWwkpsnbFSA8zB6WjhHBXHc/ComrlC8x47ufQK32SNrWkSMYKgLW2wxXAXbvlBrRpvrqWYRfFWTxqmg5VUdRzaI27YYbbJEBdgNpKKFcQWriouHIRaHjy05ghhupoZTUfAuHG+sWk7FH0xhiGOUYfCYp4fapjllujg9k5/C+bdFB+AG9shr7lcBfehCESjn5m6/n8JHAh7NwWuC5Qkd1aIhC6s1UekHOLhhwKfDgysbKB9rAY0pmwadssgtlcPLmSeUFSdmm+xR72S01Hku6Z44s7Cy1OrinMhZniMcNdMB5NvcNRE0hLRh+ziW1nNxz7jAHT0yMP95pGPXrL6ykV+d9HJCt2YsXS/PzZd11cwYhxUbq3Y5yQOXnGEH4dIqCmGrQ2zNZ3bXadBNZKuo+N06sbS81qwCwuwCHX2nGb52zxuDm94Y/Nb8pdd3b+17Y3D6z295fXDd68NlBSzkj1L9Sga27oF7kaOZqq6U5uYetopWwdStjDmnzzvTWGF3WTudf+XeK7d2S96s0KgJG0hpqy0jwirNHNcYqdCsVqyYFth/WLmJCXwUE/vRomHzqGUa5Zl7CAozMdsuGTlrJv9p7+Mre2BZrLT8dBqBv+e4Dmw4VFyNrVUzcRr2xWAh6cXnWrX6zvy/gL/8UqtP/CCsBTG8cLo2TpKWOxOLAD5FMiR+gx8Z4ofd8WAOx1oKx8/2D9SLgelhVay9kqkbi+XH1C6AqqcUT0Q4C4gdj0LhiV7oA7TebLhA1prVHYEEcIkuFlz4xE+GfCCt3TLGp4I0IJEkAdA7xONujflmX4TiHBm+rIhFflYsEXGhQYdCNviwROwHsNR0Ss7d/G6+l5fBOM+Fc4EWl2qZRUoaLJQejnmAxxl7smr3mK9HqSik74R2TEPWIqxGawwL4L4Le+77/lrjH6On/ZedwAnM0PkVmIPTA1ucZMRQGSdAPeKMqZ+z9mFGDju+tz8Px56Ygj09xJ63XnACXIV/bYLF+SU+2F9wzQ61DBxeyg7iDdF7/Qn+IJ/CcDC+wzb4mK+6JrfYMZZhh9kMYQ9ZfMjk81mT51lBzRvTyoQ1znHwVMVXsEiike1Sqa2QyiZt8Mf5BSCmG52XL//keDuA1QnswErKOHnZl65JpB0avhXp0uxE7QiurstxWljVDh2stgvVdrFJSg1bVnwyF03QvEL+5d/80QincdGzPRtLr2HHuIHsRiFvGcvK6ng0KSxPkQpJHsjdmJml1NBNrZR5+OGZ/GyhYkzrZLio5C2LFcA2WwAdNK/QciKwaNjR0qI+69MT3sn4cVL9Wm1j9ULUqLb9IKmtreHqJYBqyCCzfWAEdhJ23IpgSOjwyAGjbN3dnj/z+g1vDO587eZv//OPP/vGLW/uvvTW4O23h48/s/XJyyNuaQjLCASN1Iao6pEJbpYv8LZ7Pl4JHvOX/MfjC+4TkqyJWm2o0eDC7Ntw60Zgu4fcDJtkGWfCuReY+z7zftOwxk1SAICTloSA35Z+9JS3mDwdv8wWUe8adilsbpeSXv4H1pPmcafFMBMZ1JAeSPmu/Ck4OxkxjzD4Y0fB2PZQD0FzK/49/r2A3YpckTmXc8Mioj/Eu3QJOzux3Hchqbonva50+Kp7yns5Ok0l36S+S0IsYdrp7HOxisfGts5mKkQTIXSGsw/OhM/CTvsj50/UrxQBulIb65RUBwDaqIkJZgAUcCgDPR1FbiaGu5NZBCr2DE+2ifMF7F5+5hjbTwv8CMs5U5pqaw5FKU6E1TabZtex3xZLxheJvd/WYAfnmGXutUdpTsxyDWfcViu+LlSphGqI9SfwfNkJ81T4eHU5PO6fcE/CWpyEs7jIGpycBOTWaJDtrw3+YuTp950HvneN5BiuJcPffKYmf+5fgjtuibZYlzG7YEesEWDeKIlTkZYKLxNewl7a4BHjj5x9dHx8+xa+xD0jMHAMOJZxuNu7seE972wPzSmIXHEKuEsjB5va3eWh8NnoRe9ZjmFxHDnF6gCd42d6QMMv8NM4d4xKhl0ODTwSoQfni6eIXuC8HLEG7gl7zEIqFURW3r0So+Z5VuZk9L16KpgMW/jBLfVbe9+8/We7B7t/9uW3BvPfnX5z+Hff+fo77wFyOEfn6B4zw/bCEboJLvOTOgcijhBMA2dgyWLwMfOjBTLsfK5SoA/RuwHBYmcKGKQ8GBse6h7qEbw7yYdwuoahYXqer7ikJoaYhXkMMvU+cbf9QXucDN9mPmJv/0/qI44iDGxduGDEfr/qPAkHZVW0UDrUzciLZPgL7rP+z9gLhF0e6oFNX3ZPu8vBk+6jLlB2QVam38sfNm/WPmsddB6xjjkF82anSIb/k1N27sJwFCakpREqmGbcNNMS/ODd0cZY3YSTeFkQNimSsTpqYVRfA8DlyqpMgjM8EABqVqOneZ2jpAMw/Y/6PfcJfpmvAwCD4/2TpOntqKsChAZq03TPyaZLqrLNU/WGtAE9iLzYTQUVjZZsz3JS4gEtYxnov9z52u6lH1//7UHtJ59+e9h/57qtV0ZsnouxfFZ3NXc+nA4q4iE5ITL0gEX5w5myqSi2SqiJnNXkCiAcG2dTF9yj3n4xiSoFM95X3Zws8u3rgFoGRXcebLvG9pbvLBw0snJeajV9g9hwgewF+n33//IxThyyHuuwCAdj96Wr/pC51NcDhFbIZzMAXkx41hyAGCvBL8PqV3Bqv8sq1n1s+8PeQZlL9kd5AAMY+LAXZyK7bgSO55DQOGUvu5cDRT6WnEvK8nKw7CZp7aMw5YzIBzOeSQK9VgkcpDE4ylGIejk0IlMi1lX9nbwWI77zIsUnhy1aLcBi7fhUpx6efLTTi6rrT/VOtS6xRUI3sU8dXCCqdLupEDr2QIOBKTbfda6SUHe+XgptqaSTf1SGMGRtvd4Mo7jhRV7kwzUAXhBLsiqqRsxj7qs9G0Fppg8MfPvXHxo5Y50vhhVfmzs0mz00diR7RJk3izpLmypRSjt4yHPS6cTS8bXIwTmFT/NlukQDs2+sq/28n/PzxqHyFJnaoxTHx/PgvEqWDfS5wrOY5fe0oNjDvHqlocWE/WKI/TU9Y1+yL7gt7aLVt9baOPkwlcNrhg0XnAw7BYhx64uPvzy447Wbruy++IPBD94clF699YfDbw/+8p1fG7nRmDb2qbPmI0rRKJoHJhXFsqhuTzODHgULewPdS48ROkbvs+eo6hw076TgC30DtcIAW2Zio2XWbClWcCBZRRyXJ+UJfzVY9TV7zV/1X/axTWGH4yHQI1Kiplfs4ohdItQhUQmVCA5YDc5JD34sCMKQ0eCK97i/4p5zT4CvOk5ES7jYRrWQwdnFv7jBtySNjcjoFdYnQrVaqB3gWYIFgoCVDJetA9ngHOdOpiMv0e+J2Nefs1FE3glopB3PHB/dyHbHF+86Syb6ER+q8Y2g63f9S314wBI7weNgsY9GC1EbGf5BHNdX4DIazhpabTu0Q637yBkV2QTw1rn6RG0yIFnvTjeNBaE4N1cAb88ZAc+qBS1TskzqoLMjWWpr4ASLZkYW/fH89oPmfmfemaRTLAvetmO1KT/KyVEwzvea+4y79c9rRU6M97p9uQwYT4I1Cbx+8IL7dbnupCOgqmxBrssVONXEt5aCOCLDl34lcuHHQOVSku1KnuIrLdXmwqn1RI0f8L4IkO/tEpxemobLgbq3rJdkQzZDJw56jcG/XX/aW0F8juVcwMzBpV+gODxJpIMFkhjPHq5wNVKa2OsdAscKqF+Ulks0fx8/5pDBDz88smqdyi/Nk+Fmq+TpKNgkeLGYyzE2pRws3OPcbldY3tSxPUHy84QvsT4Go3jEIkIbUTAExGpnKLsX+mu9k80nddjV/2Wr8+e7T7/1mR8P9rxSf3vAvgt7+v1bPx1BIROLV8Dxl7jGHbajepPKXDLHsW2tpMwTx5L7XAuO4jQ2Z8ovi4+K28WdKHAP76zAGtI5+bBX8QtxIXQie5WFXj0USVADdge0DpbNbtAF+hQ7zpfTNIUTW7HVV9v6ZvFrE+1KU12cDSskVKXuzsi8a8U6CcyWGIqB6wM3kRH6aWQ3WMq7lrY0pbNf61mAbwLpOANioPvhr2YkuV7g11CWr8kTCtaMsB3FkCXn0bRT4W+w7yGyAmAAzwBFE3RlXnLi/eB6+1pON/cjEwu1SG3PMa8xnxQl7By4BNmqLrbg8fvEbVCZW5o6mV2e3Bg7+eBFHfy2GmnwKtXA7gCu9CTx5LmGL1DHpx2sJCpbrK01T640FsNaXPe7XpOetuCYMSnDw5v6tQ4/2sHJKdhbbrj3R1MuwCGRZffSGWuyXNAtu1IklmmDaUGdCkMn4qtDYvs/sO08jVlQ2DCqem30pPOvwyn14N35uJKUkvuXxhq6V8aas2LY9oeWIosvx99ZuXxm9Yn6AjzvDXg0Hh5YLa3XMRo74SLX9Mu1QCskSvhgqyQrct4rCzIr7wrmLfKtm0bO2ptGV4/tyNlJoARWVReoDqpaRjaTy86WjpSJYpdMC8DYpYr5kFK2UGoDsa74uuzIGmDfGmtYy2bXSc67T1lkcGX7UyNMPB5dy+uoUUeb9HJao5ImOxeSltdwQ3GSfZ2u2OdzpGV44Ft5eXpiMp+rPJwvUYerjubMG/srGLYAyIzptP8wyLx90+u7F/5+4PxwsPnD4Ytb39j6y5G0jR6rnkyDqVQtGwbmbzE4aAEpKmesgjpHjKKVM8oUTRWyVwfbMsoPWlPa/WZG/QrR7rTcofnql+dM27Rvnh/VR/V5pkRqoLVpvfTTzuCPZN9dDTb4CuENv2ElZtWRGZdkXd0awkI4RuGxzquftQ5bX6b30bsY4i6WzvuZqe2r5ncCllSYVd2zAr1hRWar8jRd8Y8Hf95bq9eCx2qSEsmMQ9hXLjRPcYHktpUW4NgAYAIq+YRBa0UEBHCZl0adEpG4vehp2RMhDukDk3Fcwq4NAMeQJlsWF4ARZy8FbXmWk9PCrQwFh8PtT1o6QxFxM1BCHYklFv8BFmqhUArm0AhKEHNX/Dm7jCNbWZ37fFF/3F6x141Vc8U4rnWNDslfmLw4vYIdlen8oyUVqGt1MqjY5OTHR5YK5+4IU4bq6o0jnubmyDgdKgAC04EN3WdOAIAqM7xR2fS73e/4nf75zmkvCFyS+C5rqgAKX6ffm/7e7t5bN37nxrcH/reGl/+BjkjM29PIeobXAa/h4MmQr4TwFhlgSYNYjz1wXgdcebGB3SXVBtyTJ1ms1ksBa2irxbPm+WDV+05twydtuRi23Q0/iIwNu8O5Fmg+5wU2R8fsvD2qP4wF6FnnIK+E+cSoGSftHn/DO+8eF8/5ywCJfkw7tFtws4wUwI8AUzVhU4H9ZQa27jh5+2Gm0DIzjX3G9u/7txFuhdMYH4fziKPOhMWz7KBWMsjwck77fG6GwYWPUzPUzlmLzvNy3d3k/xw1yDCm6Gv8JD/L6saq8jiVR7QsKncqwGsqblYWmcbzRByi4xRw77K1h+1lf8oPiZIsSVVqqGsVo9YFYunmMdeQ1upEKurVwOLUXVsfWX5z8He/vKr35uAHrw1Kb129ZX59ZIdQua4Y/HvnMVY1B9dgS2moBZWVPbW51tTqg375/FfJ+dur5XYuAZuZCr+i/LAVq0CDU5IZ0jZKCcOTAWjiyRD1kzjOZfYifp5eppedV9im81MrjgeEiKZsAg6JUIMBfo+bj+YTwBqOSVXVwkn3iv0Isfbyj/gflQdReJKI0aFKY/5EuTW/es9PtJ7ZfOgNvVVeG30FIa+ynMrguY5L9NCUZaqykkGt8hSz+PYH+P/B8s467airxSU7FYQmXB45VUnm2/l6JSiFB5vpiAHsog5sL+3XTlu9BNhsobmmpbECHZvIHFbzpXFt1lZtFR6rlb+BK2RH6RO+FFpxsqwi9oOXddxi/EjzaC8T6gkABlIzHadtgdmkHb4Ia72ZVN2NZuCH4PAQvpw/szPS1/O8lZX+ZuuxsNtYB+OObZ3YobY9wm/jt2FGiGAxYppcTzNaVdgrPY4VtOkpFtwPUHJu+7mt/zQiwaj7wLQXglTegVfNthYa/czaZFQKjyQPaoY6TiqH5w9Ozz24v6LO6hXbZAqfBxieX6KuVbfrxFjkTw3xE6KbRik94dXfdBvdc9WlIAmrpMGG2mBc3DKc318Mpt8YfPHruwdbPxio37j1e8O/GHxqbAQV24DR0AueDxT+2eWlTrsG20UXTs1esqq0mkQ9Uj8RbsrjvB5f4k3C6pve0MvBsliiNaBnVb7EHS98MDjgPyTyooRVxxjmAqKB4QXMkoRFF1DePwX6E1hPO/wL7qYCfanJjGL6tvYYDeF3RbStPGGsFl5UasWniN2oLJuRVjNaakNpHtvEqpS5TopugTqX/fuAjRAMy6f5TNOyC5XMMXW2dEzbrx81M/SICXzBOkynCCvSivUwLYAxwMJ2TJvYjBnCgLOvqZaJ5R8YF6oUtZwyps7ZRUp5xZ0JZ5bK6/t+eXzwkbOvrz935vGTTdIKE94w20BBTx+uVVzRqlYjP7AalfVyr1S1PNNPedxYy9opXZSWd4TnrTlTivlKSdf1bK5cLuYtk4w+WJ7M7S8eLXyFHrXv4H/mqZjg59TNJAdxlAX2TBMgOuWgUpvpT+GosB2FnwsTvWu2Hhn8eEQVQ7PubTxDs3RaFNP6cCT1yeVwo/lC9zTOhPKcmkI6hbhUn07mO/sAk+q1cR+R6+87bw32vTb40+/sfvKNG98cvPry8P89+M3HRlbex654g/dj2D8Ae/G48oN4s9UKm/FSK/JPHH9XRzAgfhAkXkiC2lBwNJ7rZbu5mC1bNdj3kZvOUgF7hvsRjse1Pj9Rb8XN6Hgc0yo9OZ8o9VLjy84cVdQx8//r6UpjJLuq8wymzMV2nNEUBZGSzDhgBEH5QaKQSCiASbAAE2RsJ4DHnmFszz69TndXV3Wtb7/Le+++/dXW3dV79/TsNhgGW4yxAeOxwhYb25iE5UdQBEpYomqrkZJzXtuZ92O6W931qt6995zvu/c736k3p6rNgyUyAbm1JE6LclRaqfcaC9iTxXRgoaBPAqK5fZlcBQsWRR2IP6CdhqlC+i4SeyqdyKWTjjVbXhm7Mva0nLeZmzo99/HZxbbnYqevwD27kSnuZeRF6VK04c47HX6OJcaK1WPYZyBbmdUN0yO1TiOdTivReCuLWIDMVW9I6BZjZmYQO1bLFEtNq25MqzNotpF5f1oul7RrLbuGswSJrNtqkzTdmO3Keb/nL8tl6YhNfcEMRavjQVgB8hKyGJ143Gqqy0o05I/zEX64PkMb7GRluo6CN4Rzp8ayeVDNjrUzsS2F4AsXs3CnzkzUlh6fvsAyFZU0ZCVVA4zrimz4U8lIXHYfCu7TT9Vr5vCMrpPhMWqZ02ZZWLLk1j2zRUlMc/lf2kdz9iE2ZBnUpGO4xy1G6FGS/x3ggkPiEcL/PocFVdIk8zduQhhMIjK4aata6JlrjbbaUTeHgkaAXSsqaI+CALk0oSil8snyGYNge/LT9gh6pQIY+GXT5T/Pia/yL8On53Eic/3oaXsJD0WvbX3yJf2FvYP3vTyofiU/Nhjdeq4wat3fKBkG0xgFajSuNTTNGJ7iCtcc2p5Ja6EZY+5EEii9yPfs1IkhuWGnkABGG5ZSwz4ptt/Phgg7bG6/mQ3zqm06lt8I6Fk2C5QE5jOsFO/fvZ+Lc/ZgD3nBeVbsE8JDomv3nK5z0Xs5QAkFRAp96Pj4PbVPMMC13CTGiPXXciy+c+7Ql466dL2Omp1N5gHjXff6ft+biy+vkNBbmI+T2bnzT0Z9SKi+g2XeV2QfwCJ2oP+Ksjn6JWIGZogFc8cu4djVIzynrPt1gIuXRltFb5ST8o2WhOwnGzD9G4I4nZzT5jYWlI/pqeVOOeRe+fHmQY0Mqtt/WgAMyF1NwlOKLB9IRAp0KXDRiuCS69INLOFc0iLzcnHlVOcLySk61jxVPzr18CT8OzJW1EnJKPGKV/UAMM7pKfOMteZT4nLyPf+yLZKz0drcRYjorpVSH7cL/3Dr8R/sXvqPGwbrr+0BjjE2bhqVM3Je+4B10DyiH9AfpHcbI2ax+WHa4Lr+ADMIsGDP6DTWZK25ZiUwCz3cG0NDh/HlYrsaa1ZplGhNrvmK1LFVT2AsfSos9T/Xrazfj11sHBaoC1YQEOwsiCXKUSijsOevzQ5ydjT3axHbaXARaOJm/JK3Srw1+0vuFeJswmRfMvr8onvJPc/aWYFI4KaeJdIgCYJY68A78YVLfD2x9uHKNoE9m/Y9/K/4tHusTW3TYja59Zef/9FHXv3g724fkK27BoUzcu+Afv+3L+XftfU33yhYotlAQwfOjwmS/4eimOAGwBszmIEkKCr0C7zMVW7u9AgTeia5wv3A9gJuVQWRH5PeqqXPry+ck/7SStqKMk1Re7bT9X2JDwkumxOgz7hljAeU6IQU2pGcZ6ne0+ZmLqB7EXw0gCwOPDq4mh0tBqQTodBx+JLSqfWFHbHnmiL6hkM27Ui0aIjkQpC5G1ndrkK+wYIdeI9rNBUtEfiAY1qu5aVEJtZSLv8WPETEUm/qZQUYEpBd/mbDF0CuT3LDPO40YMEjFfkY04E4HgDWy5z7HCDnFMUBkIuOZ/IJml0mgAaSt2im86XCs7B0k2p2za5KJW66NGz6SmtK8qRIgnpaXRtu1ZJS2gi0hSPAU61jD2On2NPHUeLOLMqIZhRHG9OVsdOHZoqTo8UjTh3AmY4bdy6Wc5mBEUMwUyi/YHVYYO9YSMw5MGAd59ui7SZOwoCriKuoUc6/y7G/bqLxSh6bGONBbmB7QJVsGneitjPPFgnv1NNcrWWLaQ5gopJ1PBq8a/ujg3e+NvzK7sHln93w1PYfFQRdnvRQ/AWYOjRsvgBok4tOCLNXAp+U/cVOn8AcyDxmlp7AspBkzQm8+WhVrsvV2V/JWScQ865PAFG20DnLXXBb6bd4J7qK36OlLGZd4I2pu0qcrrduzznr4ZfDRSLbuUQkOMaRkkOrv3DGpoEemr1mxFO4KfxRaKO4A811WiIkwsMqO+rqkRVp7fFz1s42iKuFDXfIrooqYBwYTgMwlUIn65pWq5UP0hEAWg2qwHWENc0z1lFzlNAKrdrZKTVeQMMUerJ+r35CP175oHnCGrNq1jjRHxi57/hR0qg30pwR1NtqoiZ6nNUxwISpuadHhckV1I/YdHY8c5ZolSA93joY3rrt1fL03le/l+8P/nbrZOGUNqNNlk1LN0yqGpNjOC3QDqg8blWXi61myCIPmG232+rOLc52NuOWTFxXdOwr2qI6r33txMJ0t9bRFylJYRbgKOAWcsgfheSdWQ+5Hfhxp9VtrZ/3E8BBItV9eF8SLbUOa2ExMbLq2MnxkdMz1RljWhP2yMLhzQdXx0IgfDBI2PpGHg6nBBkSbT6ik5XtDxUeMaaUyYlajVn6iD4i+KIW0QQWWCLaHRl1LjzBHpsmsdkzYmtF9Whaj5uxkRiQdbSYtdicSCC/hDa2YhCrMWRDGUIunAs2VhY351dtl8U8MLxiuxGaroG22pZVmqgUK7W6XlYsOmGQklnycxUPSFVU7FPnRGskGW6fCNH3pAEP+reDQ6+++ALKp396PX9p8NmtTxXy371T3E2L1gw1FDGOPVfHQ/Npa5717AX7vPO8jcDFVIym0VSnzQZcCnbUANw6QT+tH1QyYR9aFJsAX4G+S8VnO+QJ0P2SJfG5OxE8gmsB7nIe/wAscJ1iT9CmyTyFuKakgOPqsR13guSxn809Trxkzs5dl7H9MrvKW0DaHDdKHae/ULwyzA/w7XdkXTjDXjxHehfWRe77bNO+4Pt2EmQborFIieirUU5JLGeUzfCPZEIzL/HTeN713K6b1pcUoQtHKm84V5qOgsVsrDZZHyMTD+QUd0wcgAiw+OKPf/Di7sHzW18u0Mlxul9AAsTyzOJ0uXz8hKoPjxSLBpsuKcqn78vKGbBdj6Y4M2FzdiJgT7hz9iwqSJ1vS99J5YBEfdbiEnk8bjplmkkHu9JGZ0UsQghvEF2KmbXYw/YEJQov8Rof40eMCVbljJ1bf/Ti4G2DvViWMb+QNczDAOdJF605fO7OdMpdyHmUiaFRAJU//v0fF3SqiRP2n8kPs/u0CVrdsbHiO0feAPdMTp06cacd07da6iq/6l/1r9vPW9+xVuXcbICj1oKwA7mDKKlYmFDJrV/8rx9d/rfB1end/7n1UqGBRmyqMBzdNT318uHAcrhnudbsmUF++23YEdNiJU4+Y72v+plk3MNNCAXuaZXMKWFKVeqB1bWwrTDkREl/wZfca37fQd6Q2omz6G7I1F5znuyHqRfyFcMnpi9CVHqhozLwbQ8Pxk6vTM810mYWbPRQjUmprwSV+Vrv7m9V0qme4aqZ9LtRI8/+/p0FwSuizI/xh3SY1QbTYdZOopV4aCyKy37PHey1NxhZZ4+zi2INNUCy5XkoOe43XatjdRzxcfuUfdxWbFJ2tknWyPHnW1eu7+3/5I4f5ZuDoa2NQiq6pSfv8rV2JWmsjHZHz46QUNeNXFO7525dsUxNNbSJ4WZl/JHqZHXCNHQl87NruOZcnXSbQKgB88Wt/ubZq6uX55ZmF77/r6i6bc+i50MQ2QkBALm4k+S5o6VabDrArLOSZOog9RhfxzJvZ3K1NF/pHnoGyeWDT1oAVlAfSQGFWXbTPWmbjDRgPFiRlQQHZIZVxFmRtSoF2f7oc4V8H+ZJzT4m/tL6ENvOY/+SD7E7uc7qQONNPNGxGTARHsI6Tt00SWL5TTG4EX3Anw8HVqZSADZqbKJWhHBMcDDm+4FUACsjt/5m689e+cKP87sGV157a6Guq6pSmTo+NXro0Ojo4Qe1BpqNWGajVj1TH68OMT1pEGm5mThs7cxs9fHjL2/ftHDYbwYNLFKcR02GH2dVWrYXJ95+kZUEBm2zX4cIb/pGUl23rclzMyvNztAXd9pdwVOq9ZSk2h1d2imekWHU27xy7sLyqvTW1paWl9baC2T1MQ/L8TvMnQpJKeBCM8ngH61CkTY1XsxOtBnJ3wFwcIYX+TH9Ln6ajVCVH2MPiGV2gE/DWraYQf+ZHSH5plDUv3AVt7pgzFk9a7YDryztTBLrzNvL9rJzyVkg0eAW54lgsAte1rkcfo0/JSLaZbGxRp1hdK6umV996OuDi+21c6d71cXqpvaVwR3f3fub5fmedmViM7mgr17d1M6VHxtZeuVrB79+bL6znD/8zJ4XBy8XnHJODvkH5El30j0iK46B+/2iKS2nLieiyUjBFpMYw80I1eQ8tHFXGBgrDc1E9MJOENoQ8Iw1EfkkkC4sSRjwa3t8ExXhoVjAgz034Fi21cdTNxmKwITEJFKHBHaQKYk87lOSf+jantiyOWQJd5ZGgM1mQ5QAiRZuF8inZBd/hTqBjUqvxG+7aXRp9pvuZRuLIgSeZ71hI03wpHg/qjA8J/aS8P/Px2x7Ad0cxQp1EbZnwNqI1PD4BcUbFRUBwFQy/6imZpjXXbBT2rPwfCxrhuZYoR7urCpcVwJQ10hSRcdaNKoSbpgCtMzOp+Fm+1HODPcKFmdjbzl16YIfOn0l6+nixRn2t13i+KGwIoYjHtshX379TBUw+EPP62qkMlUzTIOha1dR1bK+NpmDFUexsMXqBilr09Vm3TKtbHNULWMtu1bLhJWUUUOVRpWROm6b0hodm4J0l3X1gtugR3LDpHbJnrGdGUpg8Weu4Bxb3mAhN0xkbKimGgDhIQ4D1nDIdHTSKFewbTtlOgDGJm1QE63BsZsvRA9tHIKg0nSGUwD72cwxN4xo33f+p0AhWO/Lv/O7u4DnYS+/zJiI97ODX2yHSPJ//ux7gWegRlNuZFK/nh1I9FL3aWjFIpEt6VmZ/MWF+d+yAAWjuzXv6y1Lii6slcRYYgswhJ0qadcFM2tUtXjFxNNaygyjZIq2kGWum6YFwB7NL5DwNFrVRg0yYENHbY7uYz2ABh8+SCSdTokuAdSoei3gQDUUK6chqbFfb1OL/2fCD+ZUO48cqXQzax6R+SPu53IastyO0xVucGKwKusiysrohAZ/rZqkaXBhhPg+dsw6GGQgBdvZofIGchqEco/oc9zG0ZhBa3WHSy8i+CjRwRirrvGhvdFWxPUAZiRx1ELDebghSbb/qWDX/M86Vafs10WFNNL79X35236xC4cMoIwt9wvJIhYYK6JjnIcAnWrP0CV9mc3zCEipi2pyByYr6iDQHfrB4F4yuC6BBTENrUJpg6m0ahRFXTS0+3F7Xgh056GQWLCpAHxTNzkskHCW03RwO8nfdu0TzoZ3VpwXmzbAsEATwEt7wnQTiUZQjg6pCQIP8U3BWAN//zOsamHHYsVQhQo/eG7X9pkHCtvv1t9iCnwLVc3lvM8XAGX0YWZ1WWJssg5bhsvnfSIChhpFn52Hb11s0+tiZZAbedmJuzXrBfL1UjdYwnf93f5fDPYXnDe6g2KtrNXiiZtg/QXMebPIq6wELzeFPm51rgP1+aR9CkjD03fYZ3SR0yZUuj/ff/oOrP2xsh4mcsZR0Stlng/ewV8Vj6HXtG37NDU6QeT6bi/xDTL41McLQtdVrrIq/GVVPSWcxkF8AISpTBEWfrkHnsIoEJMGd5qw2nhOrsrLThg8mn4r+0gbtuf16GorJKHnqzlpuha6VlaAYsO0eWrX9qHB7QUzrMt9+duf2uV1Erkff+w223SfWVfN/Q/YBXjMQprSxFMjEoQ5dOrD2VVNdmalBUnvPbxgqo6VGCQyc2EYhdWoGVBsqpG//Zld25+nBciINGiS/Puf2RU0JW+FPrwO7iZU+1nPeeBy8Iluv/amwfferkNUszVHcVhot7FjdEhgAO0aJb+/s1HIv/faLksBEkFjyMwyIjLUZU7xKKcaefLt+dt+sgtjI3oZwIiiIFVmhpm2xsjgV6xgAfn1fCmV0NLxGb7ZKhdMzaaJTgLL93MBZBXNI1WY8PD+b93mW5cGo7uv//cNg92vmYBHlOrUwdF7q8d4VahO03m9FtbV0W27m20/kQBb73Sd1EvixfZGstldCBM35a2sLMo2/aG5TOUFUJvCDewtfSB3v/IvN1x+rVFAozujaJbhkyHyyupXdvp6Oq939swUB44VKZ1K+3POAWeUs5YSGLboQ0zDcrZWAndfInbbuqiv0pSmwuVx/SKKFMyIRmavEY0H4wE+c3Lr1nvetvXZwvSjW7e98tJjN27rT75l30273/2/t7y1d8tNr950PXa81i23/PDmH0p5yx/8ya7353fdsHv3no/dX2dakT3MG+72BwCl3wwh8EH7Hnf7TXbRP+6WHUPqUc1lHbEOXM/ruhGfR/lpbPxKvCB+ai3xX5ObxbPsHID81HKAMytCYTAPbv4/3shwe3icY2BkYGDgAWIxIGZiYATCLiBmAfMYAAmMALl4nGNgYGBkAIKrWsf8QfSWSV8YYDQARc4GigAAeJwtks8rRFEUgM+5bwjbezOykLKQifwFUhZSSqwsWFsoJXYWysJONiRFWUiK0cyG8iM1JYkp5VczLDCThcKKlGJ8776Z+vrOuee9c++58zQposLvQKxWijMWn+NW/CNWFnEjxFkz4vRbnORxAafwArUi8RJxlvgRZ8SamnK+jzfwEc/s0O+JfJ5ecW+rSeI64hNIkd/AJ/E9vBMXIM17q/RsZu2WPMM7FfgUXuGCWhc+pn4NLxDWtnhuDN/hatZ+oduf2ekwbELJn8/pOMz48/j99DKaX0fYu+jt9JAZttmrk3iCtbBPOF+OeBdPwyTxOoT3dlXuvwdr0BDNoe306Pd3ZvWPuJbaA3yR5zirEPfhUWqgz9H/YtpY78ElsUFHdM/BMlQB9x07w7MwJy5I4ClgzqAXx/AgZq9giH4f9KGHacIDeAUn6JlnvzfyemgB5pUsZ+Wb+Acw2Fhw";
//#endregion
//#region src/charts/add-font.ts
/**
* Injects the `'xkcd'` @font-face into the SVG's defs.
*
* 向 SVG 的 defs 中注入 `'xkcd'` @font-face。
*
* @param selection - Root selection to append the `<defs>` into /
*   要追加 `<defs>` 的根 selection
*/
function addFont(selection) {
	selection.append("defs").append("style").attr("type", "text/css").text(`@font-face {
      font-family: "xkcd";
      src: url(${xkcdFontUrl}) format('woff');
    }`);
}
//#endregion
//#region src/charts/get-format-number.ts
/**
* Picks the smallest unit that keeps the number readable.
*
* 选择能让数字保持可读的最小量级单位。
*
* @param n - The number to format / 待格式化的数字
* @returns `1000000` for ≥1e6, `1000` for ≥300, otherwise `1` /
*   ≥1e6 时为 `1000000`，≥300 时为 `1000`，其余为 `1`
*/
function getNumberFormatUnit(n) {
	if (n >= 1e6) return 1e6;
	if (n >= 300) return 1e3;
	return 1;
}
/**
* Formats a number compactly with K/M suffixes.
*
* 使用 K/M 后缀对数字进行紧凑格式化。
*
* @param n - The number to format / 待格式化的数字
* @param type - Magnitude unit; defaults to `1` / 量级单位，默认为 `1`
* @returns Compact string (e.g. `1.2K`, `3M`, `42`) /
*   紧凑字符串（例如 `1.2K`、`3M`、`42`）
* @example
* getFormatNumber(1234, getNumberFormatUnit(1234)) // '1.2K'
*/
function getFormatNumber(n, type = 1) {
	if (type === 1) return `${n}`;
	if (type === 1e6) {
		if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
		return `${(n / 1e6).toFixed(1)}M`;
	}
	if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}K`;
	return `${(n / 1e3).toFixed(1)}K`;
}
//#endregion
//#region src/charts/get-format-timeline.ts
dayjs.extend(duration);
dayjs.extend(relativeTime);
/**
* Chooses the granularity that best fits the given duration.
*
* 为给定的时长选择最合适的粒度。
*
* @param timestamp - Duration in milliseconds / 时长（毫秒）
* @returns `year`, `month`, `week`, or `day` / `year`、`month`、`week` 或 `day`
*/
function getTimestampFormatUnit(timestamp) {
	let timelineUnit = "day";
	if (dayjs.duration(timestamp).asYears() > 1) timelineUnit = "year";
	else if (dayjs.duration(timestamp).asMonths() > 1) timelineUnit = "month";
	else if (dayjs.duration(timestamp).asWeeks() > 1) timelineUnit = "week";
	return timelineUnit;
}
/**
* Formats a duration as a human-readable phrase.
*
* 将时长格式化为人类可读的短语。
*
* @param timestamp - Duration in milliseconds / 时长（毫秒）
* @param type - Granularity; defaults to `day` / 粒度，默认为 `day`
* @returns `'day one'` for zero, otherwise phrases like `'a month'` or `'12 days'` /
*   时长为 0 时返回 `'day one'`，否则返回如 `'a month'`、`'12 days'` 这样的短语
* @example
* getFormatTimeline(0) // 'day one'
* getFormatTimeline(31 * 86400_000, 'month') // 'a month'
*/
function getFormatTimeline(timestamp, type = "day") {
	if (timestamp === 0) return "day one";
	const seconds = Math.floor(timestamp / 1e3);
	const days = Math.floor(seconds / 60 / 60 / 24);
	const weeks = Math.floor(days / 7);
	const months = (days / 30).toFixed(0);
	const years = (days / 365).toFixed(0);
	if (type === "day") {
		if (days === 1) return "a day";
		return `${days} days`;
	} else if (type === "week") {
		if (weeks === 1) return "a week";
		return `${weeks} weeks`;
	} else if (type === "month") {
		if (Number(months) === 1) return "a month";
		return `${months} months`;
	} else {
		if (Number(years) === 1) return "a year";
		return `${years} years`;
	}
}
//#endregion
//#region src/charts/draw-axis.ts
/**
* Draws the x-axis; number-type axes render human-readable durations.
*
* 绘制 x 轴；数值类型的轴向渲染人类可读的时长。
*
* @param selection - Selection to append the axis into / 要追加坐标轴的 selection
* @param config - Axis configuration / 坐标轴配置
*/
function drawXAxis(selection, { xScale, tickCount, moveDown, fontFamily, stroke, type }) {
	const xAxisGenerator = axisBottom(xScale).tickSize(0).tickPadding(6).ticks(tickCount);
	if (type === "Number") {
		let index = 1;
		let unitType = void 0;
		xAxisGenerator.tickFormat((d) => {
			const timestamp = Number(d);
			const tickAmount = selection.selectAll(".xaxis > .tick").nodes().length;
			index++;
			if (timestamp === 0 || tickAmount >= 7 && index % 2 === 0) return " ";
			unitType ??= getTimestampFormatUnit(timestamp);
			return getFormatTimeline(timestamp, unitType);
		});
	}
	selection.append("g").attr("class", "xaxis").attr("transform", `translate(0,${moveDown})`).call(xAxisGenerator);
	selection.selectAll(".domain").attr("filter", "url(#xkcdify)").style("stroke", stroke);
	selection.selectAll(".xaxis > .tick > text").style("font-family", fontFamily).style("font-size", "16px").style("fill", stroke);
}
/**
* Draws the y-axis; log mode emits smart powers-of-ten ticks.
*
* 绘制 y 轴；对数模式下生成智能的 10 的幂次刻度。
*
* @param selection - Selection to append the axis into / 要追加坐标轴的 selection
* @param yAxisOptions - Axis configuration / 坐标轴配置
*/
function drawYAxis(selection, { yScale, tickCount, fontFamily, stroke, useLogScale }) {
	let type = void 0;
	const yAxisGenerator = axisLeft(yScale).tickSize(1).tickPadding(6);
	if (useLogScale) {
		const domain = yScale.domain();
		const maxValue = Math.max(...domain);
		const logTicks = [0];
		let startPower = 0;
		if (maxValue >= 1e4) startPower = 2;
		else if (maxValue >= 100) startPower = 1;
		else if (maxValue >= 10) startPower = 1;
		else {
			if (maxValue <= 5) logTicks.push(Math.ceil(maxValue));
			else logTicks.push(5, Math.ceil(maxValue));
			yAxisGenerator.tickValues(logTicks).tickFormat((d) => {
				if (d === 0) return "0";
				return d.toString();
			});
			selection.append("g").attr("class", "yaxis").call(yAxisGenerator);
			selection.selectAll(".domain").attr("filter", "url(#xkcdify)").style("stroke", stroke);
			selection.selectAll(".yaxis > .tick > text").style("font-family", fontFamily).style("font-size", "16px").style("fill", stroke);
			return;
		}
		let power = startPower;
		let count = 1;
		const maxTicks = 6;
		while (10 ** power <= maxValue && count < maxTicks) {
			const tick = 10 ** power;
			logTicks.push(tick);
			count++;
			power++;
		}
		if (count < maxTicks && maxValue > logTicks[logTicks.length - 1]) {
			if (maxValue > logTicks[logTicks.length - 1] * 2) logTicks.push(10 ** Math.ceil(Math.log10(maxValue)));
		}
		yAxisGenerator.tickValues(logTicks).tickFormat((d) => {
			if (d === 0) return "0";
			type ??= getNumberFormatUnit(d);
			return getFormatNumber(d, type);
		});
	} else yAxisGenerator.ticks(tickCount, "s").tickFormat((d) => {
		if (d === 0) return " ";
		type ??= getNumberFormatUnit(d);
		return getFormatNumber(d, type);
	});
	selection.append("g").attr("class", "yaxis").call(yAxisGenerator);
	selection.selectAll(".domain").attr("filter", "url(#xkcdify)").style("stroke", stroke);
	selection.selectAll(".yaxis > .tick > text").style("font-family", fontFamily).style("font-size", "16px").style("fill", stroke);
}
//#endregion
//#region src/charts/draw-labels.ts
/**
* Draws the centered chart title, optionally with a circular owner logo.
*
* 绘制居中的图表标题，可选地附带圆形 owner 头像。
*
* The logo and the text are laid out as one group (`[logo][gap][text]`) and
* the whole group is horizontally centered. A fixed pixel offset from the
* text center would overlap long titles and leave short ones off-center.
*
* logo 与文字作为一组（`[logo][间距][文字]`）整体水平居中；若按固定像素
* 偏移放置 logo，长标题会与其重叠，短标题又会整体偏离中心。
*
* @param selection - Selection to append the title into / 要追加标题的 selection
* @param text - Title text / 标题文字
* @param logoURL - Avatar URL; `''` skips the logo / 头像 URL，为空时跳过 logo
* @param color - Text color / 文字颜色
* @param chartWidth - Chart width in px; used to place the logo precisely /
*   图表宽度（像素），用于精确放置 logo
*/
function drawTitle(selection, text, logoURL, color, chartWidth) {
	let logoX = "38%", clipX = "39.5%";
	if (selection.node()?.getBoundingClientRect()) {
		logoX = selection.node()?.getBoundingClientRect().width * .5 - 84;
		clipX = selection.node()?.getBoundingClientRect().width * .5 - 73;
	}
	if (chartWidth) {
		logoX = chartWidth * .5 - 84;
		clipX = chartWidth * .5 - 73;
	}
	selection.append("text").style("font-size", "20px").style("font-weight", "bold").style("fill", color).attr("x", "50%").attr("y", 30).attr("text-anchor", "middle").text(text);
	selection.append("svg").append("defs").append("clipPath").attr("id", "clip-circle-title").append("circle").attr("r", 11).attr("cx", clipX).attr("cy", 23);
	if (logoURL) selection.append("image").attr("x", logoX).attr("y", 12).attr("height", 22).attr("width", 22).attr("href", logoURL).attr("clip-path", "url(#clip-circle-title)");
}
/**
* Draws the centered x-axis label at the bottom of the chart.
*
* 在图表底部绘制居中的 x 轴标签。
*
* @param selection - Selection to append the label into / 要追加标签的 selection
* @param text - Label text / 标签文字
* @param color - Text color / 文字颜色
*/
function drawXLabel(selection, text, color) {
	selection.append("text").style("font-size", "17px").style("fill", color).attr("x", "50%").attr("y", (selection.attr("height") || 10) - 10).attr("text-anchor", "middle").text(text);
}
/**
* Draws the rotated y-axis label along the left edge of the chart.
*
* 绘制图表左侧旋转 90 度的 y 轴标签。
*
* @param selection - Selection to append the label into / 要追加标签的 selection
* @param text - Label text / 标签文字
* @param color - Text color / 文字颜色
* @param offsetY - Vertical offset of the label / 标签的垂直偏移
*/
function drawYLabel(selection, text, color, offsetY = 6) {
	selection.append("text").attr("text-anchor", "end").attr("dy", ".75em").attr("transform", "rotate(-90)").style("font-size", "17px").style("fill", color).text(text).attr("y", offsetY).call((f) => {
		let textLength = 100;
		if (f.node()?.getComputedTextLength) textLength = f.node()?.getComputedTextLength();
		const offsetX = Math.floor(textLength / 2 - (selection.attr("height") || 10) / 2);
		f.attr("x", offsetX);
	});
}
//#endregion
//#region src/charts/draw-legend.ts
/**
* Draws the dataset legend (color swatches, owner logos, labels).
*
* 绘制数据集图例（色块、所有者 logo、标签）。
*
* @param selection - Selection to append the legend into / 要追加图例的 selection
* @param config - Legend configuration / 图例配置
*/
function drawLegend(selection, { items, strokeColor, backgroundColor, legendPosition, chartWidth, chartHeight }) {
	const legendXPadding = 7;
	const xkcdCharWidth = 7;
	const xkcdCharHeight = 20;
	const colorBlockWidth = 8;
	const logoSize = 14;
	const legend = selection.append("svg");
	const backgroundLayer = legend.append("svg");
	const textLayer = legend.append("svg");
	let maxTextLength = 0;
	const shouldDrawLogo = uniq(items.map((i) => i.text.split("/")[0])).length > 1;
	items.forEach((item) => {
		maxTextLength = Math.max(item.text.length, maxTextLength);
	});
	let bboxWidth = maxTextLength * 7.5 + colorBlockWidth + legendXPadding;
	const backgroundWidth = Math.max(bboxWidth + 14, maxTextLength * xkcdCharWidth + colorBlockWidth + 14 + 6 + (shouldDrawLogo ? 21 : 0));
	const backgroundHeight = items.length * xkcdCharHeight + 12;
	let legendX = 8;
	let legendY = 5;
	if (legendPosition === "bottom-right") {
		legendX = chartWidth - backgroundWidth - 8;
		legendY = chartHeight - backgroundHeight - 15;
	}
	items.forEach((item, i) => {
		textLayer.append("rect").style("fill", item.color).attr("width", colorBlockWidth).attr("height", colorBlockWidth).attr("rx", 2).attr("ry", 2).attr("filter", "url(#xkcdify)").attr("x", legendX + legendXPadding).attr("y", legendY + 12 + xkcdCharHeight * i);
		if (shouldDrawLogo) {
			textLayer.append("defs").append("clipPath").attr("id", `clip-circle-title-${item.text}`).append("circle").attr("r", logoSize / 2).attr("cx", legendX + legendXPadding + colorBlockWidth + legendXPadding + logoSize / 2).attr("cy", legendY + 12 + xkcdCharHeight * i - 4 + logoSize / 2);
			textLayer.append("image").attr("x", legendX + legendXPadding + colorBlockWidth + legendXPadding).attr("y", legendY + 12 + xkcdCharHeight * i - 4).attr("height", logoSize).attr("width", logoSize).attr("href", item.logo).attr("clip-path", `url(#clip-circle-title-${item.text})`);
		}
		textLayer.append("text").style("font-size", "15px").style("fill", strokeColor).attr("x", legendX + legendXPadding + colorBlockWidth + (shouldDrawLogo ? 21 : 0) + 6).attr("y", legendY + 12 + xkcdCharHeight * i + 8).text(item.text);
	});
	if (textLayer.node()?.getBBox) bboxWidth = textLayer.node()?.getBBox().width;
	backgroundLayer.append("rect").style("fill", backgroundColor).attr("fill-opacity", .85).attr("stroke", strokeColor).attr("stroke-width", 2).attr("rx", 5).attr("ry", 5).attr("filter", "url(#xkcdify)").attr("width", backgroundWidth).attr("height", backgroundHeight).attr("x", legendX).attr("y", legendY);
}
//#endregion
//#region src/charts/ToolTip.ts
/**
* An xkcd-styled tooltip for the chart's data points.
*
* 图表数据点的 xkcd 风格工具提示。
*
* Starts hidden (`visibility: hidden`) until `show()` is called. In Node
* environments (image export) it is never shown, so it never measures text.
*
* 初始隐藏（`visibility: hidden`），直到调用 `show()`。在 Node 环境（图片
* 导出）中从不显示，因此也不会进行文本测量。
*/
var ToolTip = class {
	/**
	* Tooltip headline / 工具提示的标题。
	*/
	title;
	/**
	* Rows shown below the title / 标题下方的数据行。
	*/
	items;
	/**
	* Anchor point and opening direction / 锚点位置与弹出方向。
	*/
	position;
	/**
	* Background fill color / 背景填充颜色。
	*/
	backgroundColor;
	/**
	* Text and border color / 文字与边框颜色。
	*/
	strokeColor;
	/**
	* Wobble filter applied to the background / 应用于背景的抖动滤镜。
	*/
	filter = "url(#xkcdify)";
	/**
	* Root element of the tooltip / 工具提示的根元素。
	*/
	svg;
	/**
	* Title text element / 标题文本元素。
	*/
	tipTitle;
	/**
	* Per-row groups (swatch + label) / 每行分组（色块 + 标签）。
	*/
	tipItems;
	/**
	* Background rectangle / 背景矩形。
	*/
	tipBackground;
	/**
	* Creates a new (initially hidden) tooltip.
	*
	* 创建新的（初始隐藏的）工具提示。
	*
	* @param config - Tooltip configuration / 工具提示配置
	*/
	constructor({ selection, title, items, position, backgroundColor, strokeColor }) {
		this.title = title;
		this.items = items;
		this.position = position;
		this.backgroundColor = backgroundColor;
		this.strokeColor = strokeColor;
		this.svg = selection.append("svg").attr("x", this._getUpLeftX()).attr("y", this._getUpLeftY()).style("visibility", "hidden");
		this.tipBackground = this.svg.append("rect").style("fill", this.backgroundColor).attr("fill-opacity", .9).attr("stroke", strokeColor).attr("stroke-width", 2).attr("rx", 5).attr("ry", 5).attr("filter", this.filter).attr("width", this._getBackgroundWidth()).attr("height", this._getBackgroundHeight()).attr("x", 5).attr("y", 5);
		this.tipTitle = this.svg.append("text").style("font-size", "15px").style("font-weight", "bold").style("fill", this.strokeColor).attr("x", 15).attr("y", 25).text(title);
		this.tipItems = items.map((item, i) => {
			return this._generateTipItem(item, i);
		});
	}
	/**
	* Makes the tooltip visible / 显示工具提示。
	*/
	show() {
		this.svg.style("visibility", "visible");
	}
	/**
	* Hides the tooltip / 隐藏工具提示。
	*/
	hide() {
		this.svg.style("visibility", "hidden");
	}
	/**
	* Refreshes the tooltip's title, rows, or anchor position.
	*
	* 更新工具提示的标题、数据行或锚点位置。
	*
	* @param config - Partial/total tooltip state; unchanged props are kept /
	*   部分或完整的工具提示状态；未变化的属性保持不变
	*/
	update({ title, items, position }) {
		if (title && title !== this.title) {
			this.title = title;
			this.tipTitle.text(title);
		}
		if (items && JSON.stringify(items) !== JSON.stringify(this.items)) {
			this.items = items;
			this.tipItems.forEach((g) => g.svg.remove());
			this.tipItems = this.items.map((item, i) => {
				return this._generateTipItem(item, i);
			});
			const maxWidth = Math.max(...this.tipItems.map((item) => item.width), this.tipTitle.node().getBBox().width);
			this.tipBackground.attr("width", maxWidth + 15).attr("height", this._getBackgroundHeight());
		}
		if (position) {
			this.position = position;
			this.svg.attr("x", this._getUpLeftX());
			this.svg.attr("y", this._getUpLeftY());
		}
	}
	/**
	* Builds one row (color swatch + label) and measures its dimensions.
	*
	* 构建一行（色块 + 标签）并测量其尺寸。
	*
	* @param item - Row content / 行内容
	* @param i - Row index, used for vertical stacking / 行索引，用于垂直排布
	* @returns The appended row group with its measured size /
	*   追加的行分组及其测量尺寸
	*/
	_generateTipItem(item, i) {
		const svg = this.svg.append("svg");
		svg.append("rect").style("fill", item.color).attr("width", 8).attr("height", 8).attr("rx", 2).attr("ry", 2).attr("filter", this.filter).attr("x", 15).attr("y", 37 + 20 * i);
		svg.append("text").style("font-size", "15px").style("fill", this.strokeColor).attr("x", 27).attr("y", 37 + 20 * i + 8).text(item.text);
		const bbox = svg.node().getBBox();
		return {
			svg,
			width: bbox.width + 15,
			height: bbox.height + 10
		};
	}
	/**
	* Background width estimated from the longest row text (no DOM measurement).
	*
	* 根据最长行文本估算背景宽度（无需 DOM 测量）。
	*
	* @returns Estimated width in px / 估算的宽度（像素）
	*/
	_getBackgroundWidth() {
		const maxItemLength = this.items.reduce((pre, cur) => pre > cur.text.length ? pre : cur.text.length, 0);
		return Math.max(maxItemLength, this.title.length) * 7.4 + 25;
	}
	/**
	* Background height for the title plus one row per item.
	*
	* 标题加每行条目对应的背景高度。
	*
	* @returns Estimated height in px / 估算的高度（像素）
	*/
	_getBackgroundHeight() {
		return (this.items.length + 1) * 20 + 10;
	}
	/**
	* Left-most x of the tip, keeping left-opening tips left of the anchor.
	*
	* 提示的最左 x 坐标，向左展开的提示保持在锚点左侧。
	*
	* @returns X position for the root element / 根元素的 x 位置
	*/
	_getUpLeftX() {
		if (this.position.type === "up_right" || this.position.type === "down_right") return this.position.x;
		return this.position.x - this._getBackgroundWidth() - 20;
	}
	/**
	* Top-most y of the tip, keeping down-opening tips below the anchor.
	*
	* 提示的最上 y 坐标，向下展开的提示保持在锚点下方。
	*
	* @returns Y position for the root element / 根元素的 y 位置
	*/
	_getUpLeftY() {
		if (this.position.type === "down_left" || this.position.type === "down_right") return this.position.y;
		return this.position.y - this._getBackgroundHeight() - 20;
	}
};
//#endregion
//#region src/charts/xy-chart.ts
/**
* Base chart padding, copied per render so consecutive renders never
* contaminate each other's state.
*
* 图表的基础留白，每次渲染复制一份，避免连续渲染之间相互污染状态。
*/
const margin = {
	top: 50,
	right: 55,
	bottom: 50,
	left: 50
};
/**
* Default options for the light theme (or any theme when unspecified).
*
* 浅色主题（或未指定主题时）的默认选项。
*
* @param transparent - Whether to use a transparent background /
*   是否使用透明背景
* @returns The default options / 默认选项
*/
const getDefaultOptions = (transparent) => ({
	envType: "node",
	xTickLabelType: "Date",
	dateFormat: "MMM DD, YYYY",
	xTickCount: 5,
	yTickCount: 5,
	showLine: true,
	dotSize: .5,
	dataColors: colors,
	fontFamily: "xkcd",
	backgroundColor: transparent ? "transparent" : "white",
	strokeColor: "black",
	legendPosition: "top-left"
});
/**
* Default options for the dark theme.
*
* 深色主题的默认选项。
*
* @param transparent - Whether to use a transparent background /
*   是否使用透明背景
* @returns The default options with the dark palette and background /
*   使用深色调色板与背景的默认选项
*/
const getDarkThemeDefaultOptions = (transparent) => ({
	...getDefaultOptions(transparent),
	dataColors: darkColors,
	backgroundColor: transparent ? "transparent" : "#0d1117",
	strokeColor: "white"
});
/**
* Renders an xkcd-style line chart into the given SVG element.
*
* 将 xkcd 风格的折线图渲染到给定的 SVG 元素中。
*
* @param svg - Target SVG element; existing content is cleared /
*   目标 SVG 元素，已存在的内容会被清空
* @param param1 - Chart-level config, destructured by the function /
*   图表级配置，由函数解构
* @param initialOptions - Partial options merged over the theme defaults /
*   部分选项，会在主题默认值之上合并
* @example
* XYChart(svg, { title: 'owner/repo', xLabel: 'Date', yLabel: 'Stars',
*   data, showDots: true, transparent: false, theme: 'light' },
*   { envType: 'node', chartWidth: 960 })
*/
function XYChart(svg, { title, xLabel, yLabel, data: { datasets }, showDots, theme, transparent }, initialOptions) {
	const options = {
		...theme === "dark" ? getDarkThemeDefaultOptions(transparent) : getDefaultOptions(transparent),
		...initialOptions
	};
	const m = { ...margin };
	if (title) m.top = 60;
	if (xLabel) m.bottom = 50;
	if (yLabel) m.left = 70;
	const data = { datasets };
	const filter = "url(#xkcdify)";
	const fontFamily = options.fontFamily || "xkcd";
	const clientWidth = Number(svg.clientWidth > 0 ? svg.clientWidth : svg.getAttribute("width") ?? "") || 600;
	const clientHeight = clientWidth * 2 / 3;
	const d3Selection = select(svg).style("stroke-width", 3).style("font-family", fontFamily).style("background", options.backgroundColor).attr("width", clientWidth).attr("height", clientHeight).attr("preserveAspectRatio", "xMidYMid meet");
	if (options.envType === "browser") d3Selection.attr("width", clientWidth <= 600 ? 600 : "100%").attr("viewBox", `0 0 ${clientWidth <= 600 ? 600 : clientWidth} ${clientHeight}`);
	d3Selection.selectAll("*").remove();
	addFont(d3Selection);
	addFilter(d3Selection);
	if (options.envType === "browser") d3Selection.append("style").text(`
            @keyframes lobster-swim {
                0%, 100% { transform: translate(0, 0) rotate(0deg); }
                25% { transform: translate(2px, -3px) rotate(-5deg); }
                50% { transform: translate(0, -5px) rotate(0deg); }
                75% { transform: translate(-2px, -3px) rotate(5deg); }
            }
            .moltbot-emoji {
                animation: lobster-swim 1.5s ease-in-out infinite;
                transform-origin: center;
                transform-box: fill-box;
            }
        `);
	const chart = d3Selection.append("g").attr("transform", `translate(${m.left},${m.top})`);
	const tooltip = new ToolTip({
		selection: d3Selection,
		title: "",
		items: [],
		position: {
			x: 60,
			y: 60,
			type: "up_left"
		},
		strokeColor: options.strokeColor,
		backgroundColor: options.backgroundColor
	});
	if (options.xTickLabelType === "Date") data.datasets.forEach((dataset) => {
		dataset.data.forEach((d) => {
			d.x = dayjs(d.x);
		});
	});
	const allData = [];
	data.datasets.map((d) => allData.push(...d.data));
	const allXData = allData.map((d) => d.x);
	const allYData = allData.map((d) => d.y);
	const chartWidth = clientWidth - m.left - m.right;
	const chartHeight = clientHeight - m.top - m.bottom;
	let xScale = scaleTime().domain([Math.min(...allXData.map((d) => Number(d))), Math.max(...allXData.map((d) => Number(d)))]).range([0, chartWidth]);
	if (options.xTickLabelType === "Number") xScale = scaleLinear().domain([0, Math.max(...allXData.map((d) => Number(d)))]).range([0, chartWidth]);
	let yScale;
	if (options.useLogScale) {
		const maxYData = Math.max(...allYData);
		yScale = scaleSymlog().domain([0, maxYData]).range([chartHeight, 0]).constant(10);
	} else yScale = scaleLinear().domain([0, Math.max(...allYData)]).range([chartHeight, 0]);
	const svgChart = chart.append("g").attr("pointer-events", "all");
	if (title) {
		if (uniq(datasets.map((d) => d.label.split("/")[0])).length === 1) drawTitle(d3Selection, title, datasets[0].logo, options.strokeColor, options.chartWidth);
		else drawTitle(d3Selection, title, "", options.strokeColor, options.chartWidth);
	}
	if (xLabel) drawXLabel(d3Selection, xLabel, options.strokeColor);
	if (yLabel) {
		const maxYData = Math.max(...allYData);
		let offsetY = 24;
		if (maxYData > 1e5) offsetY = 2;
		else if (maxYData > 1e4) offsetY = 8;
		else if (maxYData > 1e3) offsetY = 12;
		else if (maxYData > 100) offsetY = 20;
		drawYLabel(d3Selection, yLabel, options.strokeColor, offsetY);
	}
	drawXAxis(svgChart, {
		xScale,
		tickCount: options.xTickCount,
		moveDown: chartHeight,
		fontFamily,
		stroke: options.strokeColor,
		type: options.xTickLabelType
	});
	drawYAxis(svgChart, {
		yScale,
		tickCount: options.yTickCount,
		fontFamily,
		stroke: options.strokeColor,
		useLogScale: options.useLogScale
	});
	if (options.showLine) {
		const drawLine = line().x((d) => xScale(d.x) ?? 0).y((d) => yScale(d.y) ?? 0).curve(curveMonotoneX);
		svgChart.selectAll(".xkcd-chart-xyline").data(data.datasets).enter().append("path").attr("class", "xkcd-chart-xyline").attr("d", (d) => drawLine(d.data)).attr("fill", "none").attr("stroke", (_, i) => options.dataColors[i]).attr("filter", filter);
	}
	if (showDots) {
		const dotInitSize = 3.5 * (options.dotSize ?? 1);
		const dotHoverSize = 6 * (options.dotSize ?? 1);
		svgChart.selectAll(".xkcd-chart-xycircle-group").data(data.datasets).enter().append("g").attr("class", "xkcd-chart-xycircle-group").attr("filter", filter).attr("xy-group-index", (_, i) => i).selectAll(".xkcd-chart-xycircle-circle").data((dataset) => dataset.data).enter().append("circle").attr("class", "chart-tooltip-dot").style("stroke", (_, i, nodes) => {
			const xyGroupIndex = Number(select(nodes[i].parentElement).attr("xy-group-index"));
			return options.dataColors[xyGroupIndex];
		}).style("fill", (_, i, nodes) => {
			const xyGroupIndex = Number(select(nodes[i].parentElement).attr("xy-group-index"));
			return options.dataColors[xyGroupIndex];
		}).attr("r", dotInitSize).attr("cx", (d) => xScale(d.x) ?? 0).attr("cy", (d) => yScale(d.y) ?? 0).attr("pointer-events", "all").on("mouseover", (event, d) => {
			if (window === void 0) return;
			const nodes = event.currentTarget.parentNode.childNodes ?? [];
			const i = [...nodes].indexOf(event.target);
			const xyGroupIndex = Number(select(nodes[i].parentElement).attr("xy-group-index"));
			select(nodes[i]).attr("r", dotHoverSize);
			const tipX = (xScale(d.x) ?? 0) + m.left + 5;
			const tipY = (yScale(d.y) ?? 0) + m.top + 5;
			let tooltipPositionType = "down_right";
			if (tipX > chartWidth / 2 && tipY < chartHeight / 2) tooltipPositionType = "down_left";
			else if (tipX > chartWidth / 2 && tipY > chartHeight / 2) tooltipPositionType = "up_left";
			else if (tipX < chartWidth / 2 && tipY > chartHeight / 2) tooltipPositionType = "up_right";
			let formattedTitle = dayjs(data.datasets[xyGroupIndex].data[i].x).format(options.dateFormat);
			if (options.xTickLabelType === "Number") {
				const type = getTimestampFormatUnit(Number(data.datasets[xyGroupIndex].data[1].x || data.datasets[xyGroupIndex].data[i].x));
				formattedTitle = getFormatTimeline(Number(data.datasets[xyGroupIndex].data[i].x), type);
			}
			tooltip.update({
				title: formattedTitle,
				items: [{
					color: options.dataColors[xyGroupIndex],
					text: `${data.datasets[xyGroupIndex].label || ""}: ${d.y}`
				}],
				position: {
					x: tipX,
					y: tipY,
					type: tooltipPositionType
				},
				selection: d3Selection,
				backgroundColor: options.backgroundColor,
				strokeColor: options.strokeColor
			});
			tooltip.show();
		}).on("mouseout", (event) => {
			const nodes = event.currentTarget.parentNode.childNodes ?? [];
			if (!nodes.length) return;
			const i = [...nodes].indexOf(event.target);
			select(nodes[i]).attr("r", dotInitSize);
			tooltip.hide();
		});
	}
	drawLegend(svgChart, {
		items: data.datasets.map((dataset, i) => ({
			color: options.dataColors[i] ?? "",
			text: dataset.label,
			logo: dataset.logo
		})),
		strokeColor: options.strokeColor,
		backgroundColor: options.backgroundColor,
		legendPosition: options.legendPosition ?? "top-left",
		chartWidth,
		chartHeight
	});
}
//#endregion
//#region src/render.ts
/**
* Renders a complete standalone SVG string for a single theme.
*
* 为单个主题渲染完整的独立 SVG 字符串。
*
* @param input - Chart rendering inputs / 图表渲染输入
* @returns The serialized SVG markup / 序列化后的 SVG 标记
* @example
* const svg = renderStarHistorySvg({
*   repo: 'owner/repo',
*   logo: '',
*   records,
*   theme: 'dark',
*   width: 960,
* })
*/
function renderStarHistorySvg(input) {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	const { document } = dom.window;
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	svg.setAttribute("width", String(input.width));
	XYChart(svg, {
		title: "Star History",
		xLabel: "Date",
		yLabel: "Stars",
		data: { datasets: [{
			label: input.repo,
			logo: input.logo,
			data: input.records.map((record) => ({
				x: /* @__PURE__ */ new Date(`${record.date}T00:00:00Z`),
				y: record.stars
			}))
		}] },
		showDots: true,
		transparent: false,
		theme: input.theme
	}, {
		envType: "node",
		chartWidth: input.width
	});
	svg.querySelectorAll(".browser-only").forEach((el) => el.remove());
	const output = fixJsdomSvgCasing(svg.outerHTML);
	dom.window.close();
	return optimize(output, { multipass: true }).data;
}
function fixJsdomSvgCasing(svgContent) {
	return svgContent.replace(/feturbulence/g, "feTurbulence").replace(/fedisplacementmap/g, "feDisplacementMap").replace(/filterunits/g, "filterUnits").replace(/basefrequency/g, "baseFrequency").replace(/xchannelselector/g, "xChannelSelector").replace(/ychannelselector/g, "yChannelSelector").replace(/\btextlength=/g, "textLength=").replace(/\blengthadjust=/g, "lengthAdjust=");
}
//#endregion
//#region src/utils.ts
/**
* Formats an epoch timestamp as a UTC date string in `YYYY-MM-DD` form.
*
* 将毫秒级时间戳格式化为 `YYYY-MM-DD` 形式的 UTC 日期字符串。
*
* @param date - Epoch timestamp in milliseconds / 毫秒级时间戳
* @returns The date in `YYYY-MM-DD` format / `YYYY-MM-DD` 格式的日期字符串
* @example
* formatDate(Date.parse('2024-01-05T00:00:00Z')) // '2024-01-05'
*/
function formatDate(date) {
	return new Date(date).toISOString().substring(0, 10);
}
/**
* Optimizes an image buffer using imagemin.
*
* 使用 imagemin 优化图像缓冲区。
*
* @param image - Image buffer to optimize / 要优化的图像缓冲区
* @returns The optimized image buffer / 优化后的图像缓冲区
* @example
* const optimized = await optimizeImage(buf)
*/
function optimizeImage(image) {
	return imagemin.buffer(image, { plugins: [imageminJpegtran(), imageminPngquant({ quality: [.6, .8] })] });
}
//#endregion
//#region src/services/api.ts
const API_BASE = GITHUB_API_URL.replace(/\/+$/, "");
/**
* Extracts the page number of the `rel="last"` link from a GitHub Link header.
*
* 从 GitHub Link 响应头中提取 `rel="last"` 链接的页码。
*
* Parsing through the URL search params (instead of a positional regex)
* tolerates instances that order query params differently (e.g.
* `?page=2&per_page=100`) or omit them, as some GHES instances do.
*
* 通过 URL 查询参数解析（而非位置正则），可以兼容部分 GHES 实例中查询参数
* 顺序不同（例如 `?page=2&per_page=100`）或省略参数的情况。
*
* @param link - Raw value of the `Link` response header / `Link` 响应头的原始值
* @returns The page count, or null when the header is missing or malformed /
*   页码总数；响应头缺失或格式非法时返回 null
*/
function parseLastPage(link) {
	const match = /<([^>]+)>\s*;\s*rel="last"/.exec(link);
	if (!match) return null;
	const parsed = Number.parseInt(new URL(match[1]).searchParams.get("page") ?? "", 10);
	return isInteger(parsed) && parsed > 0 ? parsed : null;
}
/**
* Normalizes a `starred_at` payload — epoch ms numbers pass through,
* ISO 8601 strings are parsed to epoch ms.
*
* 归一化 `starred_at` 负载——毫秒时间戳原样通过，ISO 8601 字符串解析为毫秒。
*
* @param value - Raw `starred_at` value / `starred_at` 原始值
* @returns Epoch milliseconds / 毫秒级时间戳
*/
function parseStarredAt(value) {
	return typeof value === "number" ? value : Date.parse(value);
}
/**
* Fetches a URL with auth and timeout handling.
*
* 带认证与超时处理地请求一个 URL。
*
* @param url - Request target / 请求目标
* @param token - GitHub token used as `Authorization: token` /
*   用于 `Authorization: token` 的 GitHub 令牌
* @param accept - Accept header value / Accept 请求头值
* @returns The fetch response (caller must check `ok` and parse the body) /
*   fetch 响应（调用方需检查 `ok` 并解析响应体）
*/
function request(url, token, accept = REPO_INFO_ACCEPT) {
	const headers = {
		Accept: accept,
		Authorization: `token ${token}`
	};
	return withTimeout((signal) => fetch(url, {
		headers,
		signal
	}), REQUEST_TIMEOUT_MS);
}
/**
* Fetches one page of stargazers and returns their `starred_at` timestamps.
*
* 抓取一页 stargazer 并返回其 `starred_at` 时间戳。
*
* @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
* @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
* @param page - Page number; defaults to page 1 / 页码，默认为第 1 页
* @returns Epoch-ms `starred_at` values for the page, in GitHub's page order /
*   该页的 `starred_at` 毫秒值，顺序与 GitHub 返回的页内顺序一致
* @throws {Error} When the API response is not OK / 当 API 响应非成功状态时抛出
*/
async function getRepoStargazers(repo, token, page) {
	const res = await request(`${API_BASE}/repos/${repo}/stargazers?per_page=100${page ? `&page=${page}` : ""}`, token, STARGAZERS_ACCEPT);
	if (!res.ok) throw new Error(`Failed to get repo ${repo} stargazers: HTTP ${res.status}`);
	return (await res.json()).map((item) => parseStarredAt(item.starred_at));
}
/**
* Builds an ascending `{ date, stars }` series for the repository's history.
*
* 构建仓库历史的按日期升序 `{ date, stars }` 序列。
*
* When the history fits within the request budget, every stargazer is counted
* for a full per-day series. Larger repositories are sampled: one boundary
* point per page, each within ±100 stars of the real count. Page ordering is
* detected from the repo's creation date, falling back to newest-first for
* entries older than the GitHub default fetch of stargazers.
*
* 当历史规模在请求预算以内时，会统计每个 stargazer 生成完整的按日序列；
* 更大的仓库则采样每个页面的一个边界点，每点与真实数量误差在 ±100 以内。
* 页码顺序根据仓库创建日期判定，缺失创建日期时回退到 newest-first。
*
* @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
* @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
* @param maxRequestAmount - Upper bound on the number of pages fetched /
*   抓取序列时最大的页数上限
* @returns Star records ascending by date / 按日期升序的 star 记录
* @throws {Error} When the repo has no stars or an API response is not OK /
*   当仓库没有 star 或 API 响应非成功状态时抛出
*/
async function getRepoStarRecords(repo, token, maxRequestAmount) {
	const repoRes = await request(`${API_BASE}/repos/${repo}`, token);
	if (!repoRes.ok) throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`);
	const repoData = await repoRes.json();
	const total = repoData.stargazers_count ?? 0;
	const createdAt = repoData.created_at ?? "";
	if (total === 0) throw new Error(`Repo ${repo} has no star records`);
	const pageOneRes = await request(`${API_BASE}/repos/${repo}/stargazers?per_page=100&page=1`, token, STARGAZERS_ACCEPT);
	if (!pageOneRes.ok) throw new Error(`Failed to get repo ${repo} star records: HTTP ${pageOneRes.status}`);
	const pageCount = parseLastPage(pageOneRes.headers.get("link") ?? "") ?? 1;
	const firstPageMs = (await pageOneRes.json()).map((item) => parseStarredAt(item.starred_at));
	if (firstPageMs.length === 0) throw new Error(`Repo ${repo} has no star records`);
	const sampled = pageCount > maxRequestAmount;
	const pages = sampled ? Array.from({ length: maxRequestAmount }, (_, k) => 1 + Math.floor((pageCount - 1) * k / (maxRequestAmount - 1))) : range(2, pageCount + 1);
	const pageData = /* @__PURE__ */ new Map();
	pageData.set(1, firstPageMs);
	const restPages = pages.filter((page) => page !== 1);
	const restData = await promiseParallel(restPages.map((page) => getRepoStargazers(repo, token, page)));
	restPages.forEach((page, i) => pageData.set(page, restData[i]));
	const records = /* @__PURE__ */ new Map();
	if (!sampled) [...pageData.values()].flat().sort((a, b) => a - b).forEach((ms, i) => records.set(formatDate(ms), i + 1));
	else {
		const tFirst = firstPageMs[0];
		const createdAtMs = Date.parse(createdAt);
		const ascending = Number.isFinite(createdAtMs) && Math.abs(tFirst - createdAtMs) < Math.abs(Date.now() - tFirst);
		pages.forEach((page) => {
			const arr = pageData.get(page);
			if (arr.length === 0) return;
			const boundaryMs = ascending ? arr[0] : arr[arr.length - 1];
			const count = ascending ? (page - 1) * 100 : total - page * 100;
			records.set(formatDate(boundaryMs), count);
		});
	}
	records.set(formatDate(Date.now()), total);
	return [...records].sort(([a], [b]) => a.localeCompare(b)).map(([date, stars]) => ({
		date,
		stars
	}));
}
/**
* Fetches the owner's avatar URL, or `''` when the user lookup fails.
*
* 获取所有者的头像 URL；用户查询失败时返回空字符串。
*
* @param repo - Repository in `owner/repo` form / `owner/repo` 形式的仓库标识
* @param token - GitHub token for authentication / 用于认证的 GitHub 令牌
* @returns The owner's avatar URL, or `''` on failure / 所有者的头像 URL，失败时为空字符串
*/
async function getRepoLogo(repo, token) {
	const owner = repo.split("/")[0];
	const response = await request(`${API_BASE}/users/${owner}`, token);
	if (response.ok) return (await response.json()).avatar_url || "";
	return "";
}
async function toBase64(url) {
	if (!url) return "";
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
	const type = res.headers.get("content-type") ?? "";
	if (!/^image\//i.test(type)) throw new Error(`unexpected content-type "${type || "none"}"`);
	const buf = Buffer.from(await res.arrayBuffer());
	return `data:${type};base64,${Buffer.from(await optimizeImage(buf)).toString("base64")}`;
}
//#endregion
//#region src/index.ts
/**
* Runs the full action pipeline: parse → fetch → render → write → commit/push.
*
* 运行动作的完整流水线：解析 → 抓取 → 渲染 → 写入 → 提交/推送。
*
* @throws {Error} When any pipeline step fails / 当流水线任一步骤失败时抛出
* @example
* // Entry of the composite action; failures are reported via setFailed.
* void main()
*/
async function run() {
	const config = parseInputs();
	if (!GITHUB_WORKSPACE) throw new Error("GITHUB_WORKSPACE is not set: the action must run on a GitHub runner");
	const workspace = GITHUB_WORKSPACE;
	const outDir = resolve(workspace, config.outputDirectory);
	const isInsideWorkspace = outDir === workspace || outDir.startsWith(`${workspace}${sep}`);
	if (!isAbsolute(outDir) || !isInsideWorkspace) throw new Error("output-directory must point inside the workspace");
	const records = await getRepoStarRecords(config.repo, config.token, 15);
	const logo = await toBase64(await getRepoLogo(config.repo, config.token));
	await mkdir(outDir, { recursive: true });
	const chartFiles = getChartFilePaths(config);
	for (const { theme, file } of chartFiles) {
		const svg = renderStarHistorySvg({
			repo: config.repo,
			logo,
			records,
			theme,
			width: config.svgWidth
		});
		const filePath = join(outDir, file);
		await writeFile(filePath, svg, "utf8");
		info(`wrote ${relative(workspace, filePath)}`);
	}
	commitAndPush({
		cwd: workspace,
		files: chartFiles.map(({ file }) => relative(workspace, join(outDir, file))),
		token: config.token
	});
	info("done");
}
async function main() {
	try {
		await run();
	} catch (error) {
		setFailed(error instanceof Error ? error.message : String(error));
	}
}
main();
//#endregion
export {};
