/**
 * Swimlane waterfall: the factory run rendered as one bar per pipeline lane
 * on a shared time axis (scout → plan → implement → checks → reviewers →
 * fix? → final checks), like a Gantt chart.
 *
 * This module is pure data + rendering. It owns no timers, RPC, or session
 * access, so the layout is unit-testable and the same renderer serves the
 * live TUI widget (with theme colors) and `/factory-status` (plain text).
 *
 * Spans are stored as milliseconds relative to the run start so the record
 * survives session restore and never leaks wall-clock times.
 */

/** Visual state of one lane. */
export type WaterfallState = "running" | "success" | "failed" | "attention" | "queued";

export interface WaterfallSpan {
	/** Stable lane key: build | scout | plan | implement | checks | reviewers | fix | review | final */
	key: string;
	label: string;
	/** ms relative to run start. */
	startMs: number;
	/** ms relative to run start; null while the lane is still open. */
	endMs: number | null;
	state: WaterfallState;
}

export interface WaterfallModel {
	task: string;
	spans: WaterfallSpan[];
	statusLine?: string;
	/** Reference "now" in ms-relative coordinates for open spans; defaults to max span end. */
	nowMs?: number;
}

/** Theme token per lane state (semantic tokens exist in every pi theme). */
export function waterfallColorToken(state: WaterfallState): "accent" | "success" | "error" | "warning" | "muted" {
	switch (state) {
		case "success":
			return "success";
		case "failed":
			return "error";
		case "attention":
			return "warning";
		case "queued":
			return "muted";
		default:
			return "accent";
	}
}

/** Coarse phase span keys that are hidden when finer sub-spans exist. */
const SUBSUMED = new Map<string, readonly string[]>([
	["build", ["scout", "plan", "implement"]],
	["review", ["reviewers", "fix"]],
]);

/** Lane display order (also the row order of the rendered chart). */
const LANE_ORDER = ["scout", "plan", "implement", "build", "checks", "reviewers", "fix", "review", "final"] as const;

/**
 * Reduce raw spans to chart rows: drop coarse spans that sub-spans make
 * redundant, order lanes, drop queued lanes with no time on the axis.
 */
export function chartRows(spans: WaterfallSpan[]): WaterfallSpan[] {
	const present = new Set(spans.map((s) => s.key));
	const hidden = new Set<string>();
	for (const [coarse, subs] of SUBSUMED) {
		if (present.has(coarse) && subs.some((k) => present.has(k))) hidden.add(coarse);
	}
	return [...spans]
		.filter((s) => !hidden.has(s.key))
		.filter((s) => s.state !== "queued" || s.endMs !== null || s.startMs > 0)
		.sort((a, b) => {
			const la = LANE_ORDER.indexOf(a.key as (typeof LANE_ORDER)[number]);
			const lb = LANE_ORDER.indexOf(b.key as (typeof LANE_ORDER)[number]);
			return (la === -1 ? 99 : la) - (lb === -1 ? 99 : lb) || a.startMs - b.startMs;
		});
}

/** Format a duration compactly: `38s`, `2m14s`, `1h04m`. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem === 0 ? `${m}m` : `${m}m${String(rem).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function formatTick(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

const TICK_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000];

function axisTicks(maxMs: number): number[] {
	const step = TICK_STEPS_MS.find((s) => maxMs / s <= 5) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
	const ticks: number[] = [];
	for (let t = 0; t <= maxMs; t += step) ticks.push(t);
	return ticks;
}

type Colorize = (token: "accent" | "success" | "error" | "warning" | "muted" | "text", text: string) => string;

const identityColor: Colorize = (_token, text) => text;

/**
 * Render the waterfall to terminal lines that fit `width`.
 *
 * `colorize` maps semantic tokens to ANSI-styled text; omit it for plain
 * text output (notifications, tests).
 */
