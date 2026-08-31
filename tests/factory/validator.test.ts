import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildBuildWorkflowScript, buildReviewWorkflowScript } from "../../extensions/factory/src/workflow.ts";
import { piSubagentsCopy } from "./helpers.ts";

const TASK = [
	"Add a health-check endpoint with tests and documentation.",
	"",
	"```bash",
	"npm run build && curl localhost:3000/health",
	"```",
].join("\n");

async function validator(): Promise<(script: string) => { ok: boolean; errors?: Array<{ message: string }> }> {
	const dir = await piSubagentsCopy();
	const mod = (await import(`${dir}/src/workflows/scripted-workflow.ts`)) as {
		validateWorkflowScript: (script: string) => { ok: boolean; errors?: Array<{ message: string }> };
	};
	return mod.validateWorkflowScript;
}

describe("generated workflows pass real pi-subagents offline validation", () => {
	it("build workflow script validates", async () => {
		const validate = await validator();
		const result = validate(buildBuildWorkflowScript({ task: TASK }));
		assert.deepEqual(result.errors ?? [], []);
		assert.equal(result.ok, true);
	});

	it("review workflow script (with fix pass) validates", async () => {
		const validate = await validator();
		const result = validate(
			buildReviewWorkflowScript({
				task: TASK,
				handoff: { changedFiles: ["a.ts"], summary: "ok" },
				checks: [{ name: "test", exitCode: 0 }],
			}),
		);
		assert.deepEqual(result.errors ?? [], []);
		assert.equal(result.ok, true);
	});

	it("a deliberately broken script fails validation", async () => {
		const validate = await validator();
		const result = validate("const x = ;;; return x");
		assert.equal(result.ok, false);
		assert.ok((result.errors ?? []).length > 0);
	});
});
