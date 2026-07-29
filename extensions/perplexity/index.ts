/**
 * Perplexity extension for pi.
 *
 * Two pieces:
 *   1. Web tools (`web_search`, `fetch_content`, `get_search_content`) —
 *      Perplexity-backed stand-ins for the `pi-web-access` tools that
 *      pi-subagents' `researcher` and `context-builder` agents expect.
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
	type PerplexityMessage,
	type PerplexitySource,
	searchPerplexity,
} from "./perplexity.ts";
import {
	type ResearchResult,
	type TranscriptTurn,
	ResearchPanel,
} from "./research-panel.ts";

const DEFAULT_SEARCH_MODEL = "sonar-pro";

function formatSources(sources: PerplexitySource[]): string {
	if (sources.length === 0) return "";
	const lines = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`);
	return `\n\nSources:\n${lines.join("\n")}`;
}

/** Truncate tool output to pi's built-in byte budget, with a trailing notice. */
function truncateToolOutput(text: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return text;
	return (
		truncation.content +
		`\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. ${truncation.outputLines}/${truncation.totalLines} lines.]`
	);
}

/** Recency windows accepted by the pi-web-access-compatible `web_search` schema. */
const WEB_RECENCY_VALUES = ["day", "week", "month", "year"];

/** Normalize the `query`/`queries` params shared by the web tools. */
function normalizeWebQueries(
	query: string | undefined,
	queries: string[] | undefined,
): string[] {
	const list = Array.isArray(queries)
		? queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
		: [];
	if (list.length === 0 && typeof query === "string" && query.trim()) {
		list.push(query.trim());
	}
	return list.map((q) => q.trim()).filter(Boolean);
}

interface WebSearchEntry {
	query: string;
	content: string;
	citations: PerplexitySource[];
}

interface WebSearchHint {
	recencyFilter?: string;
	domainFilter?: string[];
	numResults?: number;
	includeContent: boolean;
}

/** Build Perplexity messages for a `web_search` query, folding in best-effort hints. */
function buildWebSearchMessages(query: string, hint: WebSearchHint): PerplexityMessage[] {
	const extras: string[] = [];
	if (hint.recencyFilter) extras.push(`Focus on results from the last ${hint.recencyFilter}.`);
	if (hint.domainFilter && hint.domainFilter.length) {
		const include = hint.domainFilter.filter((d) => !d.startsWith("-"));
		const exclude = hint.domainFilter
			.filter((d) => d.startsWith("-"))
			.map((d) => d.slice(1));
		if (include.length) extras.push(`Prefer these domains: ${include.join(", ")}.`);
		if (exclude.length) extras.push(`Avoid these domains: ${exclude.join(", ")}.`);
	}
	const system = hint.includeContent
		? `You are a helpful web research assistant. Answer concisely and accurately, citing sources.${extras.length ? `\n\n${extras.join(" ")}` : ""}`
		: `You are a web search index. Return only a concise list of the most relevant source titles and URLs, one per line, no prose.${extras.length ? `\n\n${extras.join(" ")}` : ""}`;
	return [
		{ role: "system", content: system },
		{ role: "user", content: query },
	];
}

/** Render per-query `web_search` results as a single text block. */
function formatWebSearchResults(
	results: WebSearchEntry[],
	includeContent: boolean,
): string {
	const blocks = results.map((r, i) => {
		const header = `## Query${results.length > 1 ? ` ${i + 1}` : ""}: ${r.query}`;
		const sourceLines = r.citations
			.map((s, j) => `[${j + 1}] ${s.title} — ${s.url}`)
			.join("\n");
		if (includeContent) {
			return `${header}\n\n${r.content.trim() || "(no answer)"}${sourceLines ? `\n\nSources:\n${sourceLines}` : ""}`;
		}
		return `${header}\n${sourceLines || "(no sources)"}`;
	});
	return blocks.join("\n\n---\n\n");
}