export function renderWaterfall(model: WaterfallModel, width: number, colorize: Colorize = identityColor): string[] {
	const rows = chartRows(model.spans);
	const lines: string[] = [];
	if (rows.length === 0) return lines;

	const maxEnd = Math.max(...rows.map((s) => s.endMs ?? 0), 0);
	const maxMs = Math.max(1, model.nowMs ?? maxEnd);
	const now = Math.min(maxMs, model.nowMs ?? maxMs);

	const labelW = Math.min(14, Math.max(...rows.map((s) => s.label.length), 5));
	const chartW = Math.max(12, width - labelW - 3);
	const pos = (ms: number) => Math.min(chartW, Math.round((ms / maxMs) * chartW));

	// Title + status line.
	const title = `Factory — ${model.task}`;
	lines.push(colorize("text", title.length > width ? title.slice(0, Math.max(0, width)) : title));

	// Time axis: tick labels row, then a tick-mark row.
	const ticks = axisTicks(maxMs);
	const labelRow = " ".repeat(chartW).split("");
	for (const t of ticks) {
		const label = formatTick(t);
		const center = pos(t);
		let start = center - Math.floor(label.length / 2);
		start = Math.max(0, Math.min(chartW - label.length, start));
		for (let i = 0; i < label.length && start + i < chartW; i++) labelRow[start + i] = label[i];
	}
	lines.push(colorize("muted", " ".repeat(labelW + 2) + labelRow.join("")));
	const markRow = " ".repeat(chartW).split("");
	for (const t of ticks) markRow[pos(t)] = "·";
	lines.push(colorize("muted", " ".repeat(labelW + 2) + markRow.join("")));

	// One row per lane.
	for (const span of rows) {
		const end = span.endMs ?? now;
		const from = pos(span.startMs);
		let to = pos(Math.max(span.startMs, end));
		if (to <= from) to = from + 1;
		to = Math.min(to, chartW);
		const barArea = " ".repeat(from) + "█".repeat(Math.max(1, to - from));
		const dur = ` ${formatDuration(Math.max(0, end - span.startMs))}${span.endMs === null ? "…" : ""}`;
		lines.push(
			colorize("muted", `${span.label.padEnd(labelW)} │`) +
				colorize(waterfallColorToken(span.state), barArea) +
				colorize("muted", dur),
		);
	}

	if (model.statusLine) lines.push(colorize("muted", model.statusLine));
	return lines;
}

/** Extract the latest open sub-stage lane, for status-bar text. */
export function currentStageLabel(spans: WaterfallSpan[] | undefined): string | undefined {
	if (!spans?.length) return undefined;
	const open = spans.filter((s) => s.endMs === null && s.state === "running");
	if (open.length === 0) return undefined;
	return open.sort((a, b) => b.startMs - a.startMs)[0]?.label;
}

/**
 * Parse workflow-child step statuses out of a pi-subagents status text.
 *
 * Workflow runs render one line per child, shaped like:
 *   `Workflow child scout: scout (scout) running, last activity 3s`
 *   `Workflow child fix: fix (worker) complete, acceptance: checked`
 * The status token is the last word before the first ", " suffix. Best-effort:
 * keys or lines that do not match are ignored.
 */
export function parseWorkflowChildStatuses(text: string): Map<string, string[]> {
	const statuses = new Map<string, string[]>();
	for (const match of text.matchAll(/Workflow child (\S+): ([^\n]*)/g)) {
		const head = (match[2].split(", ")[0] ?? "").trim();
		const status = head.split(/\s+/).pop() ?? "";
		if (!status) continue;
		if (!statuses.has(match[1])) statuses.set(match[1], []);
		statuses.get(match[1])!.push(status);
	}
	return statuses;
}

/**
 * Aggregate raw child step statuses into one lane state: failure dominates,
 * then pause; a lane is successful only when every child finished.
 */
export function laneStateFromStatuses(statuses: string[]): WaterfallState {
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("paused")) return "attention";
	if (statuses.every((s) => s === "complete" || s === "stopped")) return "success";
	if (statuses.includes("running")) return "running";
	return "queued";
}

// ---- Live widget component ------------------------------------------------

interface WidgetTheme {
	fg(color: string, text: string): string;
}

interface WidgetTui {
	requestRender(): void;
}

/**
 * Widget component showing the waterfall above the editor. Reads the shared
 * (mutated) WaterfallModel on every render; the extension invalidates + calls
 * `tui.requestRender()` after each update. Renders are cheap (≤ ~12 rows).
 */
export class WaterfallWidget {
	private model: WaterfallModel;
	private theme: WidgetTheme;

	constructor(model: WaterfallModel, theme: WidgetTheme) {
		this.model = model;
		this.theme = theme;
	}

	invalidate(): void {
		// Stateless per-render layout: nothing cached, nothing to drop.
	}

	render(width: number): string[] {
		if (!this.model.spans.length) return [];
		return renderWaterfall(this.model, width, (token, text) => this.theme.fg(token, text));
	}
}

/** Minimal TUI surface the widget needs (satisfied by pi's TUI). */
export interface WaterfallWidgetHost {
	requestRender(): void;
}
