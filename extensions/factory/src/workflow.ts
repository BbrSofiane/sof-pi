/**
 * Factory workflow script builders.
 *
 * These functions generate the two fixed workflowScript bodies the factory
 * launches through pi-subagents:
 *
 *   1. build  — scout → plan → implement (one writer)
 *   2. review — three parallel fresh reviewers → optional single fix pass
 *
 * Rules encoded here:
 * - The human task and every machine-consumed value are embedded with
 *   JSON.stringify at generation time, so quotes, Markdown fences, shell-like
 *   text, and multiline prompts can never break out of the script.
 * - Every child uses a stable workflow key and fresh context.
 * - Every machine-consumed child result uses an outputSchema, and the scripts
 *   branch ONLY on structuredOutput — never on child prose.
 * - Malformed or missing structured output fails the stage closed
 *   (needs_attention / blocked), it never reaches the next stage unchecked.
 * - The review→fix loop is capped at exactly one fix pass by construction.
 * - The scripts never call runs.host: deterministic validation commands are
 *   executed by the factory extension itself from human-authored config.
 */

/** Stable workflow keys — also the keys the extension correlates in completion results. */
export const WORKFLOW_KEYS = {
	scout: "scout",
	plan: "plan",
	implement: "implement",
	reviewCorrectness: "review-correctness",
	reviewTests: "review-tests",
	reviewSimplicity: "review-simplicity",
	fix: "fix",
} as const;

export const REVIEW_KEYS = [
	WORKFLOW_KEYS.reviewCorrectness,
	WORKFLOW_KEYS.reviewTests,
	WORKFLOW_KEYS.reviewSimplicity,
] as const;

/** JSON Schema for scout structured output. The scout must not edit files. */
const SCOUT_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		relevantFiles: { type: "array", items: { type: "string" } },
		constraints: { type: "array", items: { type: "string" } },
		risks: { type: "array", items: { type: "string" } },
		implementationSeam: { type: "string" },
		validationCommandsFound: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "relevantFiles", "constraints", "risks", "implementationSeam", "validationCommandsFound"],
	additionalProperties: false,
} as const;

/** JSON Schema for planner structured output. */
const PLAN_SCHEMA = {
	type: "object",
	properties: {
		steps: { type: "array", items: { type: "string" } },
		filesToChange: { type: "array", items: { type: "string" } },
		nonGoals: { type: "array", items: { type: "string" } },
		validationPlan: { type: "array", items: { type: "string" } },
		decisionsRequiringApproval: { type: "array", items: { type: "string" } },
	},
	required: ["steps", "filesToChange", "nonGoals", "validationPlan", "decisionsRequiringApproval"],
	additionalProperties: false,
} as const;

/** JSON Schema for the implement/fix worker's checked acceptance handoff. */
const IMPL_SCHEMA = {
	type: "object",
	properties: {
		changedFiles: { type: "array", items: { type: "string" } },
		implementationSummary: { type: "string" },
		commandsRun: {
			type: "array",
			items: {
				type: "object",
				properties: { command: { type: "string" }, exitCode: { type: "integer" } },
				required: ["command", "exitCode"],
				additionalProperties: false,
			},
		},
		testsAddedOrUpdated: { type: "array", items: { type: "string" } },
		residualRisks: { type: "array", items: { type: "string" } },
		workLeftUndone: { type: "array", items: { type: "string" } },
		decisionsRequiringApproval: { type: "array", items: { type: "string" } },
	},
	required: [
		"changedFiles",
		"implementationSummary",
		"commandsRun",
		"testsAddedOrUpdated",
		"residualRisks",
		"workLeftUndone",
		"decisionsRequiringApproval",
	],
	additionalProperties: false,
} as const;

/** JSON Schema for reviewer structured output. Branching uses verdict only. */
const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["ok", "fix", "blocked"] },
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
					summary: { type: "string" },
					evidence: { type: "string" },
					file: { type: "string" },
					line: { type: "integer" },
				},
				required: ["priority", "summary", "evidence", "file", "line"],
				additionalProperties: false,
			},
		},
		remainingRisks: { type: "array", items: { type: "string" } },
	},
	required: ["verdict", "findings", "remainingRisks"],
	additionalProperties: false,
} as const;

/** Maximum embedded human task length (characters). Keeps generated scripts bounded. */
const MAX_TASK_LENGTH = 16_000;

/**
 * Safely encode the human task for embedding in a generated workflow script.
 * Throws on empty or oversized tasks so callers can fail closed before launch.
 */
