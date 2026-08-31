/**
 * Factory run state: a bounded, serializable record of the latest factory run
 * in this session. Persisted as a session entry (like the learning extension)
 * so /factory-status survives restarts and preserves run, child, and mission
 * references needed for recovery.
 */

export type FactoryPhase =
	| "build"
	| "checks"
	| "review"
	| "final-checks"
	| "complete"
	| "needs_approval"
	| "needs_attention"
	| "failed";

export const ACTIVE_PHASES: readonly FactoryPhase[] = ["build", "checks", "review", "final-checks"];

export interface FactoryCheckRecord {
	name: string;
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	outputTail: string;
}

export interface FactoryHandoffRecord {
	changedFiles: string[];
	summary: string;
	commandsRun: Array<{ command: string; exitCode: number }>;
	testsAddedOrUpdated: string[];
	residualRisks: string[];
	workLeftUndone: string[];
}

export interface FactoryRunState {
	task: string;
	phase: FactoryPhase;
	buildRunId?: string;
	buildMissionId?: string;
	reviewRunId?: string;
	reviewMissionId?: string;
	checks?: FactoryCheckRecord[];
	finalChecks?: FactoryCheckRecord[];
	handoff?: FactoryHandoffRecord;
	reviewVerdict?: string;
	decisions?: string[];
	/** Workflow-level verdict from the review workflow (ok/fixed/blocked/…). */
	outcome?: string;
	error?: string;
	startedAt: string;
	updatedAt: string;
}

export const FACTORY_STATE_ENTRY = "factory-state";

const MAX_LIST_ITEMS = 32;
const MAX_STRING_LENGTH = 2_000;

function boundedString(value: unknown, max = MAX_STRING_LENGTH): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function boundedStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.slice(0, MAX_LIST_ITEMS)
		.map((item) => item.slice(0, 500));
}

function boundedCheckRecords(value: unknown): FactoryCheckRecord[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const records = value.slice(0, MAX_LIST_ITEMS).map((raw): FactoryCheckRecord | null => {
		if (!raw || typeof raw !== "object") return null;
		const record = raw as Record<string, unknown>;
		return {
			name: boundedString(record.name, 100),
			command: boundedString(record.command, 500),
			exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
			timedOut: record.timedOut === true,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
			outputTail: boundedString(record.outputTail),
		};
	});
	return records.every((record) => record !== null) ? (records as FactoryCheckRecord[]) : undefined;
}

function boundedHandoff(value: unknown): FactoryHandoffRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const summary = boundedString(record.summary ?? record.implementationSummary);
	if (!summary) return undefined;
	const commandsRun = Array.isArray(record.commandsRun)
		? record.commandsRun
			.slice(0, MAX_LIST_ITEMS)
			.map((entry) => {
				if (!entry || typeof entry !== "object") return null;
				const command = (entry as Record<string, unknown>).command;
				const exitCode = (entry as Record<string, unknown>).exitCode;
				if (typeof command !== "string" || typeof exitCode !== "number") return null;
				return { command: command.slice(0, 500), exitCode };
			})
			.filter((entry): entry is { command: string; exitCode: number } => entry !== null)
		: [];
	return {
		changedFiles: boundedStringList(record.changedFiles),
		summary,
		commandsRun,
		testsAddedOrUpdated: boundedStringList(record.testsAddedOrUpdated ?? record.tests),
		residualRisks: boundedStringList(record.residualRisks),
		workLeftUndone: boundedStringList(record.workLeftUndone),
	};
}

/**
 * Validate a restored/serialized factory state. Returns undefined for
 * incompatible data instead of guessing (fail closed on restore).
 */
export function isFactoryRunState(value: unknown): FactoryRunState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.task !== undefined && typeof record.task !== "string") return undefined;
	const phase = record.phase;
	if (typeof phase !== "string") return undefined;
	const allowed = new Set<string>([...ACTIVE_PHASES, "complete", "needs_approval", "needs_attention", "failed"]);
	if (!allowed.has(phase)) return undefined;
	const state: Partial<FactoryRunState> = {
	task: boundedString(record.task, 4_000),
	phase: phase as FactoryPhase,
	startedAt: boundedString(record.startedAt, 40),
	updatedAt: boundedString(record.updatedAt, 40),
};
for (const field of ["buildRunId", "buildMissionId", "reviewRunId", "reviewMissionId", "outcome", "error"] as const) {
	const raw = record[field];
	if (raw === undefined) continue;
	if (typeof raw !== "string" || !raw) return undefined; // wrong-typed optional field fails closed
	Object.assign(state, { [field]: boundedString(raw, 200) });
}
if (record.reviewVerdict !== undefined) {
	if (typeof record.reviewVerdict !== "string" || !record.reviewVerdict) return undefined;
	state.reviewVerdict = boundedString(record.reviewVerdict, 40);
}
if (record.decisions !== undefined) {
	if (!Array.isArray(record.decisions)) return undefined;
	state.decisions = boundedStringList(record.decisions);
}
if (record.checks !== undefined) {
	const checks = boundedCheckRecords(record.checks);
	if (!checks) return undefined;
	state.checks = checks;
}
if (record.finalChecks !== undefined) {
	const finalChecks = boundedCheckRecords(record.finalChecks);
	if (!finalChecks) return undefined;
	state.finalChecks = finalChecks;
}
if (record.handoff !== undefined) {
	const handoff = boundedHandoff(record.handoff);
	if (!handoff) return undefined;
	state.handoff = handoff;
}
return state as FactoryRunState;
}

/** Extract a bounded, typed handoff record from a workflow child structured output. */
export function handoffFromStructuredOutput(value: unknown): FactoryHandoffRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.changedFiles) || typeof record.implementationSummary !== "string") return undefined;
	return boundedHandoff(value);
}

/** Extract the implement/fix child's structured output from a completion payload. */
export function childStructuredOutput(
	results: unknown,
	workflowKey: string,
): { structuredOutput: unknown; status: string | undefined; runId: string | undefined } | undefined {
	if (!Array.isArray(results)) return undefined;
	for (const raw of results) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (entry.workflowKey !== workflowKey) continue;
		return {
			structuredOutput: entry.structuredOutput,
			status: typeof entry.status === "string" ? entry.status : undefined,
			runId: typeof entry.runId === "string" ? entry.runId : undefined,
		};
	}
	return undefined;
}

/** Collect every child entry's workflow key, status, and structured output from a completion payload. */
export function childResults(results: unknown): Array<{ workflowKey: string; status: string; structuredOutput: unknown }> {
	if (!Array.isArray(results)) return [];
	const out: Array<{ workflowKey: string; status: string; structuredOutput: unknown }> = [];
	for (const raw of results) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		if (typeof entry.workflowKey !== "string") continue;
		out.push({
			workflowKey: entry.workflowKey,
			status: typeof entry.status === "string" ? entry.status : "unknown",
			structuredOutput: entry.structuredOutput,
		});
	}
	return out;
}
