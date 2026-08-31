import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { allChecksPassed, createExecCheckRunner, runValidationChecks } from "../../extensions/factory/src/checks.ts";
import { parseFactoryConfig } from "../../extensions/factory/src/config.ts";

const configResult = parseFactoryConfig({
	version: 1,
	validationCommands: [
		{ name: "test", command: "pnpm test" },
		{ name: "typecheck", command: "pnpm run typecheck" },
	],
});
if (!configResult.ok) throw new Error("fixture config must validate");

describe("deterministic checks", () => {
	it("runs every configured command in order and records bounded results", async () => {
		const calls: string[] = [];
		const results = await runValidationChecks(configResult.config, "/tmp", async (command) => {
			calls.push(command);
			return command === "pnpm test"
				? { exitCode: 0, timedOut: false, output: "ok" }
				: { exitCode: 2, timedOut: false, output: "error: syntax" };
		});
		assert.deepEqual(calls, ["pnpm test", "pnpm run typecheck"]);
		assert.equal(results[0].name, "test");
		assert.equal(results[0].exitCode, 0);
		assert.equal(results[1].exitCode, 2);
		assert.ok(results[1].outputTail.includes("error: syntax"));
		assert.equal(allChecksPassed(results), false);
	});

	it("truncates oversized output to a bounded tail", async () => {
		const results = await runValidationChecks(configResult.config, "/tmp", async () => ({
			exitCode: 0,
			timedOut: false,
			output: "x".repeat(100_000) + "THE-END",
		}));
		assert.ok(results[0].outputTail.length < 2_100);
		assert.ok(results[0].outputTail.endsWith("THE-END"));
	});

	it("treats timeouts and spawn failures as failed checks, not crashes", async () => {
		const results = await runValidationChecks(configResult.config, "/tmp", async (command) =>
			command === "pnpm test"
				? { exitCode: null, timedOut: true, output: "killed" }
				: { exitCode: null, timedOut: false, output: "spawn ENOENT" },
		);
		assert.equal(allChecksPassed(results), false);
		assert.equal(results[0].timedOut, true);
	});

	it("the default runner executes real commands and reports real exit codes", async () => {
		const runner = createExecCheckRunner();
		const ok = await runner("echo hello", process.cwd(), 10_000);
		assert.equal(ok.exitCode, 0);
		assert.ok(ok.output.includes("hello"));
		const failing = await runner("exit 3", process.cwd(), 10_000);
		assert.equal(failing.exitCode, 3);
		const timingOut = await runner("sleep 5", process.cwd(), 300);
		assert.equal(timingOut.timedOut, true);
		assert.notEqual(timingOut.exitCode, 0);
	});
});