export function encodeTask(task: string): string {
	const trimmed = task.trim();
	if (!trimmed) throw new Error("factory task must be a non-empty string.");
	if (trimmed.length > MAX_TASK_LENGTH) {
		throw new Error(`factory task must be at most ${MAX_TASK_LENGTH} characters (got ${trimmed.length}).`);
	}
	return JSON.stringify(trimmed);
}

/**
 * Checked acceptance policy applied to the implement and fix workers.
 * Enforced by pi-subagents itself, not by this extension.
 */
const WORKER_ACCEPTANCE = { level: "checked", evidence: ["commands-run", "changed-files"] } as const;

const SCOUT_TASK_PREFIX = [
	"You are the scout phase of a software factory. Recon only.",
	"",
	"## Task",
	"",
].join("\n");

const SCOUT_TASK_SUFFIX = [
	"",
	"## Rules",
	"",
	"- You MUST NOT edit, write, create, or delete any repository files. Read-only recon.",
	"- Return structured output with: a short summary; the relevant files (paths);",
	"  constraints that bind the implementation; likely risks; the recommended",
	"  implementation seam (where the change should land); and any existing",
	"  validation commands you find in trusted repository configuration",
	"  (package scripts, Makefile, mise tasks, CI config). Report commands only —",
	"  never run them, and never propose new ones.",
].join("\n");

const PLAN_TASK_PREFIX = [
	"You are the plan phase of a software factory. Read-only planning.",
	"",
	"## Task",
	"",
].join("\n");

const PLAN_TASK_MIDDLE = [
	"",
	"## Scout findings (validated structured output)",
	"",
].join("\n");

const PLAN_TASK_SUFFIX = [
	"",
	"## Rules",
	"",
	"- You MUST NOT edit, write, create, or delete any files. Produce a plan only.",
	"- Return structured output with: concrete implementation steps; files expected",
	"  to change; explicit non-goals; a validation plan; and any decisions that",
	"  require human approval (product, architecture, security, or scope calls).",
	"- If a required decision is human-owned, list it in decisionsRequiringApproval",
	"  instead of assuming. The factory stops on any unresolved decision.",
].join("\n");

const IMPL_TASK_PREFIX = [
	"You are the implement phase of a software factory. You are the single writer.",
	"",
	"## Human task",
	"",
].join("\n");

const IMPL_TASK_MIDDLE = [
	"",
	"## Validated plan and scout fields",
	"",
].join("\n");

const IMPL_TASK_SUFFIX = [
	"",
	"## Rules",
	"",
	"- Implement exactly the plan. Stay inside the listed files and non-goals.",
	"- Run the plan's validation commands and report each command with its exit",
	"  code in commandsRun. Do not commit, push, merge, publish, deploy, or release.",
	"- If a human-owned decision surfaces that the plan did not cover, stop and",
	"  list it in decisionsRequiringApproval instead of deciding yourself.",
	"- Report a checked acceptance handoff as structured output: changedFiles,",
	"  implementationSummary, commandsRun (with exit codes), testsAddedOrUpdated,",
	"  residualRisks, workLeftUndone, decisionsRequiringApproval.",
].join("\n");

const REVIEW_TASK_PREFIX = [
	"You are a fresh-context reviewer in a software factory. Read-only review.",
	"",
	"## Human task being implemented",
	"",
].join("\n");

const REVIEW_TASK_MIDDLE = [
	"",
	"## Implementation handoff and deterministic check results",
	"",
].join("\n");

const REVIEW_TASK_SUFFIX = [
	"",
	"## Rules",
	"",
	"- You MUST NOT edit, write, create, or delete any files.",
	"- Judge only the current working-tree changes against the handoff. Cite exact",
	"  files and lines as evidence. Do not invent issues.",
	"- Return structured output: verdict must be exactly one of ok, fix, blocked;",
	"  findings each with priority (P0-P3), summary, evidence, file, line (use 0",
	"  when not applicable); plus remainingRisks.",
	"- verdict meanings: ok = nothing worth fixing; fix = concrete in-scope fixes",
	"  a worker can apply now (list them as findings); blocked = requires a",
	"  product, architecture, security, or scope decision (explain in findings).",
].join("\n");

const FIX_TASK_PREFIX = [
	"You are the fix phase of a software factory. You are the single writer.",
	"",
	"## Human task",
	"",
].join("\n");

const FIX_TASK_MIDDLE = [
	"",
	"## In-scope reviewer findings to apply",
	"",
].join("\n");

const FIX_TASK_SUFFIX = [
	"",
	"## Rules",
	"",
	"- Apply ONLY the listed findings. Do not expand scope or refactor beyond the",
	"  findings. Do not invent additional work.",
	"- Do not commit, push, merge, publish, deploy, or release.",
	"- Report the same checked acceptance handoff as structured output as the",
	"  implement phase (changedFiles, implementationSummary, commandsRun with exit",
	"  codes, testsAddedOrUpdated, residualRisks, workLeftUndone,",
	"  decisionsRequiringApproval).",
].join("\n");

