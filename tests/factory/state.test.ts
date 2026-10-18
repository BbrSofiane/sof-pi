import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	boundedFailureDiagnostics,
	childResults,
	childStructuredOutput,
	handoffFromStructuredOutput,
	isFactoryRunState,
	MAX_ERROR_LENGTH,
} from "../../extensions/factory/src/state.ts";

describe("factory run state", () => {
	it("validates and bounds restored state", () => {
		const state = isFactoryRunState({
			task: "Add endpoint",
			phase: "review",
			buildRunId: "run-1",
			checks: [{ name: "test", command: "pnpm test", exitCode: 0, timedOut: false, durationMs: 12, outputTail: "ok" }],
		});
		assert.ok(state);
		assert.equal(state.phase, "review");
		assert.equal(state.checks?.[0].name, "test");
	});

	it("fails closed on unknown phases, wrong types, and garbage", () => {
		for (const raw of [null, "x", { phase: "warp" }, { phase: 5 }, { task: 7, phase: "build" }, { phase: "build", task: "t", buildRunId: 9 }]) {
			assert.equal(isFactoryRunState(raw), undefined, JSON.stringify(raw));
		}
	});

	it("extracts bounded handoff records from structured child output", () => {
		const handoff = handoffFromStructuredOutput({
			changedFiles: ["a.ts"],
			implementationSummary: "did it",
			commandsRun: [{ command: "pnpm test", exitCode: 0 }],
			testsAddedOrUpdated: ["a.test.ts"],
			residualRisks: ["r"],
			workLeftUndone: [],
			decisionsRequiringApproval: [],
		});
		assert.ok(handoff);
		assert.deepEqual(handoff.changedFiles, ["a.ts"]);
		// Missing required fields → no handoff (fail closed).
		assert.equal(handoffFromStructuredOutput({ changedFiles: ["a.ts"] }), undefined);
		assert.equal(handoffFromStructuredOutput(null), undefined);
	});

	it("keeps a long failure diagnostic through the restore round-trip", () => {
		const longError = `Acceptance rejected: ${"x".repeat(1_500)}`;
		const restored = isFactoryRunState({
			task: "Add endpoint",
			phase: "failed",
			error: longError,
			startedAt: "2026-10-17T10:00:00.000Z",
			updatedAt: "2026-10-17T10:05:00.000Z",
		});
		assert.ok(restored);
		assert.equal(restored.error, longError); // well under the bound: unchanged

		const overBound = isFactoryRunState({
			task: "Add endpoint",
			phase: "failed",
			error: "Acceptance rejected: " + "x".repeat(MAX_ERROR_LENGTH + 500),
			startedAt: "2026-10-17T10:00:00.000Z",
			updatedAt: "2026-10-17T10:05:00.000Z",
		});
		assert.ok(overBound);
		assert.equal(overBound.error?.length, MAX_ERROR_LENGTH);
		assert.match(overBound.error ?? "", /^Acceptance rejected: /);
	});

	it("collects the fullest failure diagnostic from a completion payload", () => {
		assert.equal(boundedFailureDiagnostics({ summary: "Acceptance rejected: Failed to p" }), "Acceptance rejected: Failed to p");
		assert.equal(
			boundedFailureDiagnostics({ summary: "one", error: "two", errorTail: "three", message: "one" }),
			"one | two | three", // duplicates removed, order stable
		);
		assert.equal(boundedFailureDiagnostics({}), "(no summary)");
		assert.equal(boundedFailureDiagnostics(undefined), "(no summary)");
		assert.equal(boundedFailureDiagnostics({ summary: 42 }).slice(0, 1), "(");
		const bounded = boundedFailureDiagnostics({ summary: "y".repeat(MAX_ERROR_LENGTH + 100) });
		assert.equal(bounded.length, MAX_ERROR_LENGTH);
	});

	it("correlates completion payload children by stable workflow key", () => {
		const results = [
			{ workflowKey: "scout", status: "completed", structuredOutput: { summary: "s" } },
			{ workflowKey: "implement", status: "completed", runId: "run-i", structuredOutput: { changedFiles: ["a.ts"], implementationSummary: "ok" } },
			{ workflowKey: "implement", status: "failed", structuredOutput: undefined },
		];
		assert.equal(childStructuredOutput(results, "implement")?.runId, "run-i");
		assert.equal(childResults(results).length, 3);
		assert.equal(childStructuredOutput(results, "nonexistent"), undefined);
		assert.equal(childStructuredOutput("not-an-array", "implement"), undefined);
	});
});