/** Build Perplexity messages for `fetch_content` — synthesize page content from a URL. */
function buildFetchContentMessages(url: string, prompt?: string): PerplexityMessage[] {
	const system =
		"You are a content extraction assistant. Read the page at the given URL and respond to the user's instruction. If the page cannot be fetched, say so and answer from what you know, citing sources.";
	const instruction =
		prompt?.trim() || "Summarize the main content of this page, preserving key facts and structure.";
	return [
		{ role: "system", content: system },
		{ role: "user", content: `URL: ${url}\n\n${instruction}` },
	];
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
	// ---- 1b. web_search / fetch_content / get_search_content ------------
	//
	// pi-subagents' `researcher` and `context-builder` agents reference a
	// `web_search` tool (the `researcher` also wants `fetch_content` and
	// `get_search_content`). Those names normally come from the
	// `pi-web-access` package. pi-subagents validates every tool listed in an
	// agent's `tools:` frontmatter against the live tool registry and fails
	// the run if any is missing — so without these shims, subagent runs that
	// list `web_search` abort with an "unavailable tool" error.
	//
	// These three tools are backed by the same Perplexity client as the
	// `/research` panel. They accept pi-web-access-compatible params
	// (`query`/`queries`, `numResults`, `recencyFilter`, `domainFilter`, …)
	// as best-effort hints, since Perplexity synthesizes answers rather than
	// returning raw result snippets.

	const WebSearchParams = Type.Object({
		query: Type.Optional(
			Type.String({ description: "Single search query. Prefer `queries` for multiple angles." }),
		),
		queries: Type.Optional(
			Type.Array(Type.String(), {
				description: "Batch of search queries; each gets its own answer + sources.",
			}),
		),
		numResults: Type.Optional(
			Type.Number({
				description: "Result-count hint (Perplexity controls citation count).",
				default: 5,
			}),
		),
		recencyFilter: Type.Optional(
			StringEnum(WEB_RECENCY_VALUES, { description: "Bias results toward a recency window." }),
		),
		domainFilter: Type.Optional(
			Type.Array(Type.String(), {
				description: "Domains to include (prefix with `-` to exclude). Best-effort hint.",
			}),
		),
		includeContent: Type.Optional(
			Type.Boolean({
				description: "Return synthesized answers (true, default) or just source lists (false).",
				default: true,
			}),
		),
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return answers with numbered sources. Backed by Perplexity. Accepts a single `query` or a `queries` array (preferred for covering multiple angles). Use for fresh information, current events, library/API docs, or anything not in local files. Cite the returned source numbers inline. This is the Perplexity-backed stand-in for the `web_search` tool that pi-subagents (researcher, context-builder) expect from pi-web-access.",
		promptSnippet: "Web search (Perplexity) — `queries` array supported",
		promptGuidelines: [
			"Pass 2-4 distinct angles via `queries` rather than one generic query.",
			"Cite the returned source numbers inline. Returns synthesized answers, not raw result snippets.",
		],
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal) {
			const queries = normalizeWebQueries(params.query, params.queries);
			if (!queries.length) {
				return {
					content: [{ type: "text", text: "web_search: provide a `query` or `queries`." }],
					details: {
						model: DEFAULT_SEARCH_MODEL,
						queries,
						results: [] as WebSearchEntry[],
						sources: [] as PerplexitySource[],
					},
				};
			}
			const includeContent = params.includeContent !== false;
			const results = await Promise.all(
				queries.map(async (q) => {
					const messages = buildWebSearchMessages(q, {
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						numResults: params.numResults,
						includeContent,
					});
					const result = await searchPerplexity(messages, DEFAULT_SEARCH_MODEL, { signal });
					return { query: q, ...result };
				}),
			);
			const text = formatWebSearchResults(results, includeContent);
			return {
				content: [{ type: "text", text: truncateToolOutput(text) }],
				details: {
					model: DEFAULT_SEARCH_MODEL,
					queries,
					results,
					sources: results.flatMap((r) => r.citations),
				},
			};
		},
		renderCall(args, theme) {
			const queries = normalizeWebQueries(
				args.query as string | undefined,
				args.queries as string[] | undefined,
			);
			const first = queries[0] ?? "";
			const preview = first.length > 60 ? `${first.slice(0, 60)}…` : first;
			const more = queries.length > 1 ? ` +${queries.length - 1}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) +
					theme.fg("muted", `[${DEFAULT_SEARCH_MODEL}] `) +
					theme.fg("dim", preview + more),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			if (expanded) return new Markdown(text, 0, 0, getMarkdownTheme());
			const firstLine = text.split("\n")[0] ?? text;
			const sources = result.details?.sources as PerplexitySource[] | undefined;
			const srcCount = sources ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : "";
			return new Text(theme.fg("toolOutput", firstLine.slice(0, 200)) + theme.fg("dim", srcCount), 0, 0);
		},
	});

	const FetchContentParams = Type.Object({
		url: Type.String({
			description: "URL to read (http/https/GitHub/PDF). Perplexity fetches and synthesizes the page.",
		}),
		prompt: Type.Optional(
			Type.String({ description: "Instruction for what to extract or answer about the page." }),
		),
		maxTokens: Type.Optional(
			Type.Number({ description: "Cap on returned content length." }),
		),
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Read a URL and return its content as a synthesized summary. Backed by Perplexity (sonar fetches the page and answers about it). Use for docs, articles, or any URL with content the task needs.",
		promptSnippet: "Fetch + summarize a URL (Perplexity)",
		parameters: FetchContentParams,
		async execute(_toolCallId, params, signal) {
			const messages = buildFetchContentMessages(params.url, params.prompt);
			const result = await searchPerplexity(messages, DEFAULT_SEARCH_MODEL, {
				signal,
			maxTokens: params.maxTokens,
			});
			const text = result.content.trim() + formatSources(result.citations);
			return {
				content: [{ type: "text", text: truncateToolOutput(text) }],
				details: { url: params.url, sources: result.citations, model: DEFAULT_SEARCH_MODEL },
			};
		},
		renderCall(args, theme) {
			const url = String(args.url ?? "");
			const preview = url.length > 60 ? `${url.slice(0, 60)}…` : url;
			return new Text(theme.fg("toolTitle", theme.bold("fetch_content ")) + theme.fg("dim", preview), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			if (expanded) return new Markdown(text, 0, 0, getMarkdownTheme());
			return new Text(theme.fg("toolOutput", (text.split("\n")[0] ?? text).slice(0, 200)), 0, 0);
		},
	});

	const GetSearchContentParams = Type.Object({
		query: Type.Optional(Type.String({ description: "Search query." })),
		queries: Type.Optional(
			Type.Array(Type.String(), { description: "Batch of queries." }),
		),
		prompt: Type.Optional(
			Type.String({ description: "What to extract or answer from the top results." }),
		),
		maxTokens: Type.Optional(
			Type.Number({ description: "Cap on returned content length." }),
		),
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description:
			"Search the web and retrieve synthesized content in one step. Backed by Perplexity: runs the query, reads the top result pages, and synthesizes a thorough answer drawing on their content. Use when you want the answer and source content together.",
		promptSnippet: "Search + synthesize content (Perplexity)",
		parameters: GetSearchContentParams,
		async execute(_toolCallId, params, signal) {
			const queries = normalizeWebQueries(params.query, params.queries);
			if (!queries.length) {
				return {
					content: [{ type: "text", text: "get_search_content: provide a `query` or `queries`." }],
					details: {
						model: DEFAULT_SEARCH_MODEL,
						queries,
						results: [] as WebSearchEntry[],
						sources: [] as PerplexitySource[],
					},
				};
			}
			const results = await Promise.all(
				queries.map(async (q) => {
					const system = params.prompt
						? `You are a web research assistant. Search the web for the topic, read the most relevant pages, and answer the user's instruction using that content. Cite sources.\n\nInstruction: ${params.prompt}`
						: "You are a web research assistant. Search the web, read the most relevant pages, and synthesize a thorough answer drawing on their content. Cite sources.";
					const result = await searchPerplexity(
						[{ role: "system", content: system }, { role: "user", content: q }],
						DEFAULT_SEARCH_MODEL,
						{ signal, maxTokens: params.maxTokens },
					);
					return { query: q, ...result };
				}),
			);
			const text = formatWebSearchResults(results, true);
			return {
				content: [{ type: "text", text: truncateToolOutput(text) }],
				details: {
					model: DEFAULT_SEARCH_MODEL,
					queries,
					results,
					sources: results.flatMap((r) => r.citations),
				},
			};
		},
		renderCall(args, theme) {
			const queries = normalizeWebQueries(
				args.query as string | undefined,
				args.queries as string[] | undefined,
			);
			const first = queries[0] ?? "";
			const preview = first.length > 60 ? `${first.slice(0, 60)}…` : first;
			return new Text(
				theme.fg("toolTitle", theme.bold("get_search_content ")) + theme.fg("dim", preview),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			if (expanded) return new Markdown(text, 0, 0, getMarkdownTheme());
			return new Text(theme.fg("toolOutput", (text.split("\n")[0] ?? text).slice(0, 200)), 0, 0);
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