/**
 * Build a task expression for the generated script that safely embeds the
 * JSON-encoded human task between fixed sections. Everything is a JSON string
 * literal or a runtime concatenation, so quotes, Markdown fences, shell-like
 * text, and multiline prompts cannot break the generated script.
 */
function taskExpression(prefix: string, encodedTask: string, suffix: string): string {
	return `${JSON.stringify(prefix)} + ${encodedTask} + ${JSON.stringify(suffix)}`;
}

/**
 * Build the build-phase workflowScript: scout → plan → implement.
 * All dynamic values are JSON-encoded at generation time.
 */
export function buildBuildWorkflowScript(input: { task: string }): string {
	const task = encodeTask(input.task);
	const scoutTask = taskExpression(SCOUT_TASK_PREFIX, task, SCOUT_TASK_SUFFIX);
	const planTask = taskExpression(PLAN_TASK_PREFIX, task, PLAN_TASK_MIDDLE)
		+ " + JSON.stringify(scoutOut) + " + JSON.stringify(PLAN_TASK_SUFFIX);
	const implTask = taskExpression(IMPL_TASK_PREFIX, task, IMPL_TASK_MIDDLE)
		+ " + JSON.stringify({ plan: planOut, scout: scoutOut }) + " + JSON.stringify(IMPL_TASK_SUFFIX);
	const script = `
await state.set("factory.phase", "build:scout");
const scout = await runs.run(${JSON.stringify(WORKFLOW_KEYS.scout)}, {
  agent: "scout",
  context: "fresh",
  task: ${scoutTask},
  outputSchema: ${JSON.stringify(SCOUT_SCHEMA)}
});
const scoutOut = scout.structuredOutput;
if (!scoutOut || typeof scoutOut.summary !== "string" || !scoutOut.summary.trim() || !Array.isArray(scoutOut.relevantFiles)) {
  return { verdict: "needs_attention", stage: "scout", reason: "scout did not return valid structured output", runId: scout.runId };
}

await state.set("factory.phase", "build:plan");
const plan = await runs.run(${JSON.stringify(WORKFLOW_KEYS.plan)}, {
  agent: "planner",
  context: "fresh",
  task: ${planTask},
  outputSchema: ${JSON.stringify(PLAN_SCHEMA)}
});
const planOut = plan.structuredOutput;
if (!planOut || !Array.isArray(planOut.steps) || planOut.steps.length === 0 || !Array.isArray(planOut.filesToChange)) {
  return { verdict: "needs_attention", stage: "plan", reason: "planner did not return valid structured output", runId: plan.runId };
}
const planDecisions = Array.isArray(planOut.decisionsRequiringApproval) ? planOut.decisionsRequiringApproval : [];
if (planDecisions.length > 0) {
  return { verdict: "needs_approval", stage: "plan", decisions: planDecisions, plan: planOut, runId: plan.runId };
}

await state.set("factory.phase", "build:implement");
const impl = await runs.run(${JSON.stringify(WORKFLOW_KEYS.implement)}, {
  agent: "worker",
  context: "fresh",
  task: ${implTask},
  outputSchema: ${JSON.stringify(IMPL_SCHEMA)},
  acceptance: ${JSON.stringify(WORKER_ACCEPTANCE)}
});
const implOut = impl.structuredOutput;
if (!implOut || !Array.isArray(implOut.changedFiles) || typeof implOut.implementationSummary !== "string") {
  return { verdict: "needs_attention", stage: "implement", reason: "implement worker did not return a valid acceptance handoff", runId: impl.runId };
}
const implDecisions = Array.isArray(implOut.decisionsRequiringApproval) ? implOut.decisionsRequiringApproval : [];
if (implDecisions.length > 0) {
  return { verdict: "needs_approval", stage: "implement", decisions: implDecisions, handoff: implOut, runId: impl.runId };
}
return {
  verdict: "implemented",
  changedFiles: implOut.changedFiles,
  summary: implOut.implementationSummary,
  commandsRun: Array.isArray(implOut.commandsRun) ? implOut.commandsRun : [],
  tests: Array.isArray(implOut.testsAddedOrUpdated) ? implOut.testsAddedOrUpdated : [],
  residualRisks: Array.isArray(implOut.residualRisks) ? implOut.residualRisks : [],
  workLeftUndone: Array.isArray(implOut.workLeftUndone) ? implOut.workLeftUndone : [],
  runId: impl.runId
};
`.trim();
	return script;
}

/**
 * Build the review-phase workflowScript: three parallel fresh reviewers,
 * branching ONLY on structured verdicts, with at most one fix pass.
 */
