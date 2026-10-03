/** Bounded first-party Search + fast Agent API adapters. No retries or legacy fallback. */
import { unresolvedCitationMarkers, type CitationSource } from "./citations.ts";
import { SseFramer } from "./sse-framer.ts";

export type PerplexitySource = CitationSource;
export interface PerplexityMessage { role: "system" | "user" | "assistant"; content: string }
export interface PerplexityResult {
	responseId: string; content: string; citations: PerplexitySource[];
	unresolvedCitations: string[]; usage?: unknown;
}
export interface DiscoveryResult {
	requestId?: string;
	results: Array<PerplexitySource & { snippet: string; date?: string; lastUpdated?: string }>;
	usage?: unknown;
}
export interface DiscoveryOptions {
	signal?: AbortSignal; numResults?: number; recencyFilter?: "hour" | "day" | "week" | "month" | "year";
	domainFilter?: string[];
}
export interface ResearchOptions { signal?: AbortSignal; maxTokens?: number; preset?: "fast" }
export interface StreamCallbacks {
	onDelta?: (chunk: string) => void;
	onCitations?: (sources: PerplexitySource[]) => void;
}
export const PROVIDER_LIMITS = Object.freeze({
	searchDeadlineMs: 30_000, researchDeadlineMs: 90_000,
	maxBodyBytes: 2 * 1024 * 1024, maxStreamBytes: 8 * 1024 * 1024,
	maxRequestBytes: 256 * 1024,
});

export function getPerplexityApiKey(): string {
	const key = process.env.PERPLEXITY_API_KEY;
	if (!key?.trim()) throw new Error("PERPLEXITY_API_KEY is not set.");
	return key;
}

function invalid(): never { throw new Error("Invalid Perplexity response schema"); }
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function string(value: unknown, nonempty = false): string {
	if (typeof value !== "string" || (nonempty && !value.trim())) invalid();
	return value;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function sourceUrl(value: unknown): string {
	const text = string(value, true);
	try {
		const url = new URL(text);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid();
	} catch { invalid(); }
	return text;
}
function optionalDate(value: unknown): string | undefined {
	return value == null ? undefined : string(value);
}
function integer(value: unknown, max: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
		throw new Error(`${label} must be an integer from 1 to ${max}`);
	}
	return value as number;
}
function optionsOnly(options: object, keys: string[]): void {
	if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !keys.includes(key))) {
		throw requestError("invalid-request", "Unsupported Perplexity option");
	}
}

