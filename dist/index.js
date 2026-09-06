import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getInput, info, setFailed, warning } from "@actions/core";
import { readFileSync } from "node:fs";
import subsetFont from "subset-font";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
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
import { setTimeout } from "node:timers/promises";
import { execFileSync, spawnSync } from "node:child_process";

let ttfBuffer;
function getTtfBuffer() {
	ttfBuffer ??= readFileSync(resolve("assets/xkcd.ttf"));
	return ttfBuffer;
}
let fontDataUrl;

function getXkcdFontUrl() {
	fontDataUrl ??= `data:font/ttf;charset=utf-8;base64,${getTtfBuffer().toString("base64")}`;
	return fontDataUrl;
}
const urlCache =  new Map();

function getSubsetFontUrl(text) {
	const key = text || " ";
	let pending = urlCache.get(key);
	if (!pending) {
		pending = subsetFont(getTtfBuffer(), key, { targetFormat: "woff2" }).then((buf) => `data:font/woff2;charset=utf-8;base64,${buf.toString("base64")}`);
		urlCache.set(key, pending);
	}
	return pending;
}



const LIGHT_COLORS = {
	background: "transparent",
	gridStroke: "#ccc",
	outerStroke: "#999",
	axisStroke: "#bbb",
	levelLabel: "#999",
	axisLabel: "#555",
	dataColor: "#16a34a",
	dotStroke: "white"
};
const DARK_COLORS = {
	background: "#0d1117",
	gridStroke: "#30363d",
	outerStroke: "#484f58",
	axisStroke: "#3d444d",
	levelLabel: "#7d8590",
	axisLabel: "#8b949e",
	dataColor: "#2ea043",
	dotStroke: "#0d1117"
};

const LABELS = [
	"Stars",
	"New Stars",
	"Issues Closed",
	"Contributors",
	"Pushes",
	"Forks"
];

const KEYS = [
	"stars",
	"new_stars",
	"issues_closed",
	"contributors",
	"pushes",
	"forks"
];

const LEVELS = [
	25,
	50,
	75
];

function createRng(seed) {
	let s = seed | 0;
	return () => {
		s = s * 1664525 + 1013904223 | 0;
		return (s >>> 0) / 4294967296;
	};
}

function sketchyPolygonPath(points, jitter, rng, closed = true) {
	if (points.length < 2) return "";
	const segments = [];
	const len = closed ? points.length : points.length - 1;
	for (let i = 0; i < len; i++) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[(i + 1) % points.length];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const nx = -dy / (dist || 1);
		const ny = dx / (dist || 1);
		const steps = Math.max(Math.round(dist / 8), 3);
		for (let s = 0; s <= steps; s++) {
			const t = s / steps;
			const px = x0 + dx * t;
			const py = y0 + dy * t;
			const wobbleScale = Math.sin(t * Math.PI);
			const offset = (rng() - .5) * 2 * jitter * wobbleScale;
			const fx = px + nx * offset;
			const fy = py + ny * offset;
			if (i === 0 && s === 0) segments.push(`M ${fx.toFixed(1)},${fy.toFixed(1)}`);
			else segments.push(`L ${fx.toFixed(1)},${fy.toFixed(1)}`);
		}
	}
	if (closed) segments.push("Z");
	return segments.join(" ");
}

