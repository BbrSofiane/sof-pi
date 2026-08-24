import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "learning-state";
const STATUS_KEY = "learning";

interface LearningState {
	active: boolean;
	concept: string;
	priorKnowledge: string;
	timeboxMinutes: number;
	startedAt: string;
}

function isLearningState(value: unknown): value is LearningState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LearningState>;
	return (
		typeof state.active === "boolean" &&
		typeof state.concept === "string" &&
		typeof state.priorKnowledge === "string" &&
		typeof state.timeboxMinutes === "number" &&
		Number.isFinite(state.timeboxMinutes) &&
		typeof state.startedAt === "string"
	);
}

function latestState(ctx: ExtensionContext): LearningState | undefined {
	let state: LearningState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		// The newest matching entry is authoritative. An incompatible entry must
		// disable the mode rather than silently resurrecting older active state.
		state = isLearningState(entry.data) ? entry.data : undefined;
	}
	return state;
}

function coachingPrompt(state: LearningState): string {
	return `

PROJECT-BASED LEARNING MODE IS ACTIVE.

Learning target: ${state.concept}
Learner's starting point: ${state.priorKnowledge}
Timebox: about ${state.timeboxMinutes} minutes

Act as a project-based learning coach. Build a ramp to knowledge, not a syllabus.

Follow this loop:
1. Need — establish a concrete, observable problem that makes the target concept useful.
2. Attempt — ask the learner to predict, design, write, or debug before explaining.
3. Friction — identify the smallest specific blocker in the learner's attempt.
4. Minimum lesson — explain only enough to clear that blocker, using the current project as the example.
5. Application — have the learner immediately apply the idea.
6. Proof — ask the learner to explain, vary, or debug the result without copying.

Rules:
- Keep the project and a working artifact central. Do not present a syllabus or front-load theory.
- At kickoff, propose 2–3 tiny projects that fit the target and timebox. For each, state the visible outcome and why the concept becomes necessary. Then stop and let the learner choose.
- After a project is chosen, present only the first challenge. Reveal later steps only when they become relevant.
- Ask for a prediction or attempt before giving an explanation whenever practical.
- Start hints small. Escalate from a question, to a conceptual hint, to pseudocode or a partial example, and only then to a complete solution.
- Do not make substantive project edits or implement the learning task for the learner unless they explicitly ask. Reading files, running diagnostics, and reviewing the learner's work are encouraged.
- If the learner explicitly asks for the answer, provide it, but follow with a variation or explanation check that restores active practice.
- Introduce terminology at the moment it resolves current friction. Tie every explanation to something observable.
- Prefer short cycles with frequent working checkpoints over long explanations.
- Distinguish productive struggle from incidental setup pain. Help directly with tooling or boilerplate that does not teach the target concept.
- Adapt to the stated starting point; never pretend evidence of understanding that has not been demonstrated.
- Finish with proof: the learner should explain the concept and make one small independent variation.
- Optimize for useful Eureka moments per minute, not coverage.
`;
}

function kickoffMessage(state: LearningState): string {
	return `Start a project-based learning ramp for **${state.concept}**.

My current understanding: ${state.priorKnowledge}
Available time: about ${state.timeboxMinutes} minutes.

Propose 2–3 small project options as instructed by learning mode, then wait for me to choose.`;
}

export default function learningExtension(pi: ExtensionAPI) {
	let state: LearningState | undefined;

	const updateIndicator = (ctx: ExtensionContext) => {
		if (state?.active) {
			ctx.ui.setStatus(STATUS_KEY, `learn: ${state.concept}`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	const restore = (ctx: ExtensionContext) => {
		state = latestState(ctx);
		updateIndicator(ctx);
	};

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!state?.active) return undefined;
		return { systemPrompt: event.systemPrompt + coachingPrompt(state) };
	});

	pi.registerCommand("learn", {
		description: "Start a project-based learning ramp for a specific concept",
		handler: async (args, ctx) => {
			// Slash commands can be dispatched while a turn is still settling.
			// Waiting first makes the eventual kickoff send valid and atomic from
			// the learner's perspective: no state is persisted before it can send.
			await ctx.waitForIdle();

			if (state?.active) {
				ctx.ui.notify(
					`Already learning “${state.concept}”. Run /learn-stop before starting another ramp.`,
					"warning",
				);
				return;
			}

			let concept = args.trim();
			if (!concept && ctx.hasUI) {
				concept = (await ctx.ui.input("What do you want to learn?", "A specific concept"))?.trim() ?? "";
			}
			if (!concept) {
				ctx.ui.notify("Usage: /learn <specific concept>", "error");
				return;
			}

			let priorKnowledge = "I am new to this concept.";
			let timeboxMinutes = 45;
			if (ctx.hasUI) {
				const answer = await ctx.ui.input(
					"What do you already know?",
					"A sentence is enough; leave blank if new",
				);
				if (answer === undefined) return;
				if (answer.trim()) priorKnowledge = answer.trim();

				const timebox = await ctx.ui.select("Choose a timebox", ["20 minutes", "45 minutes", "90 minutes"]);
				if (timebox === undefined) return;
				timeboxMinutes = Number.parseInt(timebox, 10);
			}

			state = {
				active: true,
				concept,
				priorKnowledge,
				timeboxMinutes,
				startedAt: new Date().toISOString(),
			};
			pi.appendEntry(STATE_ENTRY, state);
			updateIndicator(ctx);
			pi.sendUserMessage(kickoffMessage(state));
		},
	});

	pi.registerCommand("learn-status", {
		description: "Show the active learning ramp",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No learning ramp is active. Start one with /learn <concept>.", "info");
				return;
			}
			ctx.ui.notify(
				[`Learning: ${state.concept}`, `Starting point: ${state.priorKnowledge}`, `Timebox: ${state.timeboxMinutes} minutes`].join(
					"\n",
				),
				"info",
			);
		},
	});

	pi.registerCommand("learn-stop", {
		description: "Stop the active learning ramp",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No learning ramp is active.", "info");
				return;
			}
			const stoppedConcept = state.concept;
			state = { ...state, active: false };
			pi.appendEntry(STATE_ENTRY, state);
			updateIndicator(ctx);
			ctx.ui.notify(`Stopped learning ramp: ${stoppedConcept}`, "info");
		},
	});
}
