/**
 * Shared test helpers for the factory tests.
 *
 * Two needs are covered here:
 *
 * 1. A sandbox evaluator that runs the generated workflowScript bodies with
 *    stubbed `runs`/`state` globals — proving branching, bounded fix passes,
 *    structured-output-only branching, and that no command execution can
 *    happen inside a workflow — without any model or child process.
 *
 * 2. A per-process copy of the installed pi-subagents source outside any
 *    node_modules directory, so Node's type-stripping loader can import the
 *    real `validateWorkflowScript` and the real RPC bridge for offline
 *    validation and smoke tests. (Node refuses to type-strip files under
 *    node_modules, so we copy the source tree out and symlink the dependency
 *    packages.)
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ---- Sandbox evaluation ------------------------------------------------

export interface SandboxStubChild {
	key: string;
	params: Record<string, unknown>;
}

export interface SandboxHarness {
	calls: Array<{ kind: "run" | "all" | "host"; keys: string[]; params?: unknown }>;
	state: Map<string, unknown>;
	returned: unknown;
}

/**
 * Evaluate a generated workflowScript body with stubbed runs/state globals.
 * `handlers` maps stable child keys to results. `runs.host` always throws:
 * factory workflows must never call it.
 */
export async function evalWorkflowScript(
	script: string,
	handlers: Record<string, ((params: Record<string, unknown>) => unknown) | unknown>,
): Promise<SandboxHarness> {
	const harness: SandboxHarness = { calls: [], state: new Map(), returned: undefined };
	const resolve = (key: string, params: Record<string, unknown>): unknown => {
		const handler = handlers[key];
		if (handler === undefined) throw new Error(`sandbox: unexpected child '${key}'`);
		return typeof handler === "function" ? (handler as (params: Record<string, unknown>) => unknown)(params) : handler;
	};
	const runs = {
		run: async (key: string, params: Record<string, unknown>) => {
			harness.calls.push({ kind: "run", keys: [key], params });
			return await resolve(key, params);
		},
		all: async (items: Array<{ key: string; [k: string]: unknown }>) => {
			harness.calls.push({ kind: "all", keys: items.map((item) => item.key) });
			return Promise.all(
				items.map(async (item) => {
					const { key, ...params } = item;
					return await resolve(key, params as Record<string, unknown>);
				}),
			);
		},
		host: () => {
			harness.calls.push({ kind: "host", keys: ["<host>"] });
			throw new Error("sandbox: runs.host must never be called by factory workflows");
		},
	};
	const state = {
		set: async (key: string, value: unknown) => {
			harness.state.set(key, value);
		},
		get: async (key: string) => harness.state.get(key),
	};
	const asyncConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
		...args: string[]
	) => (globals: Record<string, unknown>) => Promise<unknown>;
	const factory = new asyncConstructor("runs", "state", "console", "emit", script);
	harness.returned = await factory(runs, state, console, () => {});
	return harness;
}

/**
 * Parse a generated workflowScript body without executing it (syntax check).
 * Throws on syntax errors, including broken string escaping.
 */
export function parseWorkflowScript(script: string): void {
	const asyncConstructor = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => unknown;
	new asyncConstructor("runs", "state", "console", "emit", script);
}

// ---- Real pi-subagents source copy (for validator + RPC smoke tests) ----

let copyPromise: Promise<string> | undefined;

function piSubagentsRoot(): string {
	const override = process.env.PI_SUBAGENTS_PATH;
	if (override && existsSync(override)) return override;
	const defaultPath = join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
	if (!existsSync(defaultPath)) {
		throw new Error(`pi-subagents not found at ${defaultPath}; set PI_SUBAGENTS_PATH to its install directory.`);
	}
	return defaultPath;
}

/**
 * Copy the installed pi-subagents `src/` tree to a temp directory (outside any
 * node_modules) and symlink every resolvable dependency package, so Node's
 * type-stripping loader can import the real extension modules. The copy is
 * created once per test process and cleaned up on process exit.
 */
export function piSubagentsCopy(): Promise<string> {
	copyPromise ??= (async () => {
		const root = piSubagentsRoot();
		const dir = mkdtempSync(join(tmpdir(), "factory-pi-subagents-"));
		process.on("exit", () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		});
		cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "node_modules"), { recursive: true });
		const linkAll = (source: string) => {
			for (const entry of readdirSync(source, { withFileTypes: true })) {
				if (entry.name === ".bin" || entry.name === ".pnpm") continue;
				const target = join(dir, "node_modules", entry.name);
				if (existsSync(target)) continue;
				symlinkSync(join(source, entry.name), target);
			}
		};
		linkAll(join(root, "node_modules")); // package-local deps (e.g. typebox)
		linkAll(join(homedir(), ".pi/agent/npm/node_modules")); // hoisted deps (acorn, yaml, …)
		return dir;
	})();
	return copyPromise;
}

/** Synchronous git helper used by tests to build disposable repositories. */
export function git(cwd: string, args: string): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