async function renderRadarSvg(attributes, options = {}) {
	const theme = options.theme ?? "light";
	const size = options.size ?? 400;
	const colors = theme === "dark" ? DARK_COLORS : LIGHT_COLORS;
	const radius = (size - 140) / 2;
	const cx = size / 2;
	const cy = size / 2;
	const numAxes = LABELS.length;
	const angleSlice = Math.PI * 2 / numAxes;
	const rng = createRng(42);
	const scaleR = (value) => value / 99 * radius;
	const polygonPoints = (r) => Array.from({ length: numAxes }, (_, i) => {
		const angle = angleSlice * i - Math.PI / 2;
		return [Math.cos(angle) * r, Math.sin(angle) * r];
	});
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="font-family:xkcd,cursive;background:${colors.background}">`);
	const chartText = `${LABELS.join("")}${LEVELS.join("")}`;
	let fontUrl;
	let fontFormat;
	try {
		fontUrl = await getSubsetFontUrl(chartText);
		fontFormat = "woff2";
	} catch {
		fontUrl = getXkcdFontUrl();
		fontFormat = "truetype";
	}
	parts.push(`<defs><style type="text/css">@font-face { font-family: "xkcd"; src: url(${fontUrl}) format("${fontFormat}"); }</style></defs>`);
	parts.push(`<g transform="translate(${cx},${cy})">`);
	const levels = LEVELS;
	for (const level of levels) {
		const pts = polygonPoints(scaleR(level));
		parts.push(`<path d="${sketchyPolygonPath(pts, 1.5, rng)}" fill="none" stroke="${colors.gridStroke}" stroke-width="1" stroke-dasharray="6,4"/>`);
	}
	const outerPts = polygonPoints(radius);
	parts.push(`<path d="${sketchyPolygonPath(outerPts, 2, rng)}" fill="none" stroke="${colors.outerStroke}" stroke-width="1.5" stroke-dasharray="8,5"/>`);
	for (let i = 0; i < numAxes; i++) {
		const angle = angleSlice * i - Math.PI / 2;
		const x = Math.cos(angle) * radius;
		const y = Math.sin(angle) * radius;
		parts.push(`<path d="${sketchyPolygonPath([[0, 0], [x, y]], 1.5, rng, false)}" fill="none" stroke="${colors.axisStroke}" stroke-width="1"/>`);
	}
	const { dataColor } = colors;
	const dataPts = KEYS.map((key, i) => {
		const value = attributes[key];
		const angle = angleSlice * i - Math.PI / 2;
		const r = scaleR(value);
		return [Math.cos(angle) * r, Math.sin(angle) * r];
	});
	parts.push(`<path d="${sketchyPolygonPath(dataPts, 3, rng)}" fill="${dataColor}" fill-opacity="0.15" stroke="${dataColor}" stroke-width="3.5" stroke-linejoin="round"/>`);
	for (const [x, y] of dataPts) parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${dataColor}" stroke="${colors.dotStroke}" stroke-width="2"/>`);
	for (const level of levels) {
		const r = scaleR(level);
		parts.push(`<text x="4" y="${(-r - 2).toFixed(1)}" font-size="9" fill="${colors.levelLabel}" stroke="none">${level}</text>`);
	}
	for (let i = 0; i < numAxes; i++) {
		const angle = angleSlice * i - Math.PI / 2;
		const labelRadius = radius + (i === 1 || i === 2 ? 40 : 28);
		const x = Math.cos(angle) * labelRadius;
		const y = Math.sin(angle) * labelRadius;
		parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="17" fill="${colors.axisLabel}" stroke="none">${LABELS[i]}</text>`);
	}
	parts.push(`</g>`);
	parts.push(`</svg>`);
	return parts.join("");
}



async function writeOutput(options) {
	const filePath = join(options.outDir, options.file);
	await writeFile(filePath, options.content);
	info(`wrote ${relative(options.workspace, filePath)}`);
	return relative(options.workspace, filePath);
}



function svgBackground(svg) {
	const bg = /background:([^;"']+)/.exec(svg)?.[1]?.trim();
	return bg && bg !== "transparent" ? bg : void 0;
}

async function rasterizeSvg(svg) {
	const background = svgBackground(svg);
	const resvg = new Resvg(svg, {
		font: {
			fontFiles: [resolve("assets/xkcd.ttf")],
			loadSystemFonts: false,
			defaultFontFamily: "xkcd"
		},
		...background ? { background } : {}
	});
	return sharp(resvg.render().asPng()).png({
		compressionLevel: 9,
		palette: true
	}).toBuffer();
}



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



function addFilter(selection) {
	selection.append("filter").attr("id", "xkcdify").attr("filterUnits", "userSpaceOnUse").attr("x", -5).attr("y", -5).attr("width", "100%").attr("height", "100%").call((f) => {
		f.append("feTurbulence").attr("type", "fractalNoise").attr("baseFrequency", "0.05").attr("result", "noise");
		f.append("feDisplacementMap").attr("scale", "5").attr("xChannelSelector", "R").attr("yChannelSelector", "G").attr("in", "SourceGraphic").attr("in2", "noise");
	});
}



function addFont(selection) {
	selection.append("defs").append("style").attr("type", "text/css").text(`@font-face {
      font-family: "xkcd";
      src: url(${getXkcdFontUrl()}) format('truetype');
    }`);
}



function getNumberFormatUnit(n) {
	if (n >= 1e6) return 1e6;
	if (n >= 300) return 1e3;
	return 1;
}

function getFormatNumber(n, type = 1) {
	if (type === 1) return `${n}`;
	if (type === 1e6) {
		if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
		return `${(n / 1e6).toFixed(1)}M`;
	}
	if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}K`;
	return `${(n / 1e3).toFixed(1)}K`;
}


