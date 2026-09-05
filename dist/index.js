import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getInput, info, setFailed } from "@actions/core";
import { JSDOM } from "jsdom";
import { optimize } from "svgo";
import { isInteger, promiseParallel, range, uniq, withTimeout } from "@pengzhanbo/utils";
import { scaleLinear, scaleSymlog, scaleTime } from "d3-scale";
import { select } from "d3-selection";
import { curveMonotoneX, line } from "d3-shape";
import dayjs from "dayjs";
import { readFileSync } from "node:fs";
import subsetFont from "subset-font";
import { axisBottom, axisLeft } from "d3-axis";
import duration from "dayjs/plugin/duration.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import sharp from "sharp";
import { execFileSync, spawnSync } from "node:child_process";
//#region src/common/constants.ts
const REQUEST_TIMEOUT_MS = 15e3;
const REPO_INFO_ACCEPT = "application/vnd.github+json";
const STARGAZERS_ACCEPT = "application/vnd.github.v3.star+json";
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
//#region src/common/font-subset.ts
let ttfBuffer;
function getTtfBuffer() {
	ttfBuffer ??= readFileSync(resolve("assets/xkcd.ttf"));
	return ttfBuffer;
}
let fontDataUrl;
/**
* Returns the full xkcd TrueType font as a data URL, read from
* `assets/xkcd.ttf` at runtime.
*
* 返回完整的 xkcd TrueType 字体 data URL，运行时从 `assets/xkcd.ttf`
* 读取。用于渲染期兜底以及未内联子集字体时仍可显示完整字体。
*
* @returns A fonts/ttf data URL / fonts/ttf data URL
*/
function getXkcdFontUrl() {
	fontDataUrl ??= `data:font/ttf;charset=utf-8;base64,${getTtfBuffer().toString("base64")}`;
	return fontDataUrl;
}
const urlCache = /* @__PURE__ */ new Map();
/**
* Subsets the xkcd font to only the glyphs needed to render `text`, returning
* a woff2 data URL ready to be inlined into the SVG.
*
* 将 xkcd 字体按 `text` 中实际出现的字符做子集化，
* 返回可直接内联进 SVG 的 woff2 data URL。
*
* @param text - All text rendered in the SVG / SVG 中渲染的全部文本
* @returns A woff2 data URL / woff2 data URL
*/
function getSubsetFontUrl(text) {
	const key = text || " ";
	let pending = urlCache.get(key);
	if (!pending) {
		pending = subsetFont(getTtfBuffer(), key, { targetFormat: "woff2" }).then((buf) => `data:font/woff2;charset=utf-8;base64,${buf.toString("base64")}`);
		urlCache.set(key, pending);
	}
	return pending;
}
//#endregion
//#region src/charts/add-font.ts
/**
* Injects the `'xkcd'` @font-face into the SVG's defs.
*
* 向 SVG 的 defs 中注入 `'xkcd'` @font-face。
*
* 字体数据在运行时从 `assets/xkcd.ttf` 读取，因此该函数仅适用于
* Node 渲染环境（action 与图片生成场景）。
*
* @param selection - Root selection to append the `<defs>` into /
*   要追加 `<defs>` 的根 selection
*/
function addFont(selection) {
	selection.append("defs").append("style").attr("type", "text/css").text(`@font-face {
      font-family: "xkcd";
      src: url(${getXkcdFontUrl()}) format('truetype');
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
//#region src/charts/draw-last-value.ts
/**
* Picks a readable pill text color from the background luminance.
*
* 根据背景亮度选择可读的胶囊文字颜色。
*
* @param color - The pill fill color (hex) / 胶囊填充色（十六进制）
* @returns `#000` on light fills, `#fff` otherwise / 亮色填充返回 `#000`，否则返回 `#fff`
*/
function getContrastTextColor(color) {
	const hex = color.startsWith("#") ? color.slice(1) : "";
	if (hex.length !== 6) return "#fff";
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return (.299 * r + .587 * g + .114 * b) / 255 > .6 ? "#000" : "#fff";
}
/**
* Draws a pill label with the formatted latest value at the newest point,
* anchored above the point and flipped below it when the top would clip.
*
* 在最新数据点处绘制带格式化最新值的胶囊标签：默认位于点的上方，
* 当上方超出画布时翻转到点的下方。
*
* @param selection - Selection to append the pill into / 要追加胶囊的 selection
* @param config - Pill configuration / 胶囊配置
*/
function drawLastValue(selection, { value, x, y, color, chartWidth }) {
	const text = getFormatNumber(value, value >= 1e3 ? getNumberFormatUnit(value) : 1);
	const fontSize = 14;
	const height = 24;
	const width = text.length * 6.5 + 16;
	const gap = 10;
	const rectY = y - gap - height < 0 ? y + gap : y - gap - height;
	const centerX = Math.min(Math.max(x, width / 2), chartWidth - width / 2);
	const group = selection.append("g").attr("class", "xkcd-chart-xy-end-value");
	group.append("rect").attr("x", centerX - width / 2).attr("y", rectY).attr("width", width).attr("height", height).attr("rx", height / 2).attr("ry", height / 2).attr("filter", "url(#xkcdify)").style("fill", color);
	group.append("text").attr("x", centerX).attr("y", rectY + height / 2).attr("dy", "0.35em").attr("text-anchor", "middle").style("font-size", `${fontSize}px`).style("font-weight", "bold").style("fill", getContrastTextColor(color)).text(text);
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
	xTickLabelType: "Date",
	xTickCount: 5,
	yTickCount: 5,
	showLine: true,
	dotSize: .5,
	dataColors: colors,
	fontFamily: "xkcd",
	backgroundColor: transparent ? "transparent" : "white",
	strokeColor: "black",
	legendPosition: "top-left",
	showEndValue: true
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
*   { chartWidth: 960 })
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
	d3Selection.selectAll("*").remove();
	addFont(d3Selection);
	addFilter(d3Selection);
	const chart = d3Selection.append("g").attr("transform", `translate(${m.left},${m.top})`);
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
		svgChart.selectAll(".xkcd-chart-xycircle-group").data(data.datasets).enter().append("g").attr("class", "xkcd-chart-xycircle-group").attr("filter", filter).attr("xy-group-index", (_, i) => i).selectAll(".xkcd-chart-xycircle-circle").data((dataset) => dataset.data).enter().append("circle").attr("class", "chart-tooltip-dot").style("stroke", (_, i, nodes) => {
			const xyGroupIndex = Number(select(nodes[i].parentElement).attr("xy-group-index"));
			return options.dataColors[xyGroupIndex];
		}).style("fill", (_, i, nodes) => {
			const xyGroupIndex = Number(select(nodes[i].parentElement).attr("xy-group-index"));
			return options.dataColors[xyGroupIndex];
		}).attr("r", dotInitSize).attr("cx", (d) => xScale(d.x) ?? 0).attr("cy", (d) => yScale(d.y) ?? 0);
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
	if (options.showEndValue) data.datasets.forEach((dataset, i) => {
		const lastPoint = dataset.data[dataset.data.length - 1];
		if (lastPoint) drawLastValue(svgChart, {
			value: lastPoint.y,
			x: xScale(lastPoint.x) ?? 0,
			y: yScale(lastPoint.y) ?? 0,
			color: options.dataColors[i] ?? "",
			chartWidth
		});
	});
}
//#endregion
//#region src/render.ts
/**
* Renders a complete standalone SVG string for a single theme.
*
* The full embedded xkcd font is swapped at the end for a woff2 subset that
* contains only the glyphs used by the actual chart text, cutting the inlined
* font from ~50KB to a few KB.
*
* 为单个主题渲染完整的独立 SVG 字符串。
*
* 渲染完成后会用仅包含图表实际文本字形的小体积 woff2 子集替换内嵌的完整
* xkcd 字体，将内联字体从约 50KB 压缩到几 KB。
*
* @param input - Chart rendering inputs / 图表渲染输入
* @returns The serialized SVG markup / 序列化后的 SVG 标记
* @example
* const svg = await renderStarHistorySvg({
*   repo: 'owner/repo',
*   logo: '',
*   records,
*   theme: 'dark',
*   width: 960,
* })
*/
async function renderStarHistorySvg(input) {
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
		showDots: false,
		transparent: false,
		theme: input.theme
	}, { chartWidth: input.width });
	const styleEl = svg.querySelector("style");
	if (styleEl) try {
		styleEl.textContent = `@font-face { font-family: "xkcd"; src: url(${await getSubsetFontUrl(Array.from(svg.querySelectorAll("text")).map((el) => el.textContent ?? "").join(""))}) format('woff2'); }`;
	} catch {}
	const output = fixJsdomSvgCasing(svg.outerHTML);
	dom.window.close();
	return optimize(output, { multipass: true }).data;
}
function fixJsdomSvgCasing(svgContent) {
	return svgContent.replace(/feturbulence/g, "feTurbulence").replace(/fedisplacementmap/g, "feDisplacementMap").replace(/filterunits/g, "filterUnits").replace(/basefrequency/g, "baseFrequency").replace(/xchannelselector/g, "xChannelSelector").replace(/ychannelselector/g, "yChannelSelector").replace(/\btextlength=/g, "textLength=").replace(/\blengthadjust=/g, "lengthAdjust=");
}
/**
* Optimizes an image buffer: scales it down to `AVATAR_SIZE` and compresses
* it with quality loss (jpeg/webp/avif) or palette quantization (png) so the
* base64-embedded logo stays small. SVG inputs and undecodable buffers are
* returned untouched.
*
* 优化图像缓冲区：将图像缩放到 `AVATAR_SIZE`，并以有损方式压缩
* （jpeg/webp/avif）或调色板量化（png），使 base64 内嵌的 logo 保持较小。
* SVG 输入与无法解码的缓冲区原样返回。
*
* @param image - Image buffer to optimize / 要优化的图像缓冲区
* @returns The optimized image buffer / 优化后的图像缓冲区
* @example
* ```ts
* const optimized = await optimizeImage(buf)
* ```
*/
async function optimizeImage(image) {
	try {
		const img = sharp(image);
		const { format } = await img.metadata();
		if (!format || format === "svg") return image;
		const resized = img.resize({
			width: 128,
			height: 128,
			fit: "cover"
		});
		return await (format === "jpeg" ? resized.jpeg({ quality: 70 }) : format === "png" ? resized.png({
			palette: true,
			quality: 70
		}) : format === "webp" ? resized.webp({ quality: 70 }) : format === "heif" ? resized.avif({ quality: 70 }) : resized).toBuffer();
	} catch {
		return image;
	}
}
//#endregion
//#region src/services/env.ts
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
//#region src/services/utils.ts
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
	if (response.ok) {
		const data = await response.json();
		if (!data.avatar_url) return "";
		const url = new URL(data.avatar_url);
		url.searchParams.set("s", String(128));
		return url.toString();
	}
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
//#region src/services/config.ts
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
//#region src/services/git.ts
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
		const svg = await renderStarHistorySvg({
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