function domainFilters(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 20) throw new Error("domainFilter must contain at most 20 filters");
	const filters = value.map((filter) => {
		if (typeof filter !== "string" || !filter || filter.length > 253 || /[\s?#@\\:]/.test(filter)) {
			throw new Error("Invalid domainFilter format (use a domain, TLD, or domain/path without protocol)");
		}
		const host = filter.replace(/^-/, "").split("/")[0];
		if (!/^(?:\.[a-z]{2,}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i.test(host)) {
			throw new Error("Invalid domainFilter hostname");
		}
		return filter;
	});
	if (filters.some((f) => f.startsWith("-")) && filters.some((f) => !f.startsWith("-"))) {
		throw new Error("domainFilter cannot mix allowlist and denylist modes");
	}
	return filters;
}

export type RequestErrorCode = "request-size-limit" | "message-limit" | "invalid-request";
export type RequestValidationError = Error & { code: RequestErrorCode };
function requestError(code: RequestErrorCode, message: string): RequestValidationError {
	return Object.assign(new Error(message), { code });
}

function agentBody(messages: PerplexityMessage[], options: ResearchOptions, stream: boolean): object {
	try {
		optionsOnly(options, ["signal", "maxTokens", "preset", "onDelta", "onCitations"]);
		if (options.preset !== undefined && options.preset !== "fast") throw requestError("invalid-request", "Only the fast preset is supported");
		if (!Array.isArray(messages) || !messages.length || messages.length > 128 || messages.some((m) =>
			!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim())) {
			throw requestError("message-limit", "messages must contain 1–128 nonempty system/user/assistant text turns");
		}
		return {
			preset: "fast", input: messages.map(({ role, content }) => ({ type: "message", role, content })),
			stream, store: false, max_steps: 1,
			max_output_tokens: integer(options.maxTokens ?? 1200, 8192, "maxTokens"),
			tools: [{ type: "web_search", max_results: 5 }],
		};
	} catch (error) {
		if (error instanceof Error && (error as Partial<RequestValidationError>).code !== undefined) throw error;
		throw requestError("invalid-request", error instanceof Error ? error.message : String(error));
	}
}

/** Single shared request-size check so preflight and real transport cannot drift. */
function encodedRequest(body: object): string {
	const encoded = JSON.stringify(body);
	if (Buffer.byteLength(encoded) > PROVIDER_LIMITS.maxRequestBytes) {
		throw requestError("request-size-limit", "Perplexity request exceeds 256 KiB limit");
	}
	return encoded;
}

/**
 * Exact pure preflight for research/stream requests: the same agentBody envelope and
 * encoded request-size validation the real transport applies, with no network or key
 * access. Throws with a stable `code` of "request-size-limit", "message-limit", or
 * "invalid-request" and the same actionable message as the transport path.
 */
export function preflightResearchRequest(messages: PerplexityMessage[], options: ResearchOptions = {}, stream: boolean = true): void {
	encodedRequest(agentBody(messages, options, stream));
}

function parseSources(value: unknown): PerplexitySource[] {
	const sources = array(value).map((raw) => {
		const source = object(raw);
		if (!Number.isSafeInteger(source.id) || (source.id as number) < 1) invalid();
		string(source.snippet);
		if (source.source !== undefined && source.source !== "web") invalid();
		optionalDate(source.date); optionalDate(source.last_updated);
		return { id: String(source.id), title: string(source.title), url: sourceUrl(source.url) };
	});
	// Validate duplicate IDs even if the answer contains no markers.
	unresolvedCitationMarkers("", sources);
	return [...new Map(sources.map((s) => [s.id, s])).values()];
}

export function normalizeAgentResponse(raw: unknown): PerplexityResult {
	const data = object(raw);
	const responseId = string(data.id, true);
	if (data.object !== "response" || !Number.isSafeInteger(data.created_at)) invalid();
	string(data.model, true);
	if (!["completed", "failed", "incomplete", "in_progress", "queued", "cancelled"].includes(String(data.status))) invalid();
	if (data.status !== "completed") throw new Error(`Perplexity research did not complete (${data.status})`);
	if (data.error != null) throw new Error("Perplexity research returned an error");
	const texts: string[] = [];
	const sources: PerplexitySource[] = [];
	for (const rawItem of array(data.output)) {
		const item = object(rawItem);
		if (item.type === "message") {
			string(item.id, true);
			if (item.role !== "assistant" || item.status !== "completed") invalid();
			for (const rawPart of array(item.content)) {
				const part = object(rawPart);
				if (part.type !== "output_text") invalid();
				texts.push(string(part.text));
			}
		} else if (item.type === "search_results") sources.push(...parseSources(item.results));
		else invalid(); // fast v1 has no sandbox, finance, people, MCP, or function tools.
	}
	const content = texts.join("");
	if (!content.trim()) throw new Error("Invalid Perplexity response: empty research answer");
	const unresolvedCitations = unresolvedCitationMarkers(content, sources);
	const citations = [...new Map(sources.map((s) => [s.id, s])).values()];
	return { responseId, content, citations, unresolvedCitations, ...(data.usage !== undefined ? { usage: data.usage } : {}) };
}

/** Injectable transport is instance-local: fixtures never inspect environment credentials. */
export interface PerplexityTransport {
	fetch: typeof globalThis.fetch;
	apiKey?: () => string;
	/** Optional shorter budgets, principally for deterministic fixture tests. */
	deadlineMs?: number;
	maxBodyBytes?: number;
}

function abortError(): DOMException { return new DOMException("Perplexity request cancelled", "AbortError"); }
async function withTransport<T>(deps: PerplexityTransport, endpoint: string, body: object,
	signal: AbortSignal | undefined, deadlineMs: number, stream: boolean,
	consume: (response: Response, signal: AbortSignal, wait: <R>(promise: Promise<R>) => Promise<R>, deadline: number) => Promise<T>,
): Promise<T> {
	const encoded = encodedRequest(body);
	if (signal?.aborted) throw abortError();
	const controller = new AbortController();
	let timeout = false;
	const abort = () => controller.abort(abortError());
	signal?.addEventListener("abort", abort, { once: true });
	// One absolute monotonic deadline shared by the timeout timer and the
	// consuming loops: a consume that finishes after the deadline can never
	// report success even when reads never yield to fire the timer.
	const budgetMs = Math.min(deps.deadlineMs ?? deadlineMs, deadlineMs);
	const deadline = performance.now() + budgetMs;
	const timer = setTimeout(() => { timeout = true; controller.abort(new Error("Perplexity request deadline exceeded")); }, budgetMs);
	const wait = async <R>(promise: Promise<R>): Promise<R> => {
		controller.signal.throwIfAborted();
		let rejectAbort: () => void = () => {};
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		try { return await Promise.race([promise, cancellation]); }
		finally { controller.signal.removeEventListener("abort", rejectAbort); }
	};
	try {
		let res: Response;
		try {
			res = await wait(deps.fetch(endpoint, {
				method: "POST", redirect: "error",
				headers: { Authorization: `Bearer ${(deps.apiKey ?? getPerplexityApiKey)()}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" },
				body: encoded, signal: controller.signal,
			}));
		} catch {
			if (controller.signal.aborted) throw controller.signal.reason;
			// Never echo raw network errors, request input, headers, or upstream error bodies.
			throw new Error("Perplexity transport failed (check API key and network)");
		}
		if (!res.ok) {
			void res.body?.cancel().catch(() => {});
			throw new Error(`Perplexity API HTTP ${res.status} (upstream diagnostic omitted)`);
		}
		const mime = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
		if (mime !== (stream ? "text/event-stream" : "application/json")) {
			void res.body?.cancel().catch(() => {});
			throw new Error("Invalid Perplexity response content type");
		}
		return await consume(res, controller.signal, wait, deadline);
	} catch (error) {
		if (signal?.aborted) throw abortError();
		if (timeout) throw new Error("Perplexity request deadline exceeded");
		throw error;
	} finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, wait: <R>(p: Promise<R>) => Promise<R>) {
	try { return await wait(reader.read()); }
	catch { throw new Error("Perplexity response transport interrupted"); }
}

async function readJson(res: Response, maxBytes: number, wait: <R>(p: Promise<R>) => Promise<R>): Promise<unknown> {
	if (!res.body) invalid();
	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "", bytes = 0;
	try {
		for (;;) {
			const chunk = await readChunk(reader, wait);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new Error("Perplexity response body limit exceeded");
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		try { return JSON.parse(text); } catch { invalid(); }
	} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createPerplexityClient(deps: PerplexityTransport) {
	for (const value of [deps.deadlineMs, deps.maxBodyBytes]) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid transport budget");
	}
	const maxBody = Math.min(deps.maxBodyBytes ?? PROVIDER_LIMITS.maxBodyBytes, PROVIDER_LIMITS.maxBodyBytes);
	return {
		async discoverPerplexity(query: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
			optionsOnly(options, ["signal", "numResults", "recencyFilter", "domainFilter"]);
			if (typeof query !== "string" || !query.trim() || query.length > 16_384) throw new Error("query must be nonempty and at most 16384 characters");
			const count = integer(options.numResults ?? 5, 20, "numResults");
			if (options.recencyFilter !== undefined && !["hour", "day", "week", "month", "year"].includes(options.recencyFilter)) throw new Error("Unsupported recencyFilter");
			const domains = options.domainFilter === undefined ? undefined : domainFilters(options.domainFilter);
			const body = { query, max_results: count,
				...(options.recencyFilter ? { search_recency_filter: options.recencyFilter } : {}),
				...(domains ? { search_domain_filter: domains } : {}) };
			return withTransport(deps, "https://api.perplexity.ai/search", body, options.signal, PROVIDER_LIMITS.searchDeadlineMs, false, async (res, _signal, wait) => {
				const data = object(await readJson(res, maxBody, wait));
				const requestId = string(data.id, true);
				const results = array(data.results).map((raw, index) => {
					const item = object(raw);
					const date = optionalDate(item.date), lastUpdated = optionalDate(item.last_updated);
					return { id: `result-${index + 1}`, title: string(item.title), url: sourceUrl(item.url), snippet: string(item.snippet),
						...(date !== undefined ? { date } : {}), ...(lastUpdated !== undefined ? { lastUpdated } : {}) };
				});
				if (results.length > count) invalid();
				return { requestId, results, ...(data.usage !== undefined ? { usage: data.usage } : {}) };
			});
		},
		async researchPerplexity(messages: PerplexityMessage[], options: ResearchOptions = {}): Promise<PerplexityResult> {
			optionsOnly(options, ["signal", "maxTokens", "preset"]);
			return withTransport(deps, "https://api.perplexity.ai/v1/agent", agentBody(messages, options, false), options.signal,
				PROVIDER_LIMITS.researchDeadlineMs, false, async (res, _signal, wait) => normalizeAgentResponse(await readJson(res, maxBody, wait)));
		},
		async streamPerplexity(messages: PerplexityMessage[], options: ResearchOptions & StreamCallbacks = {}): Promise<PerplexityResult> {
			return withTransport(deps, "https://api.perplexity.ai/v1/agent", agentBody(messages, options, true), options.signal,
				PROVIDER_LIMITS.researchDeadlineMs, true, async (res, signal, wait, deadline) => {
					if (!res.body) invalid();
					const reader = res.body.getReader();
					let result: PerplexityResult | undefined;
					const observedSources = new Map<string, PerplexitySource>();
					const publishSources = (sources: PerplexitySource[], final = false) => {
						for (const source of sources) {
							const previous = observedSources.get(source.id);
							if (previous && (previous.url !== source.url || previous.title !== source.title)) {
								throw new Error("Invalid Perplexity stream: conflicting source ID");
							}
							observedSources.set(source.id, source);
						}
						options.onCitations?.(final ? sources : [...observedSources.values()]);
					};
					const dispatch = (frame: string) => {
						if (Buffer.byteLength(frame) > maxBody) throw new Error("Perplexity SSE frame limit exceeded");
						const payload = frame.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
						if (!payload || payload === "[DONE]") return;
						let raw: unknown;
						try { raw = JSON.parse(payload); } catch { throw new Error("Invalid Perplexity SSE JSON"); }
						const event = object(raw);
						const type = string(event.type, true);
						if (!Number.isSafeInteger(event.sequence_number) || (event.sequence_number as number) < 0) invalid();
						if (type === "response.output_text.delta" || type === "response.output_text.done") {
							string(event.item_id, true);
							for (const key of ["output_index", "content_index"]) {
								if (!Number.isSafeInteger(event[key]) || (event[key] as number) < 0) invalid();
							}
							if (type.endsWith(".done")) string(event.text);
						}
						if (type === "response.output_text.delta") options.onDelta?.(string(event.delta));
						else if (type === "response.reasoning.search_results") publishSources(parseSources(event.results));
						else if (type === "response.output_item.done" || type === "response.output_item.added") {
							if (!Number.isSafeInteger(event.output_index) || (event.output_index as number) < 0) invalid();
							const item = object(event.item);
							if (item.type === "search_results") publishSources(parseSources(item.results));
						} else if (type === "response.completed") {
							result = normalizeAgentResponse(event.response);
							publishSources(result.citations, true);
						} else if (["response.failed", "response.incomplete", "response.cancelled", "error"].includes(type)) {
							throw new Error("Perplexity streaming research did not complete");
						} else if (!["response.created", "response.in_progress", "response.output_text.done", "response.reasoning.started", "response.reasoning.search_queries", "response.reasoning.stopped"].includes(type)) invalid();
					};
					// Early-stop policy: the FIRST valid authoritative response.completed ends
					// stream dispatch regardless of chunk framing. Framing runs over RAW received
					// bytes (SseFramer) with a resumed scan, so a fatal UTF-8 error or body-limit
					// excess in a trailing tail can never change the outcome of identical bytes
					// cut differently. Fatal UTF-8 decoding and the byte/frame limits apply only
					// to the processed prefix through the terminal delimiter: trailing bytes after
					// that delimiter are never scanned, decoded, or charged to any budget, and the
					// reader is cancelled and released. The framer retains only the in-progress
					// frame in amortized-linear storage; the pending frame cap excludes just the
					// trailing partial delimiter prefix, and dispatch/EOF enforce the exact cap.
					const framer = new SseFramer(maxBody, PROVIDER_LIMITS.maxStreamBytes);
					const decodeFrame = (frame: Uint8Array) => dispatch(new TextDecoder("utf-8", { fatal: true }).decode(frame));
					const deadlineCheck = () => { if (performance.now() >= deadline) throw new Error("Perplexity request deadline exceeded"); };
					// setImmediate yields let deadline/abort timers fire even when the reader
					// serves immediately-ready fragments in a promise-microtask loop.
					const yieldToEventLoop = () => new Promise<void>((resolve) => { setImmediate(resolve); });
					try {
						let reads = 0, sinceYield = 0;
						for (;;) {
							signal.throwIfAborted();
							deadlineCheck();
							const chunk = await readChunk(reader, wait);
							if (chunk.done) break;
							sinceYield += chunk.value.byteLength;
							framer.feed(chunk.value, (frame) => { decodeFrame(frame); return result !== undefined; });
							if (result) { signal.throwIfAborted(); deadlineCheck(); return result; }
							// Yield during sustained immediately-ready reads so timers cannot starve.
							if (++reads % 64 === 0 || sinceYield >= 262_144) { sinceYield = 0; await yieldToEventLoop(); }
						}
						// Final flush with no terminal delimiter: the remaining in-progress frame is
						// already charged, fatally decoded (incomplete UTF-8 fails) and dispatched
						// once, with the exact frame cap enforced.
						framer.flush((frame) => { decodeFrame(frame); return result !== undefined; });
						signal.throwIfAborted();
						deadlineCheck();
						if (!result) throw new Error("Perplexity stream ended without completed response");
						return result;
					} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
				});
		},
	};
}

// Resolve global fetch lazily, not at extension load time. No credential access until a call.
const client = createPerplexityClient({ fetch: (input, init) => globalThis.fetch(input, init) });
export const discoverPerplexity = client.discoverPerplexity;
export const researchPerplexity = client.researchPerplexity;
export const streamPerplexity = client.streamPerplexity;
