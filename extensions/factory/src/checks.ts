/**
 * Deterministic validation checks.
 *
 * Commands come ONLY from the strictly-validated, human-authored factory
 * configuration. Model output is never executed here: child agents may report
 * commands they ran, but the factory's own checks are decided entirely by
 * configuration.
 */

import { exec } from "node:child_process";

import type { FactoryConfig } from "./config.ts";

export interface CheckResult {
	name: string;
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Bounded tail of combined stdout+stderr. */
	outputTail: string;
}

const OUTPUT_TAIL_BYTES = 2_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Pluggable command runner (injected in tests). */
export type CheckRunner = (
	command: string,
	cwd: string,
	timeoutMs: number,
) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;

function tail(text: string): string {
	return text.length <= OUTPUT_TAIL_BYTES ? text : `…${text.slice(-OUTPUT_TAIL_BYTES)}`;
}

/** Default runner backed by the platform shell (commands are human-authored). */
export function createExecCheckRunner(): CheckRunner {
	return (command, cwd, timeoutMs) =>
		new Promise((resolve) => {
			const startedAt = Date.now();
			exec(
				command,
				{ cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
				(error, stdout, stderr) => {
					const timedOut = Boolean(error && (error as { killed?: boolean }).killed && (error as { signal?: string }).signal === "SIGTERM");
					const exitCode = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
					const output = `${stdout ?? ""}${stderr ?? ""}`;
					resolve({ exitCode, timedOut, output: `${output}\n[duration ${Date.now() - startedAt}ms]` });
				},
			);
		});
}

/**
 * Run every configured validation command in order, collecting bounded
 * results. A command that fails to spawn is a failed check (exitCode null),
 * not a crash of the factory.
 */
export async function runValidationChecks(
	config: FactoryConfig,
	cwd: string,
	runner: CheckRunner = createExecCheckRunner(),
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const { name, command } of config.validationCommands) {
		const startedAt = Date.now();
		const outcome = await runner(command, cwd, config.commandTimeoutMs);
		results.push({
			name,
			command,
			exitCode: outcome.exitCode,
			timedOut: outcome.timedOut,
			durationMs: Date.now() - startedAt,
			outputTail: tail(outcome.output),
		});
	}
	return results;
}

export function allChecksPassed(checks: CheckResult[]): boolean {
	return checks.every((check) => !check.timedOut && check.exitCode === 0);
}
