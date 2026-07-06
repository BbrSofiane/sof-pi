/**
 * Perplexity extension for pi.
 *
 * Two pieces:
 *   1. `perplexity_search` tool — single-shot LLM-callable web search via the
 *      Perplexity API. Returns the answer + numbered sources.
 *   2. `/research` command — opens an interactive research panel that runs a
 *      back-and-forth Perplexity session *outside* your main context window,
 *      then builds a recap you can shape and inject into your pi thread.
 *
 * Requires PERPLEXITY_API_KEY in your environment.
 */

import { complete, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	getMarkdownTheme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	type PerplexitySource,
	PERPLEXITY_MODELS,
	searchPerplexity,
} from "./perplexity.ts";
import {
	type ResearchResult,
	type TranscriptTurn,
	ResearchPanel,
} from "./research-panel.ts";

const PERPLEXITY_SEARCH_MODEL_IDS = PERPLEXITY_MODELS.filter((m) => !m.deepResearch).map((m) => m.id);
const DEFAULT_SEARCH_MODEL = "sonar-pro";

function formatSources(sources: PerplexitySource[]): string {
	if (sources.length === 0) return "";
	const lines = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`);
	return `\n\nSources:\n${lines.join("\n")}`;
}

const RECAP_SYSTEM_PROMPT = `You are a research summarizer. Given a transcript of a research session (user questions and assistant answers with sources), produce a clean, self-contained recap that someone can drop into a working context to get up to speed.

Use exactly this structure:

## Topic
A one-line description of what was researched.

## Key Findings
3-6 concise bullets, each a self-contained fact. Inline citations as [n].

## Sources
A numbered list of URLs actually referenced in the findings (skip unreferenced ones). Format: [n] title — url

## Open Questions / Next Steps
2-4 bullets of gaps or logical next steps.

Be concise and factual. Do not add preamble. Do not invent facts not present in the transcript.`;

function transcriptToText(turns: TranscriptTurn[]): string {
	const parts: string[] = [];
	for (const turn of turns) {
		const label = turn.role === "user" ? "User" : "Perplexity";
		let block = `${label}: ${turn.text}`;
		if (turn.role === "assistant" && turn.citations && turn.citations.length > 0) {
			block += "\nCitations:";
			turn.citations.forEach((c, i) => {
				block += `\n[${i + 1}] ${c.title} — ${c.url}`;
			});
		}
		parts.push(block);
	}
	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// ---- 1. perplexity_search tool (LLM-callable) ---------------------

	const PerplexitySearchParams = Type.Object({
		query: Type.String({ description: "The web search query." }),
		model: StringEnum(PERPLEXITY_SEARCH_MODEL_IDS, {
			description: "Perplexity model to use. Defaults to sonar-pro.",
			default: DEFAULT_SEARCH_MODEL,
		}),
		max_tokens: Type.Optional(
			Type.Number({ description: "Optional cap on answer length." }),
		),
	});

	pi.registerTool({
		name: "perplexity_search",
		label: "Perplexity Search",
		description:
			"Run a web search via the Perplexity API and return the answer with numbered sources. Use for fresh information, current events, or anything not in local files. Use the /research command instead when you need an iterative, multi-query research session with a shaped recap.",
		promptSnippet: "Web search via Perplexity (returns answer + sources)",
		promptGuidelines: [
			"Use perplexity_search for facts outside the codebase or local files, recent events, library/API docs, or anything you are unsure is current. Cite the returned source numbers inline.",
		],
		parameters: PerplexitySearchParams,

		async execute(_toolCallId, params, signal) {
			const model = params.model || DEFAULT_SEARCH_MODEL;
			const messages = [
				{ role: "system" as const, content: "You are a helpful search assistant. Answer concisely and cite sources." },
				{ role: "user" as const, content: params.query },
			];
			const result = await searchPerplexity(messages, model, {
				signal,
				maxTokens: params.max_tokens,
			});

			let text = result.content.trim() + formatSources(result.citations);
			const truncation = truncateHead(text, {
				maxBytes: DEFAULT_MAX_BYTES,
			});
			if (truncation.truncated) {
				text =
					truncation.content +
					`\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. ${truncation.outputLines}/${truncation.totalLines} lines.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: { sources: result.citations, model },
			};
		},

		renderCall(args, theme) {
			const model = (args.model as string) || DEFAULT_SEARCH_MODEL;
			const preview =
				args.query.length > 60 ? `${args.query.slice(0, 60)}…` : args.query;
			const text =
				theme.fg("toolTitle", theme.bold("perplexity_search ")) +
				theme.fg("muted", `[${model}] `) +
				theme.fg("dim", preview);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			if (expanded) {
				return new Markdown(text, 0, 0, getMarkdownTheme());
			}
			const firstLine = text.split("\n")[0] ?? text;
			const sources = result.details?.sources as PerplexitySource[] | undefined;
			const srcCount = sources ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : "";
			return new Text(theme.fg("toolOutput", firstLine.slice(0, 200)) + theme.fg("dim", srcCount), 0, 0);
		},
	});

	// ---- 2. /research command (interactive panel) ----------------------

	const synthesizeRecap = async (
		ctx: ExtensionCommandContext,
		turns: TranscriptTurn[],
		signal: AbortSignal,
	): Promise<string> => {
		if (!ctx.model) throw new Error("no model selected");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.ok ? `no API key for ${ctx.model.provider}` : auth.error);
		}
		const userMessage: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Research transcript:\n\n${transcriptToText(turns)}\n\nWrite the recap now.`,
				},
			],
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{ systemPrompt: RECAP_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "aborted") throw new Error("aborted");
		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	};

	pi.registerCommand("research", {
		description: "Interactive Perplexity research panel — search, then build a recap to inject into context",
		handler: async (initialQuery, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/research requires interactive mode", "error");
				return;
			}

			const result = await ctx.ui.custom<ResearchResult | null>((tui, theme, _kb, done) => {
				const panel = new ResearchPanel(tui, theme, {
					synthesize: (turns, signal) => synthesizeRecap(ctx, turns, signal),
					done,
				});
				if (initialQuery.trim()) panel.prefill(initialQuery.trim());
				return panel;
			});

			if (!result?.recap) {
				// cancelled
				return;
			}

			// Recap requested: the panel already synthesized using the pi model
			// (during which it showed a "building recap…" status). Now let the
			// user shape the recap in an editor before it touches context.
			let draft = result.recapText;
			if (!draft.trim()) {
				ctx.ui.notify("Recap came back empty", "warning");
				return;
			}

			const edited = await ctx.ui.editor(
				"Research recap — review/edit, then submit to inject into context",
				draft,
			);

			if (edited === undefined || !edited.trim()) {
				ctx.ui.notify("Recap discarded", "info");
				return;
			}

			// (a) Load into the editor for the user to send themselves — no
			// surprise context injection or cost.
			ctx.ui.setEditorText(edited.trim());
			ctx.ui.notify("Recap loaded — submit when ready.", "info");
		},
	});
}