dayjs.extend(duration);
dayjs.extend(relativeTime);

function getTimestampFormatUnit(timestamp) {
	let timelineUnit = "day";
	if (dayjs.duration(timestamp).asYears() > 1) timelineUnit = "year";
	else if (dayjs.duration(timestamp).asMonths() > 1) timelineUnit = "month";
	else if (dayjs.duration(timestamp).asWeeks() > 1) timelineUnit = "week";
	return timelineUnit;
}

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

function drawXLabel(selection, text, color) {
	selection.append("text").style("font-size", "17px").style("fill", color).attr("x", "50%").attr("y", (selection.attr("height") || 10) - 10).attr("text-anchor", "middle").text(text);
}

function drawYLabel(selection, text, color, offsetY = 6) {
	selection.append("text").attr("text-anchor", "end").attr("dy", ".75em").attr("transform", "rotate(-90)").style("font-size", "17px").style("fill", color).text(text).attr("y", offsetY).call((f) => {
		let textLength = 100;
		if (f.node()?.getComputedTextLength) textLength = f.node()?.getComputedTextLength();
		const offsetX = Math.floor(textLength / 2 - (selection.attr("height") || 10) / 2);
		f.attr("x", offsetX);
	});
}



function getContrastTextColor(color) {
	const hex = color.startsWith("#") ? color.slice(1) : "";
	if (hex.length !== 6) return "#fff";
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return (.299 * r + .587 * g + .114 * b) / 255 > .6 ? "#000" : "#fff";
}

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



const margin = {
	top: 50,
	right: 55,
	bottom: 50,
	left: 50
};

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

const getDarkThemeDefaultOptions = (transparent) => ({
	...getDefaultOptions(transparent),
	dataColors: darkColors,
	backgroundColor: transparent ? "transparent" : "#0d1117",
	strokeColor: "white"
});

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
		data: { datasets: input.datasets.map(({ repo, logo, records }) => ({
			label: repo,
			logo,
			data: records.map((record) => ({
				x:  new Date(`${record.date}T00:00:00Z`),
				y: record.stars
			}))
		})) },
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



async function readCacheRecords(filePath) {
	try {
		const raw = await readFile(filePath, "utf8");
		const data = JSON.parse(raw);
		if (!Array.isArray(data?.repos)) return null;
		const byRepo =  new Map();
		for (const entry of data.repos) {
			if (typeof entry?.repo !== "string" || !Array.isArray(entry.records)) return null;
			const records = entry.records;
			if (records.some((r) => typeof r?.date !== "string" || !Number.isInteger(r?.stars))) return null;
			byRepo.set(entry.repo, records);
		}
		return byRepo;
	} catch {
		return null;
	}
}

function serializeCache(datasets) {
	return JSON.stringify({ repos: datasets.map(({ repo, records }) => ({
		repo,
		records
	})) }, null, 2);
}



const GITHUB_API_URL = process.env["GITHUB_API_URL"] ?? "https://api.github.com";

const GITHUB_REPOSITORY = process.env["GITHUB_REPOSITORY"] ?? "";

const GITHUB_SERVER_URL = process.env["GITHUB_SERVER_URL"] ?? "https://github.com";

const GITHUB_EVENT_NAME = process.env["GITHUB_EVENT_NAME"] ?? "";

const GITHUB_HEAD_REF = process.env["GITHUB_HEAD_REF"] ?? "";

const GITHUB_REF_NAME = process.env["GITHUB_REF_NAME"] ?? "";

const GITHUB_WORKSPACE = process.env["GITHUB_WORKSPACE"] ?? "";



const THEMES = ["light", "dark"];

const OUTPUT_FORMATS = [
	"svg",
	"png",
	"json"
];

const OUTPUT_FORMAT_ALIASES = { both: ["svg", "png"] };

function isTheme(value) {
	return THEMES.includes(value);
}

function isOutputFormat(value) {
	return OUTPUT_FORMATS.includes(value);
}

