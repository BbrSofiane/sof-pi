/**
 * Perplexity API client.
 *
 * Perplexity exposes an OpenAI-compatible chat completions endpoint at
 * https://api.perplexity.ai/chat/completions. Each response carries a
 * top-level `citations` array (URLs) and optionally `search_results`
 * ({ title, url, date }) with richer metadata.
 *
 * Pro plan models: sonar, sonar-pro (default), sonar-reasoning,
 * sonar-reasoning-pro, sonar-deep-research.
 */

const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";

export interface PerplexitySource {
	title: string;
	url: string;
}

export interface PerplexityMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface PerplexityResult {
	content: string;
	citations: PerplexitySource[];
}

export interface PerplexityModelInfo {
	id: string;
	label: string;
	deepResearch: boolean;
}

/**
 * Models offered on the Perplexity Pro plan. `deepResearch` models are slow
 * (1-3 min) but produce long, heavily-cited syntheses.
 */
export const PERPLEXITY_MODELS: PerplexityModelInfo[] = [
	{ id: "sonar", label: "sonar", deepResearch: false },
	{ id: "sonar-pro", label: "sonar-pro", deepResearch: false },
	{ id: "sonar-reasoning", label: "sonar-reasoning", deepResearch: false },
	{ id: "sonar-reasoning-pro", label: "sonar-reasoning-pro", deepResearch: false },
	{ id: "sonar-deep-research", label: "sonar-deep-research", deepResearch: true },
];

export function getPerplexityApiKey(): string {
	const key = process.env.PERPLEXITY_API_KEY;
	if (!key) {
		throw new Error(
			"PERPLEXITY_API_KEY is not set. Add it to your environment (e.g. shell rc or .env).",
		);
	}
	return key;
}

function mergeSources(
	citations: unknown,
	searchResults: unknown,
): PerplexitySource[] {
	const byUrl = new Map<string, PerplexitySource>();

	if (Array.isArray(searchResults)) {
		for (const r of searchResults) {
			if (r && typeof r === "object") {
				const url = String((r as { url?: unknown }).url ?? "").trim();
				if (!url) continue;
				const title = String((r as { title?: unknown }).title ?? url);
				byUrl.set(url, { title: title || url, url });
			}
		}
	}

	if (Array.isArray(citations)) {
		for (const c of citations) {
			if (typeof c === "string") {
				const url = c.trim();
				if (url && !byUrl.has(url)) byUrl.set(url, { title: url, url });
			} else if (c && typeof c === "object") {
				const url = String((c as { url?: unknown }).url ?? "").trim();
				if (!url) continue;
				const title = String((c as { title?: unknown }).title ?? url);
				if (!byUrl.has(url)) byUrl.set(url, { title: title || url, url });
			}
		}
	}

	return Array.from(byUrl.values());
}

interface ChatCompletionChunk {
	choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string } }>;
	citations?: unknown;
	search_results?: unknown;
}

/**
 * Non-streaming search. Used by the `perplexity_search` tool.
 */
export async function searchPerplexity(
	messages: PerplexityMessage[],
	model: string,
	options: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<PerplexityResult> {
	const apiKey = getPerplexityApiKey();
	const res = await fetch(PERPLEXITY_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			model,
			messages,
			stream: false,
			...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
		}),
		signal: options.signal,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Perplexity API ${res.status}: ${text || res.statusText}`);
	}

	const data = (await res.json()) as ChatCompletionChunk;
	const content = data.choices?.[0]?.message?.content ?? "";
	return { content, citations: mergeSources(data.citations, data.search_results) };
}

export interface StreamCallbacks {
	onDelta?: (chunk: string) => void;
	onCitations?: (sources: PerplexitySource[]) => void;
}

/**
 * Streaming search. Calls `onDelta` for each content chunk as it arrives and
 * `onCitations` whenever the API publishes sources. Returns the final result.
 */
export async function streamPerplexity(
	messages: PerplexityMessage[],
	model: string,
	options: { signal?: AbortSignal; maxTokens?: number } & StreamCallbacks = {},
): Promise<PerplexityResult> {
	const apiKey = getPerplexityApiKey();
	const res = await fetch(PERPLEXITY_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify({
			model,
			messages,
			stream: true,
			...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
		}),
		signal: options.signal,
	});

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw new Error(`Perplexity API ${res.status}: ${text || res.statusText}`);
	}

	let content = "";
	let citations: PerplexitySource[] = [];
	let emittedCitations = false;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const emitCitations = (sources: PerplexitySource[]) => {
		if (sources.length === 0) return;
		citations = sources;
		if (!emittedCitations) {
			options.onCitations?.(sources);
			emittedCitations = true;
		} else {
			options.onCitations?.(sources);
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line || !line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") continue;
			try {
				const chunk = JSON.parse(payload) as ChatCompletionChunk;
				const delta = chunk.choices?.[0]?.delta?.content;
				if (delta) {
					content += delta;
					options.onDelta?.(delta);
				}
				if (chunk.citations || chunk.search_results) {
					emitCitations(mergeSources(chunk.citations, chunk.search_results));
				}
			} catch {
				// ignore malformed keepalive / partial lines
			}
		}
	}

	return { content, citations };
}