export function buildReviewWorkflowScript(input: {
	task: string;
	handoff: Record<string, unknown>;
	checks: Array<{ name: string; exitCode: number | null }>;
}): string {
	const task = encodeTask(input.task);
	const reviewContext = JSON.stringify({ handoff: input.handoff, deterministicChecks: input.checks });
	const reviewTask = taskExpression(REVIEW_TASK_PREFIX, task, REVIEW_TASK_MIDDLE)
		+ " + " + JSON.stringify(reviewContext) + " + " + JSON.stringify(REVIEW_TASK_SUFFIX);
	const fixTask = taskExpression(FIX_TASK_PREFIX, task, FIX_TASK_MIDDLE)
		+ " + JSON.stringify({ findings: needsFix.flatMap(v => v.findings), remainingRisks: needsFix.flatMap(v => v.remainingRisks) }) + "
		+ JSON.stringify(FIX_TASK_SUFFIX);
	const script = `
await state.set("factory.phase", "review");
function reviewVerdict(result) {
  if (!result || !result.structuredOutput) return "blocked";
  const verdict = result.structuredOutput.verdict;
  if (verdict === "ok" || verdict === "fix" || verdict === "blocked") return verdict;
  return "blocked";
}
const reviews = await runs.all([
  { key: ${JSON.stringify(WORKFLOW_KEYS.reviewCorrectness)}, agent: "reviewer", context: "fresh", task: ${reviewTask}, outputSchema: ${JSON.stringify(REVIEW_SCHEMA)} },
  { key: ${JSON.stringify(WORKFLOW_KEYS.reviewTests)}, agent: "reviewer", context: "fresh", task: ${reviewTask}, outputSchema: ${JSON.stringify(REVIEW_SCHEMA)} },
  { key: ${JSON.stringify(WORKFLOW_KEYS.reviewSimplicity)}, agent: "reviewer", context: "fresh", task: ${reviewTask}, outputSchema: ${JSON.stringify(REVIEW_SCHEMA)} }
]);
const reviewKeys = ${JSON.stringify(REVIEW_KEYS)};
const verdicts = reviews.map(function (result, index) {
  const so = result && result.structuredOutput;
  return {
    key: reviewKeys[index],
    verdict: reviewVerdict(result),
    findings: so && Array.isArray(so.findings) ? so.findings : [],
    remainingRisks: so && Array.isArray(so.remainingRisks) ? so.remainingRisks : [],
    runId: result ? result.runId : undefined
  };
});
const needsFix = verdicts.filter(function (v) { return v.verdict === "fix"; });
const blockedReviews = verdicts.filter(function (v) { return v.verdict === "blocked"; });
if (needsFix.length === 0) {
  if (blockedReviews.length > 0) {
    return { verdict: "blocked", reviews: verdicts, decisions: blockedReviews.flatMap(function (v) { return v.findings; }) };
  }
  return { verdict: "ok", reviews: verdicts };
}

await state.set("factory.phase", "fix");
const fix = await runs.run(${JSON.stringify(WORKFLOW_KEYS.fix)}, {
  agent: "worker",
  context: "fresh",
  task: ${fixTask},
  outputSchema: ${JSON.stringify(IMPL_SCHEMA)},
  acceptance: ${JSON.stringify(WORKER_ACCEPTANCE)}
});
const fixOut = fix.structuredOutput;
if (!fixOut || !Array.isArray(fixOut.changedFiles) || typeof fixOut.implementationSummary !== "string") {
  return { verdict: "needs_attention", stage: "fix", reason: "fix worker did not return a valid acceptance handoff", reviews: verdicts, runId: fix.runId };
}
const fixDecisions = Array.isArray(fixOut.decisionsRequiringApproval) ? fixOut.decisionsRequiringApproval : [];
if (fixDecisions.length > 0) {
  return { verdict: "needs_approval", stage: "fix", decisions: fixDecisions, reviews: verdicts, handoff: fixOut, runId: fix.runId };
}
return {
  verdict: "fixed",
  reviews: verdicts,
  changedFiles: fixOut.changedFiles,
  summary: fixOut.implementationSummary,
  commandsRun: Array.isArray(fixOut.commandsRun) ? fixOut.commandsRun : [],
  tests: Array.isArray(fixOut.testsAddedOrUpdated) ? fixOut.testsAddedOrUpdated : [],
  residualRisks: Array.isArray(fixOut.residualRisks) ? fixOut.residualRisks : [],
  workLeftUndone: Array.isArray(fixOut.workLeftUndone) ? fixOut.workLeftUndone : [],
  runId: fix.runId
};
`.trim();
	return script;
}