function parseOutputFormats(raw) {
	const formats = [];
	for (const fragment of raw.split(/[,，\s]+/)) {
		const value = fragment.trim().toLowerCase();
		if (!value) continue;
		const expanded = OUTPUT_FORMAT_ALIASES[value] ?? (isOutputFormat(value) ? [value] : null);
		if (!expanded) throw new Error(`output-format "${fragment}" is invalid; use svg, png, json, or both`);
		for (const format of expanded) if (!formats.includes(format)) formats.push(format);
	}
	return formats;
}

function parseBooleanInput(key) {
	const raw = getInput(key);
	const value = raw.trim().toLowerCase();
	if (value && value !== "true" && value !== "false") throw new Error(`${key} "${raw}" is invalid; use true or false`);
	return value === "true";
}

function parseInputs() {
	const repos = [];
	const rawRepo = getInput("repo") || GITHUB_REPOSITORY;
	for (const value of rawRepo.split(/[,，\s]+/)) {
		const repo = value.trim();
		if (!repo) continue;
		if (!repos.includes(repo)) repos.push(repo);
	}
	if (repos.length === 0) throw new Error("repo input is required");
	const token = getInput("token");
	if (!token) throw new Error("token input is required");
	const outputDirectory = getInput("output-directory") || "assets";
	if (isAbsolute(outputDirectory)) throw new Error(`output-directory must be a relative path, got "${outputDirectory}"`);
	const outputFilename = getInput("output-filename") || "star-history.svg";
	if (outputFilename.length === 0 || outputFilename.includes("/") || outputFilename.includes("\\")) throw new Error(`output-filename must be a file name without path separators, got "${outputFilename}"`);
	if (!/\.svg$/i.test(outputFilename)) throw new Error(`output-filename must end with .svg, got "${outputFilename}"`);
	const outputFormat = parseOutputFormats(getInput("output-format") || "svg");
	const radar = parseBooleanInput("radar");
	const cache = parseBooleanInput("cache");
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
		repos,
		token,
		outputDirectory,
		outputFilename,
		outputFormat,
		svgWidth,
		themes,
		radar,
		cache,
		includeLogo: outputFormat.some((format) => format !== "json")
	};
}

function getChartFilePaths(config) {
	if (config.outputFormat.every((format) => format === "json")) return [];
	return (config.themes.length === 1 ? [{
		theme: config.themes[0],
		svgFile: config.outputFilename
	}] : (() => {
		const i = config.outputFilename.lastIndexOf(".");
		const ext = i > 0 ? config.outputFilename.slice(i) : ".svg";
		const stem = i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename;
		return [{
			theme: "light",
			svgFile: `${stem}-light${ext}`
		}, {
			theme: "dark",
			svgFile: `${stem}-dark${ext}`
		}];
	})()).map(({ theme, svgFile }) => {
		const output = {
			theme,
			svgFile
		};
		if (config.outputFormat.includes("png")) output.pngFile = svgFile.replace(/\.svg$/i, ".png");
		return output;
	});
}

function getJsonFileName(config) {
	return config.outputFilename.replace(/\.svg$/i, ".json");
}

function getCacheFileName(config) {
	const extIndex = config.outputFilename.lastIndexOf(".");
	return `${extIndex > 0 ? config.outputFilename.slice(0, extIndex) : config.outputFilename}.cache.json`;
}

function getRadarFileName(config, repo, theme) {
	const i = config.outputFilename.lastIndexOf(".");
	const ext = i > 0 ? config.outputFilename.slice(i) : ".svg";
	return `${i > 0 ? config.outputFilename.slice(0, i) : config.outputFilename}-radar${config.repos.length > 1 ? `-${repo.replaceAll("/", "-")}` : ""}${theme && config.themes.length > 1 ? `-${theme}` : ""}${ext}`;
}

function getRadarFilePaths(config, repo) {
	return getChartFilePaths({
		...config,
		outputFilename: getRadarFileName(config, repo)
	});
}


const REQUEST_TIMEOUT_MS = 15e3;
const REPO_INFO_ACCEPT = "application/vnd.github+json";
const STARGAZERS_ACCEPT = "application/vnd.github.v3.star+json";

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



function formatDate(date) {
	return new Date(date).toISOString().substring(0, 10);
}


const API_BASE$1 = GITHUB_API_URL.replace(/\/+$/, "");

