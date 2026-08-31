import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	childResults,
	childStructuredOutput,
	handoffFromStructuredOutput,
	isFactoryRunState,
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
