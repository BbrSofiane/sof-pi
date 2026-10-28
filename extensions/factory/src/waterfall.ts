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
	/** Terminal verdict card input: when set, the widget renders a result card instead of the live chart. */
	card?: RunCardState;
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

/**
 * Total run duration in ms-relative coordinates: the last real span end
 * (open spans count as their start, so a frozen run never grows).
 */
export function runDurationMs(spans: WaterfallSpan[]): number {
	return Math.max(0, ...spans.map((s) => s.endMs ?? s.startMs));
}

/** First sentence of a diagnostic, bounded for one display line. */
export function firstSentence(text: string, max = 160): string {
	const sentence = text.split(/(?<=[.!?])\s+|\n/)[0] ?? text;
	return sentence.trim().slice(0, max);
}

/** Minimal terminal-state input for the run verdict card (FactoryRunState satisfies it). */
export interface RunCardState {
	task: string;
	phase: string;
	spans?: WaterfallSpan[];
	error?: string;
	decisions?: string[];
	checks?: Array<{ exitCode: number | null; timedOut: boolean }>;
	finalChecks?: Array<{ exitCode: number | null; timedOut: boolean }>;
	handoff?: { changedFiles: string[] };
}

export interface RunSummary {
	durationMs: number;
	/** Primary card line without the leading marker: "complete — 2m14s · 3 files changed · checks 2/2". */
	headline: string;
}

/**
 * Compact verdict for a terminal run: duration plus one headline line whose
 * trailing detail depends on the outcome (files/checks, error, decisions).
 */
export function summarizeRun(state: RunCardState): RunSummary {
	const durationMs = runDurationMs(state.spans ?? []);
	switch (state.phase) {
		case "complete": {
			const parts = [`complete — ${formatDuration(durationMs)}`];
			const files = state.handoff?.changedFiles.length ?? 0;
			if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"} changed`);
			const checks = state.finalChecks ?? state.checks;
			if (checks?.length) {
				const pass = checks.filter((c) => !c.timedOut && c.exitCode === 0).length;
				parts.push(`checks ${pass}/${checks.length}`);
			}
			return { durationMs, headline: parts.join(" · ") };
		}
		case "failed":
			return { durationMs, headline: `failed — ${formatDuration(durationMs)} · ${firstSentence(state.error ?? "unknown error")}` };
		case "needs_approval": {
			const n = state.decisions?.length ?? 0;
			return { durationMs, headline: `needs approval — ${n} decision${n === 1 ? "" : "s"} pending` };
		}
		default:
			return { durationMs, headline: `needs attention — ${firstSentence(state.error ?? "inspect /factory-status")}` };
	}
}

/** Pointer appended to widget-truncated error text; the full diagnostic lives in /factory-status. */
export const FULL_DIAGNOSTIC_SUFFIX = " — /factory-status for the full diagnostic";

/**
 * Truncate error text for widget display: cut at a word boundary (never
 * mid-word when a boundary exists), append '…', and always append the
 * /factory-status pointer — the whole string fits within `width`.
 */
export function truncateForWidget(text: string, width: number, suffix: string = FULL_DIAGNOSTIC_SUFFIX): string {
	if (width < 1) return "";
	const clean = text.replace(/\s+/g, " ").trim();
	if (suffix.length >= width) return suffix.slice(0, width);
	if (clean.length + suffix.length <= width) return clean + suffix;
	const budget = Math.max(1, width - suffix.length - 1); // 1 column for the ellipsis
	let cut = clean.slice(0, budget);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > 0) cut = cut.slice(0, lastSpace);
	return `${cut.trimEnd()}…${suffix}`;
}

function clipLine(text: string, width: number): string {
	return text.length > width ? text.slice(0, Math.max(0, width)) : text;
}

/** Card line budget below which the frozen chart is rendered muted under the verdict. */
const RESULT_CARD_MAX_LINES = 8;

/**
 * Terminal widget view: one colorized verdict line (plus a truncated error
 * pointer for failures), then the frozen waterfall muted — only when the
 * whole card stays within the line budget; otherwise card only.
 */
export function renderResultCard(state: RunCardState, width: number, colorize: Colorize = identityColor): string[] {
	const summary = summarizeRun(state);
	const token = state.phase === "complete" ? "success" : state.phase === "failed" ? "error" : "warning";
	const marker = state.phase === "complete" ? "✓" : state.phase === "failed" ? "✗" : "!";
	const lines = [colorize(token, clipLine(`${marker} ${summary.headline}`, width))];
	if (state.phase === "failed" && state.error) {
		lines.push(colorize("muted", truncateForWidget(state.error, width)));
	}
	const chart = renderWaterfall({ task: state.task, spans: state.spans ?? [] }, width, (t, text) => colorize("muted", text));
	if (lines.length + chart.length <= RESULT_CARD_MAX_LINES) lines.push(...chart);
	return lines;
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

	// Time axis: tick labels row, then a tick-mark row. Labels are stamped
	// greedily left-to-right and skipped when they would overlap an already
	// stamped one or the reserved right-edge total; the axis max (the run's
	// total duration) is always stamped last at the right edge.
	const ticks = axisTicks(maxMs);
	const totalLabel = formatTick(maxMs);
	const totalStart = Math.max(0, chartW - totalLabel.length);
	const labelRow = " ".repeat(chartW).split("");
	const stamped: Array<{ start: number; end: number }> = [];
	for (const t of ticks) {
		if (t === maxMs) continue; // covered by the total label
		const label = formatTick(t);
		const center = pos(t);
		let start = center - Math.floor(label.length / 2);
		start = Math.max(0, Math.min(chartW - label.length, start));
		const end = start + label.length;
		if (end > totalStart || stamped.some((s) => start < s.end && end > s.start)) continue;
		stamped.push({ start, end });
		for (let i = 0; i < label.length; i++) labelRow[start + i] = label[i];
	}
	for (let i = 0; i < totalLabel.length && totalStart + i < chartW; i++) labelRow[totalStart + i] = totalLabel[i];
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
 *   `Workflow child fix: fix (worker) completed, acceptance: checked`
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
 * WorkflowNodeStatus tokens that mean the child needs a human or was cut
 * short: paused (detached supervisor child), detached, or partial output.
 */
const ATTENTION_STATUSES = new Set(["paused", "detached", "partial"]);

/**
 * Aggregate raw child step statuses (pi-subagents WorkflowNodeStatus tokens)
 * into one lane state: failure dominates ("failed", "rejected"), then
 * attention ("paused", "detached", "partial"); a lane is successful only when
 * every child finished. Successful children emit "completed" in pi-subagents
 * 0.79+; "complete" and "stopped" stay accepted for compatibility.
 */
export function laneStateFromStatuses(statuses: string[]): WaterfallState {
	if (statuses.some((s) => s === "failed" || s === "rejected")) return "failed";
	if (statuses.some((s) => ATTENTION_STATUSES.has(s))) return "attention";
	if (statuses.every((s) => s === "complete" || s === "completed" || s === "stopped")) return "success";
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
		if (this.model.card) return renderResultCard(this.model.card, width, (token, text) => this.theme.fg(token, text));
		if (!this.model.spans.length) return [];
		return renderWaterfall(this.model, width, (token, text) => this.theme.fg(token, text));
	}
}

/** Minimal TUI surface the widget needs (satisfied by pi's TUI). */
export interface WaterfallWidgetHost {
	requestRender(): void;
}
