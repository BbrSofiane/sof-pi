/**
 * `/factory <task>` — a minimal, reliable software factory.
 *
 * The parent Pi session stays the orchestrator; this extension is a thin,
 * human-owned launcher on top of the installed pi-subagents extension. It owns
 * only: trust/baseline validation, strict config parsing, workflow generation,
 * RPC correlation, and deterministic validation checks. Execution, lifecycle,
 * missions, artifacts, status, resume, and Herdr integration stay with
 * pi-subagents.
 *
 * Pipeline (two bounded async workflows, checks in between):
 *
 *   build workflow   scout → plan → implement (single writer)
 *   deterministic    human-authored validation commands from .pi/factory.json
 *   review workflow  3 parallel fresh reviewers → at most one fix pass
 *   deterministic    the same trusted commands, rerun as final verification
 *
 * Deliberate deviation: pi-subagents v0.61 grants runs.host only to named
 * workflow resources (npm test / npm run typecheck), so inline workflowScripts
 * launched through the public execution boundary cannot use it. The factory
 * therefore runs the trusted validation commands in this extension process,
 * between the two workflows. Commands come ONLY from .pi/factory.json — never
 * from model output — so the security property ("model-proposed commands are
 * never executed") is preserved.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { parseFactoryConfig, FACTORY_CONFIG_FILENAME, type FactoryConfig } from "./src/config.ts";
import { allChecksPassed, runValidationChecks } from "./src/checks.ts";
import {
	FactoryRpcError,
	rpcPing,
	rpcRequest,
} from "./src/rpc.ts";
import {
	ACTIVE_PHASES,
	FACTORY_STATE_ENTRY,
	childStructuredOutput,
	handoffFromStructuredOutput,
	isFactoryRunState,
	type FactoryCheckRecord,
	type FactoryHandoffRecord,
	type FactoryRunState,
} from "./src/state.ts";
import { buildBuildWorkflowScript, buildReviewWorkflowScript } from "./src/workflow.ts";

const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

function boundedSummary(value: unknown): string {
	return typeof value === "string" ? value.slice(0, 300) : "(no summary)";
}

function nowIso(): string {
	return new Date().toISOString();
}

function formatChecks(checks: FactoryCheckRecord[]): string {
	return checks
		.map((check) => {
			const status = check.timedOut ? "TIMEOUT" : check.exitCode === 0 ? "ok" : `exit ${check.exitCode ?? "?"}`;
			return `  - ${check.name}: ${status} (${check.durationMs}ms)`;
		})
		.join("\n");
}

function formatState(state: FactoryRunState): string {
	const lines: string[] = [
		"Software factory",
		`  Task: ${state.task}`,
		`  Phase: ${state.phase}`,
	];
	if (state.buildRunId) lines.push(`  Build run: ${state.buildRunId}${state.buildMissionId ? ` (mission ${state.buildMissionId})` : ""}`);
	if (state.reviewRunId) lines.push(`  Review run: ${state.reviewRunId}${state.reviewMissionId ? ` (mission ${state.reviewMissionId})` : ""}`);
	if (state.handoff) {
		lines.push(`  Changed files: ${state.handoff.changedFiles.length ? state.handoff.changedFiles.join(", ") : "(none reported)"}`);
	}
	if (state.checks) lines.push("  Checks:\n" + formatChecks(state.checks));
	if (state.finalChecks) lines.push("  Final checks:\n" + formatChecks(state.finalChecks));
	if (state.reviewVerdict) lines.push(`  Reviewers: ${state.reviewVerdict}`);
	if (state.outcome) lines.push(`  Outcome: ${state.outcome}`);
	if (state.decisions?.length) lines.push(`  Decisions requiring human approval:\n${state.decisions.map((d) => `  - ${d}`).join("\n")}`);
	if (state.handoff?.residualRisks.length) lines.push(`  Residual risks: ${state.handoff.residualRisks.join("; ")}`);
	if (state.handoff?.workLeftUndone.length) lines.push(`  Work left undone: ${state.handoff.workLeftUndone.join("; ")}`);
	if (state.error) lines.push(`  Error: ${state.error}`);
	lines.push("  No commit, push, deploy, or release was performed.");
	return lines.join("\n");
}

export default function factoryExtension(pi: ExtensionAPI) {
	let state: FactoryRunState | undefined;

	const restore = (ctx: ExtensionContext) => {
		let restored: FactoryRunState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== FACTORY_STATE_ENTRY) continue;
			// Newest matching entry wins; incompatible entries are skipped (fail closed).
			const parsed = isFactoryRunState(entry.data);
			if (parsed) restored = parsed;
		}
		state = restored;
	};

	const save = () => {
		if (!state) return;
		pi.appendEntry(FACTORY_STATE_ENTRY, state);
	};

	const updateStatus = (ctx: ExtensionContext, label?: string) => {
		if (!state) return;
		const active = ACTIVE_PHASES.includes(state.phase);
		if (label) ctx.ui.setStatus("factory", label);
		else if (active) ctx.ui.setStatus("factory", `factory: ${state.phase}`);
		else ctx.ui.setStatus("factory", undefined);
	};

	// ---- RPC helpers ----------------------------------------------------

	const spawnWorkflow = async (
		script: string,
		input: { task: string; phase: string },
		config: FactoryConfig,
	): Promise<string> => {
		const title = `Factory ${input.phase}: ${input.task.slice(0, 80)}`.replace(/[\r\n]+/g, " ");
		const data = await rpcRequest<{ text?: string; details?: { runId?: string; asyncDir?: string } }>(pi.events, "spawn", {
			workflowScript: script,
			mission: { title },
			timeoutMs: config.timeoutMs,
			globalConcurrencyLimit: config.maxConcurrency,
		});
		const runId = data?.details?.runId;
		if (typeof runId !== "string" || !runId) {
			throw new Error(`pi-subagents accepted the workflow but returned no run id. Response: ${JSON.stringify(data ?? null).slice(0, 500)}`);
		}
		return runId;
	};

	const queryMissionId = async (runId: string): Promise<string | undefined> => {
		try {
			const data = await rpcRequest<{ text?: string }>(pi.events, "status", { id: runId }, { timeoutMs: 20_000 });
			const match = /Mission:\s+(\S+)/.exec(data?.text ?? "");
			return match?.[1];
		} catch {
			return undefined; // Mission id is display/recovery metadata only.
		}
	};

	// ---- Baseline validation -------------------------------------------

	const runGit = (args: string[], cwd: string): Promise<{ code: number; output: string }> =>
		new Promise((resolve) => {
			execFile("git", args, { cwd, encoding: "utf8", timeout: 15_000 }, (error, stdout, stderr) => {
				const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
				resolve({ code, output: `${stdout ?? ""}${stderr ?? ""}`.trim() });
			});
		});

	const loadConfig = (ctx: ExtensionContext): FactoryConfig | undefined => {
		const path = join(ctx.cwd, CONFIG_DIR_NAME, FACTORY_CONFIG_FILENAME);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			ctx.ui.notify(
				`/factory needs human-authored configuration at ${path} (${error instanceof Error ? error.message : String(error)}). ` +
					`See extensions/factory/README.md for the schema.`,
				"error",
			);
			return undefined;
		}
		const parsed = parseFactoryConfig(raw);
		if (!parsed.ok) {
			ctx.ui.notify(`Invalid ${path}:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}`, "error");
			return undefined;
		}
		return parsed.config;
	};

	const validateBaseline = async (ctx: ExtensionContext, config: FactoryConfig): Promise<boolean> => {
		const inside = await runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
		if (inside.code !== 0 || inside.output !== "true") {
			ctx.ui.notify(`/factory must run inside a git work tree (current: ${ctx.cwd}).`, "error");
			return false;
		}
		const status = await runGit(["status", "--porcelain"], ctx.cwd);
		if (status.output && !config.allowDirtyBaseline) {
			const sample = status.output.split("\n").slice(0, 10).join("\n");
			ctx.ui.notify(
				`/factory refuses a dirty git baseline (set "allowDirtyBaseline": true in ${FACTORY_CONFIG_FILENAME} to override):\n${sample}`,
				"error",
			);
			return false;
		}
		return true;
	};

	// ---- Pipeline continuation ------------------------------------------

	const runChecksAndContinue = async (ctx: ExtensionContext, config: FactoryConfig) => {
		if (!state) return;
		state.phase = "checks";
		state.updatedAt = nowIso();
		save();
		updateStatus(ctx);
		let checks: FactoryCheckRecord[];
		try {
			checks = await runValidationChecks(config, ctx.cwd);
		} catch (error) {
			state.phase = "failed";
			state.error = `deterministic checks crashed: ${error instanceof Error ? error.message : String(error)}`;
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory failed: ${state.error}`, "error");
			return;
		}
		state.checks = checks;
		if (!allChecksPassed(checks)) {
			state.phase = "failed";
			state.error = "deterministic validation failed after implementation — no fix loop is attempted; fix and rerun /factory.";
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory failed validation:\n${formatChecks(checks)}`, "error");
			return;
		}
		const script = buildReviewWorkflowScript({
			task: state.task,
			handoff: state.handoff as Record<string, unknown>,
			checks: checks.map(({ name, exitCode }) => ({ name, exitCode })),
		});
		try {
			const runId = await spawnWorkflow(script, { task: state.task, phase: "review" }, config);
			state.reviewRunId = runId;
			state.phase = "review";
			state.updatedAt = nowIso();
			state.reviewMissionId = await queryMissionId(runId);
		} catch (error) {
			state.phase = "failed";
			state.error = `failed to launch review workflow: ${error instanceof Error ? error.message : String(error)}`;
		}
		state.updatedAt = nowIso();
		save();
		updateStatus(ctx);
		if (state.phase === "failed") ctx.ui.notify(`Factory failed: ${state.error}`, "error");
	};

	const runFinalChecksAndFinish = async (ctx: ExtensionContext, config: FactoryConfig) => {
		if (!state) return;
		state.phase = "final-checks";
		state.updatedAt = nowIso();
		save();
		updateStatus(ctx);
		try {
			const finalChecks = await runValidationChecks(config, ctx.cwd);
			state.finalChecks = finalChecks;
			if (allChecksPassed(finalChecks)) {
				state.phase = "complete";
				state.error = undefined;
			} else {
				state.phase = "failed";
				state.error = "final verification failed after the fix pass — the factory is capped at one fix pass; inspect and rerun.";
			}
		} catch (error) {
			state.phase = "failed";
			state.error = `final checks crashed: ${error instanceof Error ? error.message : String(error)}`;
		}
		state.updatedAt = nowIso();
		save();
		updateStatus(ctx);
		if (state.phase === "complete") ctx.ui.notify(`Factory complete.\n${formatState(state)}`, "info");
		else ctx.ui.notify(`Factory failed: ${state.error}`, "error");
	};

	const markNeedsApproval = (decisions: string[], source: string) => {
		if (!state) return;
		state.phase = "needs_approval";
		state.decisions = decisions;
		state.error = `${source} requires human decisions before the factory can continue.`;
		state.updatedAt = nowIso();
		save();
	};

	const handleBuildCompletion = async (ctx: ExtensionContext, payload: Record<string, unknown>, config: FactoryConfig) => {
		if (!state) return;
		state.buildMissionId = state.buildMissionId ?? (state.buildRunId ? await queryMissionId(state.buildRunId) : undefined);
		const paused = payload.state === "paused" && payload.stopped !== true;
		if (paused) {
			// A detached child (contact_supervisor) keeps the workflow alive; the
			// reconciled completion for this run will be ignored (fail closed) —
			// surface the pause instead of pretending the factory failed.
			state.phase = "needs_attention";
			state.error = `build workflow paused (detached child needs a decision). Inspect run ${state.buildRunId ?? "?"} with /factory-status or subagent status, then rerun /factory.`;
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory needs attention: ${state.error}`, "warning");
			return;
		}
		if (payload.success === false || payload.stopped === true || payload.timedOut === true || payload.interrupted === true) {
			state.phase = "failed";
			state.error = `build workflow did not complete (state: ${String(payload.state ?? "unknown")}, summary: ${boundedSummary(payload.summary)}).`;
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory failed: ${state.error}`, "error");
			return;
		}
		const impl = childStructuredOutput(payload.results, "implement");
		const handoff = impl?.status === "completed" ? handoffFromStructuredOutput(impl.structuredOutput) : undefined;
		if (handoff) {
			// The workflow's plan gate already stopped on plan-stage decisions, but
			// a completed implement handoff may still carry unresolved decisions —
			// fail closed instead of proceeding to review with open decisions.
			const implOut = impl?.structuredOutput as { decisionsRequiringApproval?: unknown } | undefined;
			const implDecisions = Array.isArray(implOut?.decisionsRequiringApproval)
				? (implOut?.decisionsRequiringApproval as unknown[]).filter((d): d is string => typeof d === "string")
				: [];
			if (implDecisions.length > 0) {
				markNeedsApproval(implDecisions, "the implement handoff");
				ctx.ui.notify(`Factory paused for approval:\n${implDecisions.map((d) => `  - ${d}`).join("\n")}`, "warning");
				return;
			}
			state.handoff = handoff;
			await runChecksAndContinue(ctx, config);
			return;
		}
		const plan = childStructuredOutput(payload.results, "plan");
		const planOut = plan?.structuredOutput && typeof plan.structuredOutput === "object"
			? (plan.structuredOutput as { decisionsRequiringApproval?: unknown })
			: undefined;
		const decisions = Array.isArray(planOut?.decisionsRequiringApproval)
			? (planOut?.decisionsRequiringApproval as unknown[]).filter((d): d is string => typeof d === "string")
			: [];
		if (decisions.length > 0) {
			markNeedsApproval(decisions, "the plan");
			ctx.ui.notify(`Factory paused for approval:\n${decisions.map((d) => `  - ${d}`).join("\n")}`, "warning");
			return;
		}
		state.phase = "needs_attention";
		state.error = "build workflow finished without a valid implement handoff (missing or malformed structured output).";
		state.updatedAt = nowIso();
		save();
		updateStatus(ctx);
		ctx.ui.notify(`Factory needs attention: ${state.error}`, "warning");
	};

	const handleReviewCompletion = async (ctx: ExtensionContext, payload: Record<string, unknown>, config: FactoryConfig) => {
		if (!state) return;
		state.reviewMissionId = state.reviewMissionId ?? (state.reviewRunId ? await queryMissionId(state.reviewRunId) : undefined);
		const paused = payload.state === "paused" && payload.stopped !== true;
		if (paused) {
			state.phase = "needs_attention";
			state.error = `review workflow paused (detached child needs a decision). Inspect run ${state.reviewRunId ?? "?"} with /factory-status or subagent status, then rerun /factory.`;
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory needs attention: ${state.error}`, "warning");
			return;
		}
		if (payload.success === false || payload.stopped === true || payload.timedOut === true || payload.interrupted === true) {
			state.phase = "failed";
			state.error = `review workflow did not complete (state: ${String(payload.state ?? "unknown")}, summary: ${boundedSummary(payload.summary)}).`;
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory failed: ${state.error}`, "error");
			return;
		}
		const fix = childStructuredOutput(payload.results, "fix");
		const fixHandoff = fix?.status === "completed" ? handoffFromStructuredOutput(fix.structuredOutput) : undefined;
		if (fix && !fixHandoff) {
			// The workflow launched the fix worker but its acceptance handoff is
			// missing or malformed: the files may be partially modified and the
			// findings were never validated. Never report this as a clean run.
			state.phase = "needs_attention";
			state.error = "fix worker ran but did not return a valid acceptance handoff (missing or malformed structured output) — inspect the working tree and rerun /factory.";
			state.updatedAt = nowIso();
			save();
			updateStatus(ctx);
			ctx.ui.notify(`Factory needs attention: ${state.error}`, "warning");
			return;
		}
		if (fixHandoff) {
			const fixOut = fix?.structuredOutput as { decisionsRequiringApproval?: unknown } | undefined;
			const decisions = Array.isArray(fixOut?.decisionsRequiringApproval)
				? (fixOut?.decisionsRequiringApproval as unknown[]).filter((d): d is string => typeof d === "string")
				: [];
			if (decisions.length > 0) {
				markNeedsApproval(decisions, "the fix pass");
				ctx.ui.notify(`Factory paused for approval:\n${decisions.map((d) => `  - ${d}`).join("\n")}`, "warning");
				return;
			}
			state.handoff = fixHandoff;
			state.reviewVerdict = "fix (one fix pass applied)";
			state.outcome = "fixed";
			await runFinalChecksAndFinish(ctx, config);
			return;
		}
		// No fix pass ran: derive the disposition from structured verdicts only.
		const reviewEntries = (Array.isArray(payload.results) ? payload.results : []) as Array<Record<string, unknown>>;
		const verdicts = reviewEntries
			.filter((entry) => typeof entry.workflowKey === "string" && (entry.workflowKey as string).startsWith("review-"))
			.map((entry) => {
				const so = entry.structuredOutput && typeof entry.structuredOutput === "object"
					? (entry.structuredOutput as { verdict?: unknown; findings?: unknown[]; remainingRisks?: unknown[] })
					: undefined;
				const verdict = so && (so.verdict === "ok" || so.verdict === "fix" || so.verdict === "blocked") ? so.verdict : "blocked";
				return {
					key: entry.workflowKey as string,
					verdict,
					findings: Array.isArray(so?.findings) ? so?.findings : [],
				};
			});
		state.reviewVerdict = verdicts.map((v) => `${v.key}=${v.verdict}`).join(", ");
		const blocked = verdicts.filter((v) => v.verdict === "blocked");
		if (blocked.length > 0) {
			const decisions = blocked.flatMap((v) =>
				v.findings
					.filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
					.map((f) => `${v.key}: ${String(f.summary ?? "unspecified")} (${String(f.file ?? "?")}:${String(f.line ?? "?")})`),
			);
			state.outcome = "blocked";
			markNeedsApproval(decisions, "review");
			ctx.ui.notify(`Factory blocked by review (requires human decisions):\n${decisions.map((d) => `  - ${d}`).join("\n")}`, "warning");
			return;
		}
		state.outcome = "ok";
		await runFinalChecksAndFinish(ctx, config);
	};

	// The context captured at completion time; refreshed on every session_start.
	let activeCtx: ExtensionContext | undefined;
	const loadConfigForPipeline = (): FactoryConfig | undefined => {
		if (!activeCtx || !state) return undefined;
		try {
			const path = join(activeCtx.cwd, CONFIG_DIR_NAME, FACTORY_CONFIG_FILENAME);
			const parsed = parseFactoryConfig(JSON.parse(readFileSync(path, "utf8")));
			return parsed.ok ? parsed.config : undefined;
		} catch {
			return undefined;
		}
	};

	// Completion correlation: only exact run ids we launched advance the pipeline.
	pi.events.on(ASYNC_COMPLETE_EVENT, (raw) => {
		const payload = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const runId = typeof payload.runId === "string" ? payload.runId : undefined;
		if (!state || !runId) return;
		const isBuild = state.phase === "build" && runId === state.buildRunId;
		const isReview = state.phase === "review" && runId === state.reviewRunId;
		if (!isBuild && !isReview) return;
		const config = loadConfigForPipeline();
		if (!config) {
			if (state) {
				state.phase = "needs_attention";
				state.error = "factory config disappeared or became invalid mid-run.";
				state.updatedAt = nowIso();
				save();
			}
			return;
		}
		const step = isBuild
			? handleBuildCompletion(activeCtx, payload, config)
			: handleReviewCompletion(activeCtx, payload, config);
		step.catch((error) => {
			if (!state) return;
			state.phase = "failed";
			state.error = `factory continuation crashed: ${error instanceof Error ? error.message : String(error)}`;
			state.updatedAt = nowIso();
			save();
			updateStatus(activeCtx);
		});
	});

	// ---- Lifecycle ------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		restore(ctx);
		updateStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		activeCtx = ctx;
		restore(ctx);
		updateStatus(ctx);
	});

	// ---- Commands -------------------------------------------------------

	pi.registerCommand("factory", {
		description: "Run the bounded software factory: scout → plan → implement → checks → review → optional fix → final checks",
		handler: async (args, ctx) => {
			const task = (args ?? "").trim();
			if (!task) {
				ctx.ui.notify("Usage: /factory <task>", "error");
				return;
			}
			await ctx.waitForIdle();
			if (state && ACTIVE_PHASES.includes(state.phase)) {
				ctx.ui.notify(`A factory run is already active (phase: ${state.phase}). Check /factory-status; stop or finish it first.`, "warning");
				return;
			}
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("/factory refuses to run in an untrusted project.", "error");
				return;
			}
			const config = loadConfig(ctx);
			if (!config) return;
			if (!(await validateBaseline(ctx, config))) return;
			try {
				await rpcPing(pi.events);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			let script: string;
			try {
				script = buildBuildWorkflowScript({ task });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			state = {
				task,
				phase: "build",
				startedAt: nowIso(),
				updatedAt: nowIso(),
			};
			try {
				const runId = await spawnWorkflow(script, { task, phase: "build" }, config);
				state.buildRunId = runId;
				state.buildMissionId = await queryMissionId(runId);
			} catch (error) {
				state = {
					task,
					phase: "failed",
					error: `failed to launch build workflow: ${error instanceof Error ? error.message : String(error)}`,
					startedAt: nowIso(),
					updatedAt: nowIso(),
				};
				save();
				ctx.ui.notify(`Factory failed to start: ${state.error}`, "error");
				return;
			}
			save();
			updateStatus(ctx, "factory: building");
			ctx.ui.notify(
				`Factory launched (build run ${state.buildRunId}${state.buildMissionId ? `, mission ${state.buildMissionId}` : ""}). ` +
					`Pipeline: scout → plan → implement → checks → review → fix? → final checks. ` +
					`No commit, push, deploy, or release will be performed.`,
				"info",
			);
		},
	});

	pi.registerCommand("factory-status", {
		description: "Show the latest software factory run (phase, run/mission ids, checks, verdict)",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No factory run in this session yet. Start one with /factory <task>.", "info");
				return;
			}
			// Best-effort live state for the currently active workflow.
			const liveRunId = state.phase === "build" ? state.buildRunId : state.phase === "review" ? state.reviewRunId : undefined;
			let liveLine: string | undefined;
			if (liveRunId) {
				try {
					const data = await rpcRequest<{ text?: string }>(pi.events, "status", { id: liveRunId }, { timeoutMs: 20_000 });
					const stateLine = /State:\s+(\S+)/.exec(data?.text ?? "")?.[1];
					if (stateLine) liveLine = `  Live workflow state: ${stateLine}`;
				} catch (error) {
					liveLine = `  Live workflow state: unavailable (${error instanceof FactoryRpcError ? error.code : "error"})`;
				}
			}
			ctx.ui.notify(formatState(state) + (liveLine ? `\n${liveLine}` : ""), "info");
		},
	});
}