function parseLastPage(link) {
	const match = /<([^>]+)>\s*;\s*rel="last"/.exec(link);
	if (!match) return null;
	const parsed = Number.parseInt(new URL(match[1]).searchParams.get("page") ?? "", 10);
	return isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseStarredAt(value) {
	return typeof value === "number" ? value : Date.parse(value);
}

const RETRYABLE_STATUS =  new Set([
	403,
	429,
	500,
	502,
	503,
	504
]);

async function request(url, token, accept = REPO_INFO_ACCEPT, retryDelayMs = 500) {
	const headers = {
		Accept: accept,
		Authorization: `token ${token}`
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		let res;
		try {
			res = await withTimeout((signal) => fetch(url, {
				headers,
				signal
			}), REQUEST_TIMEOUT_MS);
		} catch (error) {
			if (attempt < 2) {
				await setTimeout(retryDelayMs * 2 ** attempt);
				continue;
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
		if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
		if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
			const resetSec = Number(res.headers.get("x-ratelimit-reset") ?? 0);
			const waitMs = resetSec * 1e3 - Date.now();
			if (resetSec > 0 && waitMs > 0 && waitMs <= 6e4 && attempt < 2) {
				await setTimeout(waitMs);
				continue;
			}
			const resetAt = resetSec > 0 ? ( new Date(resetSec * 1e3)).toISOString() : "unknown";
			throw new Error(`GitHub API rate limit exceeded (HTTP ${res.status}); quota resets at ${resetAt}`);
		}
		if (attempt < 2) {
			await setTimeout(retryDelayMs * 2 ** attempt);
			continue;
		}
		return res;
	}
	throw new Error("request retries exhausted");
}

async function getRepoStargazers(repo, token, page) {
	const res = await request(`${API_BASE$1}/repos/${repo}/stargazers?per_page=100${page ? `&page=${page}` : ""}`, token, STARGAZERS_ACCEPT);
	if (!res.ok) throw new Error(`Failed to get repo ${repo} stargazers: HTTP ${res.status}`);
	return (await res.json()).map((item) => parseStarredAt(item.starred_at));
}

async function getRepoStarRecords(repo, token, maxRequestAmount) {
	const repoRes = await request(`${API_BASE$1}/repos/${repo}`, token);
	if (!repoRes.ok) throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`);
	const repoData = await repoRes.json();
	const total = repoData.stargazers_count ?? 0;
	const createdAt = repoData.created_at ?? "";
	if (total === 0) throw new Error(`Repo ${repo} has no star records`);
	const pageOneRes = await request(`${API_BASE$1}/repos/${repo}/stargazers?per_page=100&page=1`, token, STARGAZERS_ACCEPT);
	if (!pageOneRes.ok) throw new Error(`Failed to get repo ${repo} star records: HTTP ${pageOneRes.status}`);
	const pageCount = parseLastPage(pageOneRes.headers.get("link") ?? "") ?? 1;
	const firstPageMs = (await pageOneRes.json()).map((item) => parseStarredAt(item.starred_at));
	if (firstPageMs.length === 0) throw new Error(`Repo ${repo} has no star records`);
	const sampled = pageCount > maxRequestAmount;
	const pages = sampled ? Array.from({ length: maxRequestAmount }, (_, k) => 1 + Math.floor((pageCount - 1) * k / (maxRequestAmount - 1))) : range(2, pageCount + 1);
	const pageData =  new Map();
	pageData.set(1, firstPageMs);
	const restPages = pages.filter((page) => page !== 1);
	const restData = await promiseParallel(restPages.map((page) => getRepoStargazers(repo, token, page)));
	restPages.forEach((page, i) => pageData.set(page, restData[i]));
	const records =  new Map();
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

function mergeStarRecords(baseline, incMs, total) {
	const counts =  new Map();
	for (const ms of incMs) {
		const date = formatDate(ms);
		counts.set(date, (counts.get(date) ?? 0) + 1);
	}
	const merged = baseline.map((r) => ({ ...r }));
	let lastStars = merged.at(-1)?.stars ?? 0;
	for (const date of [...counts.keys()].sort()) {
		lastStars += counts.get(date);
		if (merged.at(-1)?.date === date) merged[merged.length - 1] = {
			date,
			stars: lastStars
		};
		else merged.push({
			date,
			stars: lastStars
		});
	}
	const today = formatDate(Date.now());
	const tail = merged.at(-1);
	if (tail?.date === today) merged[merged.length - 1] = {
		date: today,
		stars: Math.max(total, tail.stars)
	};
	else merged.push({
		date: today,
		stars: total
	});
	return merged;
}

async function getIncrementalStarRecords(repo, token, baseline, maxRequestAmount) {
	const lastDateMs = Date.parse(`${baseline.at(-1)?.date}T00:00:00Z`);
	if (baseline.length === 0 || !Number.isFinite(lastDateMs)) return getRepoStarRecords(repo, token, maxRequestAmount);
	const repoRes = await request(`${API_BASE$1}/repos/${repo}`, token);
	if (!repoRes.ok) throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`);
	const repoData = await repoRes.json();
	const total = repoData.stargazers_count ?? 0;
	if (total === 0) throw new Error(`Repo ${repo} has no star records`);
	const pageOneRes = await request(`${API_BASE$1}/repos/${repo}/stargazers?per_page=100&page=1`, token, STARGAZERS_ACCEPT);
	if (!pageOneRes.ok) throw new Error(`Failed to get repo ${repo} star records: HTTP ${pageOneRes.status}`);
	const firstPage = await pageOneRes.json();
	if (firstPage.length === 0) throw new Error(`Repo ${repo} has no star records`);
	const tFirst = parseStarredAt(firstPage[0].starred_at);
	const createdAtMs = Date.parse(repoData.created_at ?? "");
	if (!Number.isFinite(createdAtMs) || Math.abs(tFirst - createdAtMs) < Math.abs(Date.now() - tFirst)) return getRepoStarRecords(repo, token, maxRequestAmount);
	const incMs = firstPage.map((item) => parseStarredAt(item.starred_at));
	let reachedBaseline = incMs.some((ms) => ms < lastDateMs);
	let page = 1;
	while (!reachedBaseline && page < maxRequestAmount) {
		page++;
		const raw = await getRepoStargazers(repo, token, page);
		if (raw.length === 0) break;
		incMs.push(...raw);
		reachedBaseline = raw.some((ms) => ms < lastDateMs);
	}
	if (!reachedBaseline) return getRepoStarRecords(repo, token, maxRequestAmount);
	const newCount = Math.max(0, total - baseline[baseline.length - 1].stars);
	const newMs = [];
	for (const ms of incMs) {
		if (newMs.length >= newCount) break;
		newMs.push(ms);
	}
	return mergeStarRecords(baseline, newMs, total);
}

async function getRepoLogo(repo, token) {
	const owner = repo.split("/")[0];
	const response = await request(`${API_BASE$1}/users/${owner}`, token);
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



async function fetchDatasets(config, baselineByRepo) {
	const settled = await Promise.allSettled(config.repos.map(async (repo) => {
		const baseline = baselineByRepo?.get(repo);
		return {
			repo,
			records: config.cache && baseline && baseline.length > 0 ? await getIncrementalStarRecords(repo, config.token, baseline, 15) : await getRepoStarRecords(repo, config.token, 15),
			logo: config.includeLogo ? await toBase64(await getRepoLogo(repo, config.token)).catch(() => "") : ""
		};
	}));
	const datasets = [];
	settled.forEach((result, i) => {
		if (result.status === "fulfilled") datasets.push(result.value);
		else {
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			warning(`skip ${config.repos[i]}: ${reason}`);
		}
	});
	if (datasets.length === 0) throw new Error("no repository data could be fetched; see warnings above for per-repo failures");
	return datasets;
}



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



async function writeJsonExport(config, datasets, outDir, workspace, radarByRepo) {
	const repos = [];
	for (const { repo, records } of datasets) {
		const entry = {
			repo,
			records
		};
		if (config.radar) {
			const radar = radarByRepo?.get(repo);
			if (radar) entry.radar = radar;
		}
		repos.push(entry);
	}
	const json = JSON.stringify({
		updatedAt: ( new Date()).toISOString(),
		repos
	}, null, 2);
	return writeOutput({
		outDir,
		workspace,
		file: getJsonFileName(config),
		content: json
	});
}


const API_BASE = GITHUB_API_URL.replace(/\/+$/, "");

function percentileOf(count) {
	if (!Number.isFinite(count) || count <= 0) return 0;
	return Math.min(99, Math.round(Math.log10(count + 1) / 3 * 33));
}

function newStarsInLastDays(records, days = 30) {
	if (records.length === 0) return 0;
	const cutoffDate = formatDate(Date.now() - days * 864e5);
	let base = 0;
	for (const record of records) if (record.date <= cutoffDate) base = record.stars;
	else break;
	const last = records[records.length - 1];
	return Math.max(0, last.stars - base);
}

function estimateTotal(link) {
	const last = link ? parseLastPage(link) : null;
	return last == null ? null : last * 100;
}

async function getRepoRadarAttributes(repo, token, records) {
	const repoRes = await request(`${API_BASE}/repos/${repo}`, token);
	if (!repoRes.ok) throw new Error(`Failed to get repo ${repo} info: HTTP ${repoRes.status}`);
	const repoData = await repoRes.json();
	const [contributorsRes, commitsRes, issuesRes] = await Promise.all([
		request(`${API_BASE}/repos/${repo}/contributors?per_page=1`, token),
		request(`${API_BASE}/repos/${repo}/commits?per_page=1`, token),
		request(`${API_BASE}/search/issues?q=${encodeURIComponent(`repo:${repo} is:closed`)}&per_page=1`, token)
	]);
	const contributors = estimateTotal(contributorsRes.headers.get("link")) ?? 0;
	const pushes = estimateTotal(commitsRes.headers.get("link")) ?? 0;
	const issuesClosed = issuesRes.ok ? (await issuesRes.json()).total_count ?? 0 : 0;
	return {
		stars: percentileOf(repoData.stargazers_count ?? 0),
		new_stars: percentileOf(newStarsInLastDays(records)),
		pushes: percentileOf(pushes),
		contributors: percentileOf(contributors),
		issues_closed: percentileOf(issuesClosed),
		forks: percentileOf(repoData.forks_count ?? 0)
	};
}

async function getRepoRadarAttributesMap(token, datasets) {
	const settled = await Promise.allSettled(datasets.map(({ repo, records }) => getRepoRadarAttributes(repo, token, records)));
	const attributesByRepo =  new Map();
	settled.forEach((result, i) => {
		if (result.status === "fulfilled") attributesByRepo.set(datasets[i].repo, result.value);
		else {
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			warning(`skip radar metrics for ${datasets[i].repo}: ${reason}`);
		}
	});
	return attributesByRepo;
}



async function run() {
	const config = parseInputs();
	if (!GITHUB_WORKSPACE) throw new Error("GITHUB_WORKSPACE is not set: the action must run on a GitHub runner");
	const workspace = GITHUB_WORKSPACE;
	const outDir = resolve(workspace, config.outputDirectory);
	const isInsideWorkspace = outDir === workspace || outDir.startsWith(`${workspace}${sep}`);
	if (!isAbsolute(outDir) || !isInsideWorkspace) throw new Error("output-directory must point inside the workspace");
	const datasets = await fetchDatasets(config, (config.cache ? await readCacheRecords(resolve(outDir, getCacheFileName(config))) : null) ?? void 0);
	await mkdir(outDir, { recursive: true });
	const files = [];
	const radarByRepo = config.radar ? await getRepoRadarAttributesMap(config.token, datasets) : null;
	if (config.outputFormat.includes("json")) files.push(await writeJsonExport(config, datasets, outDir, workspace, radarByRepo ?? void 0));
	if (config.outputFormat.includes("svg") || config.outputFormat.includes("png")) {
		for (const { theme, svgFile, pngFile } of getChartFilePaths(config)) {
			const svg = await renderStarHistorySvg({
				datasets,
				theme,
				width: config.svgWidth
			});
			if (config.outputFormat.includes("svg")) files.push(await writeOutput({
				outDir,
				workspace,
				file: svgFile,
				content: svg
			}));
			if (pngFile) files.push(await writeOutput({
				outDir,
				workspace,
				file: pngFile,
				content: await rasterizeSvg(svg)
			}));
		}
		if (config.radar) for (const { repo } of datasets) {
			const attributes = radarByRepo?.get(repo);
			if (!attributes) continue;
			for (const { theme, svgFile, pngFile } of getRadarFilePaths(config, repo)) {
				const svg = await renderRadarSvg(attributes, { theme });
				if (config.outputFormat.includes("svg")) files.push(await writeOutput({
					outDir,
					workspace,
					file: svgFile,
					content: svg
				}));
				if (pngFile) files.push(await writeOutput({
					outDir,
					workspace,
					file: pngFile,
					content: await rasterizeSvg(svg)
				}));
			}
		}
	}
	if (config.cache) files.push(await writeOutput({
		outDir,
		workspace,
		file: getCacheFileName(config),
		content: serializeCache(datasets)
	}));
	commitAndPush({
		cwd: workspace,
		files,
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

export {};
