/**
 * Swimlane waterfall: pure layout/rendering rules and state round-trip.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isFactoryRunState, type FactoryRunState } from "../../extensions/factory/src/state.ts";
import {
	chartRows,
	currentStageLabel,
	formatDuration,
	FULL_DIAGNOSTIC_SUFFIX,
	laneStateFromStatuses,
	parseWorkflowChildStatuses,
	renderResultCard,
	renderWaterfall,
	runDurationMs,
	summarizeRun,
	truncateForWidget,
	waterfallColorToken,
	type WaterfallSpan,
} from "../../extensions/factory/src/waterfall.ts";

const ANSI = /\u001B\[/;

function baseState(spans: WaterfallSpan[]): FactoryRunState {
	return {
		task: "demo task",
		phase: "complete",
		spans,
		startedAt: "2026-10-17T10:00:00.000Z",
		updatedAt: "2026-10-17T10:05:00.000Z",
	};
}

test("formatDuration uses compact units", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(38_000), "38s");
	assert.equal(formatDuration(134_000), "2m14s");
	assert.equal(formatDuration(3_600_000), "1h00m");
});

test("chartRows hides coarse spans when finer sub-spans exist and orders lanes", () => {
	const rows = chartRows([
		{ key: "build", label: "build", startMs: 0, endMs: 100, state: "success" },
		{ key: "scout", label: "scout", startMs: 0, endMs: 40, state: "success" },
		{ key: "plan", label: "plan", startMs: 40, endMs: 100, state: "success" },
		{ key: "final", label: "final checks", startMs: 120, endMs: 130, state: "success" },
	]);
	assert.deepEqual(rows.map((r) => r.key), ["scout", "plan", "final"]);
});

test("chartRows keeps the coarse span when sub-spans are missing", () => {
	const rows = chartRows([
		{ key: "build", label: "build", startMs: 0, endMs: 100, state: "success" },
		{ key: "checks", label: "checks", startMs: 100, endMs: 120, state: "success" },
	]);
	assert.deepEqual(rows.map((r) => r.key), ["build", "checks"]);
});

test("renderWaterfall draws one row per lane with an axis and durations", () => {
	const model = {
		task: "demo",
		nowMs: 130_000,
		spans: [
			{ key: "scout", label: "scout", startMs: 0, endMs: 40_000, state: "success" as const },
			{ key: "plan", label: "plan", startMs: 40_000, endMs: 100_000, state: "success" as const },
			{ key: "checks", label: "checks", startMs: 100_000, endMs: 130_000, state: "success" as const },
		],
	};
	const lines = renderWaterfall(model, 80);
	// Title, axis labels, axis marks, three lane rows.
	assert.equal(lines.length, 6);
	assert.ok(lines[0].startsWith("Factory — demo"));
	assert.match(lines[1], /0s/);
	assert.match(lines[2], /·/);
	const bars = lines.slice(3);
	assert.match(bars[0], /^scout\s+│█+ 40s$/);
	assert.match(bars[1], /^plan\s+│\s+█+ 1m$/);
	assert.match(bars[2], /^checks\s+│\s+█+ 30s$/);
});

test("renderWaterfall bars are proportional and running lanes extend to now with an ellipsis", () => {
	const model = {
		task: "demo",
		nowMs: 60_000,
		spans: [
			{ key: "a", label: "laneA", startMs: 0, endMs: 30_000, state: "success" as const },
			{ key: "b", label: "laneB", startMs: 30_000, endMs: null, state: "running" as const },
		],
	};
	const lines = renderWaterfall(model, 60);
	const rowA = lines.find((l) => l.startsWith("laneA"))!;
	const rowB = lines.find((l) => l.startsWith("laneB"))!;
	const cols = (line: string) => (line.match(/█/g) ?? []).length;
	assert.equal(cols(rowB), cols(rowA)); // both lanes span 30s
	assert.match(rowB, /30s…$/);
});

test("renderWaterfall colorizes when given a colorizer and stays plain otherwise", () => {
	const model = {
		task: "demo",
		nowMs: 10_000,
		spans: [{ key: "checks", label: "checks", startMs: 0, endMs: 10_000, state: "failed" as const }],
	};
	assert.ok(!ANSI.test(renderWaterfall(model, 60).join("\n")));
	const colored = renderWaterfall(model, 60, (token, text) => `<${token}>${text}</${token}>`);
	assert.match(colored.find((l) => l.includes("█"))!, /<error>█+<\/error>/);
	assert.equal(waterfallColorToken("failed"), "error");
	assert.equal(waterfallColorToken("running"), "accent");
});

test("renderWaterfall omits empty models and clamps tiny spans to one column", () => {
	assert.deepEqual(renderWaterfall({ task: "t", spans: [] }, 60), []);
	const lines = renderWaterfall(
		{ task: "t", nowMs: 1_000, spans: [{ key: "x", label: "x", startMs: 500, endMs: 501, state: "success" }] },
		60,
	);
	assert.match(lines.find((l) => l.startsWith("x"))!, /█/);
});

test("renderWaterfall freezes the axis at max span end when nowMs is omitted (terminal run)", () => {
	const spans: WaterfallSpan[] = [
		{ key: "a", label: "laneA", startMs: 0, endMs: 60_000, state: "success" },
		{ key: "b", label: "laneB", startMs: 60_000, endMs: 120_000, state: "success" },
	];
	const lines = renderWaterfall({ task: "demo", spans }, 60);
	const axis = lines[1]!;
	// The axis max is the run's true duration (2m), stamped at the right edge —
	// no wall-clock "now" can grow it after the run is over.
	assert.ok(axis.trimEnd().endsWith("2m"), axis);
	assert.match(axis, /\b1m\b/);
});

test("renderWaterfall skips overlapping tick labels and always reserves the right-edge total", () => {
	const spans: WaterfallSpan[] = [{ key: "a", label: "laneA", startMs: 0, endMs: 200_000, state: "success" }];
	// Narrow chart: several ticks would collide; greedy stamping must drop some.
	const narrow = renderWaterfall({ task: "demo", nowMs: 200_000, spans }, 16);
	const narrowRuns = narrow[1]!.trim().split(/\s+/);
	assert.deepEqual(narrowRuns, ["0s", "1m", "3m20s"]); // total survives, colliding ticks dropped
	// Wide axis with many ticks: every stamped label is complete (no digit soup)
	// and the total duration sits at the right edge.
	const wide = renderWaterfall({ task: "demo", nowMs: 3_600_000, spans }, 80);
	const wideRuns = wide[1]!.trim().split(/\s+/);
	assert.deepEqual(wideRuns, ["0s", "15m", "30m", "45m", "60m"]);
	assert.ok(wide[1]!.trimEnd().endsWith("60m"));
});

test("runDurationMs is the last real span end and never grows for open spans", () => {
	assert.equal(runDurationMs([]), 0);
	assert.equal(
		runDurationMs([
			{ key: "a", label: "a", startMs: 0, endMs: 40_000, state: "success" },
			{ key: "b", label: "b", startMs: 40_000, endMs: 130_000, state: "success" },
		]),
		130_000,
	);
	assert.equal(runDurationMs([{ key: "b", label: "b", startMs: 90_000, endMs: null, state: "running" }]), 90_000);
});

test("summarizeRun builds one outcome-specific headline per terminal phase", () => {
	const spans: WaterfallSpan[] = [{ key: "final", label: "final", startMs: 0, endMs: 130_000, state: "success" }];
	const complete = summarizeRun({
		task: "t",
		phase: "complete",
		spans,
		handoff: { changedFiles: ["a.ts", "b.ts", "c.ts"] },
		finalChecks: [
			{ exitCode: 0, timedOut: false },
			{ exitCode: 1, timedOut: false },
		],
	});
	assert.equal(complete.durationMs, 130_000);
	assert.equal(complete.headline, "complete — 2m10s · 3 files changed · checks 1/2");

	// Bits that don't apply are omitted.
	assert.equal(summarizeRun({ task: "t", phase: "complete", spans }).headline, "complete — 2m10s");

	const failed = summarizeRun({
		task: "t",
		phase: "failed",
		spans,
		error: "deterministic validation failed after implementation. Fix and rerun /factory.",
	});
	assert.equal(failed.headline, "failed — 2m10s · deterministic validation failed after implementation.");

	assert.equal(
		summarizeRun({ task: "t", phase: "needs_approval", spans, decisions: ["a", "b"] }).headline,
		"needs approval — 2 decisions pending",
	);
	assert.equal(
		summarizeRun({ task: "t", phase: "needs_approval", spans, decisions: ["a"] }).headline,
		"needs approval — 1 decision pending",
	);
	assert.equal(
		summarizeRun({
			task: "t",
			phase: "needs_attention",
			spans,
			error: "build workflow paused (detached child needs a decision). More detail elsewhere.",
		}).headline,
		"needs attention — build workflow paused (detached child needs a decision).",
	);
});

test("truncateForWidget cuts at a word boundary and always appends the status pointer within the width", () => {
	const short = "checks crashed: exit 1";
	assert.equal(truncateForWidget(short, 80), short + FULL_DIAGNOSTIC_SUFFIX);

	const long = "deterministic validation failed after implementation of the accepted plan";
	const truncated = truncateForWidget(long, 60);
	assert.ok(truncated.length <= 60, truncated);
	assert.ok(truncated.endsWith(FULL_DIAGNOSTIC_SUFFIX));
	assert.ok(truncated.includes("…"));
	// Never mid-word: the text before the ellipsis ends on a word boundary.
	const body = truncated.slice(0, truncated.indexOf("…"));
	assert.ok(body.length > 0);
	assert.ok(long.startsWith(body));
	assert.ok(!body.endsWith(" "));
	assert.ok(body.split(" ").every((word) => long.includes(word)));

	// Fail-closed bound: even a tiny width yields at most one bounded line.
	assert.ok(truncateForWidget(long, 10).length <= 10);
	assert.equal(truncateForWidget(long, 0), "");
});

test("renderResultCard renders a colorized verdict card and the frozen chart only when it fits", () => {
	const spans: WaterfallSpan[] = [{ key: "final", label: "final", startMs: 0, endMs: 130_000, state: "success" }];
	const state = {
		task: "demo",
		phase: "complete",
		spans,
		handoff: { changedFiles: ["a.ts", "b.ts"] },
	} as const;
	const plain = renderResultCard(state, 80);
	assert.match(plain[0]!, /^✓ complete — 2m10s · 2 files changed$/);
	// Title + axis labels + axis marks + one lane fits under the 8-line budget.
	assert.equal(plain.length, 5);
	const colored = renderResultCard(state, 80, (token, text) => `<${token}>${text}</${token}>`);
	assert.match(colored[0]!, /^<success>✓ complete/);
	assert.ok(colored.slice(1).every((line) => line.startsWith("<muted>")));

	const failedState = {
		task: "demo",
		phase: "failed",
		spans,
		error: "deterministic validation failed after implementation. Fix and rerun /factory.",
	} as const;
	const failed = renderResultCard(failedState, 80);
	assert.match(failed[0]!, /^✗ failed — 2m10s · deterministic validation failed after implementation\.$/);
	assert.match(failed[1]!, /… — \/factory-status for the full diagnostic$/);
	assert.ok(failed.length <= 8);

	assert.equal(
		renderResultCard({ task: "t", phase: "needs_approval", spans, decisions: ["a"] }, 80)[0]!,
		"! needs approval — 1 decision pending",
	);

	// Too many lanes: the chart no longer fits the line budget, card only.
	const manyLanes: WaterfallSpan[] = ["scout", "plan", "implement", "checks", "reviewers", "review", "final"].map((key) => ({
		key,
		label: key,
		startMs: 0,
		endMs: 1_000,
		state: "success" as const,
	}));
	const cardOnly = renderResultCard({ task: "t", phase: "needs_approval", spans: manyLanes, decisions: ["a"] }, 80);
	assert.equal(cardOnly.length, 1);
});

test("currentStageLabel reports the newest open running lane", () => {
	const spans: WaterfallSpan[] = [
		{ key: "scout", label: "scout", startMs: 0, endMs: 10, state: "success" },
		{ key: "implement", label: "implement", startMs: 10, endMs: null, state: "running" },
	];
	assert.equal(currentStageLabel(spans), "implement");
	assert.equal(currentStageLabel(undefined), undefined);
	assert.equal(currentStageLabel(spans.map((s) => ({ ...s, endMs: 12, state: "success" as const }))), undefined);
});

test("factory state round-trips spans through isFactoryRunState and fails closed on garbage", () => {
	const spans: WaterfallSpan[] = [
		{ key: "build", label: "build", startMs: 0, endMs: 1_000, state: "success" },
		{ key: "checks", label: "checks", startMs: 1_000, endMs: null, state: "running" },
	];
	const restored = isFactoryRunState(baseState(spans));
	assert.ok(restored);
	assert.deepEqual(restored.spans, spans);

	const bad = isFactoryRunState({
		...baseState([]),
		spans: [{ key: "x", label: "x", startMs: 0, endMs: null, state: "bogus" }],
	});
	assert.equal(bad, undefined);

	const negative = isFactoryRunState({
		...baseState([]),
		spans: [{ key: "x", label: "x", startMs: -5, endMs: null, state: "running" }],
	});
	assert.equal(negative, undefined);
});

test("parseWorkflowChildStatuses extracts per-key statuses and ignores suffixes", () => {
	const text = [
		"Run: abc123",
		"State: running",
		"Workflow child scout: scout (scout) completed, last activity 5s",
		"Workflow child plan: plan (planner) running, tool: read",
		"Workflow child review-correctness: correctness (reviewer) running",
		"Workflow child review-tests: tests (reviewer) paused, needs attention",
		"Not a workflow child line: ignored",
	].join("\n");
	const parsed = parseWorkflowChildStatuses(text);
	assert.deepEqual(parsed.get("scout"), ["completed"]);
	assert.deepEqual(parsed.get("plan"), ["running"]);
	assert.deepEqual(parsed.get("review-correctness"), ["running"]);
	assert.deepEqual(parsed.get("review-tests"), ["paused"]);
	assert.equal(parsed.size, 4);
	assert.equal(parseWorkflowChildStatuses("no steps here").size, 0);
});

test("regression: realistic 'completed' child status lines close the lane as success", () => {
	// pi-subagents 0.79 emits WorkflowNodeStatus "completed" for successful
	// children; the old token list only accepted "complete", so successful
	// lanes never closed and were force-stamped failed at the next phase.
	const text = [
		"Run: run-1",
		"State: running",
		"Workflow child scout: scout (scout) completed, last activity 5s",
		"Workflow child plan: plan (planner) completed, last activity 2s",
		"Workflow child implement: implement (worker) completed, acceptance: checked",
	].join("\n");
	const parsed = parseWorkflowChildStatuses(text);
	for (const key of ["scout", "plan", "implement"]) {
		const laneState = laneStateFromStatuses(parsed.get(key)!);
		assert.equal(laneState, "success", key);
		assert.notEqual(laneState, "queued");
	}
});

test("laneStateFromStatuses aggregates children: failure dominates, success needs all", () => {
	assert.equal(laneStateFromStatuses(["completed", "running"]), "running");
	assert.equal(laneStateFromStatuses(["completed", "completed"]), "success");
	// Legacy/compat tokens stay accepted.
	assert.equal(laneStateFromStatuses(["complete", "completed"]), "success");
	assert.equal(laneStateFromStatuses(["complete", "stopped"]), "success");
	assert.equal(laneStateFromStatuses(["running", "failed"]), "failed");
	// Remaining WorkflowNodeStatus tokens map to safe states, never queued.
	assert.equal(laneStateFromStatuses(["completed", "rejected"]), "failed");
	assert.equal(laneStateFromStatuses(["completed", "paused"]), "attention");
	assert.equal(laneStateFromStatuses(["completed", "detached"]), "attention");
	assert.equal(laneStateFromStatuses(["completed", "partial"]), "attention");
	assert.equal(laneStateFromStatuses(["pending", "pending"]), "queued");
	assert.equal(laneStateFromStatuses([]), "success");
});
