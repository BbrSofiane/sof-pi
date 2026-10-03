import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerplexityClient, normalizeAgentResponse, preflightResearchRequest, PROVIDER_LIMITS } from "../../extensions/perplexity/perplexity.ts";

const messages = [{ role: "user" as const, content: "fixture query" }];
const page = { title: "A", url: "https://example.com/a", snippet: "provider excerpt", date: null, last_updated: "2026-01-01" };
const answer = {
	id: "response-fixture", object: "response", created_at: 123, model: "fixture-model", status: "completed",
	output: [{ type: "search_results", results: [{ ...page, id: 7 }] },
		{ type: "message", id: "msg-1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Claim[7]." }] }],
	usage: { total_tokens: 20, cost: { total_cost: 0.01 } },
};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const fixture = (data: unknown, extra = {}) => createPerplexityClient({ fetch: async () => json(data), apiKey: () => "fixture-not-a-credential", ...extra });

test("Search uses native count, recency and domain/path filters; preserves metadata", async () => {
	let request: RequestInit | undefined, endpoint: unknown;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async (url, init) => {
		endpoint = url; request = init; return json({ id: "search-fixture", results: [page], usage: { credits: 1 } });
	} });
	const result = await client.discoverPerplexity("topic", { numResults: 3, recencyFilter: "month", domainFilter: ["example.com/docs", ".gov"] });
	assert.equal(endpoint, "https://api.perplexity.ai/search");
	assert.deepEqual(JSON.parse(request!.body as string), { query: "topic", max_results: 3, search_recency_filter: "month", search_domain_filter: ["example.com/docs", ".gov"] });
	assert.equal(request!.redirect, "error");
	assert.equal(result.results[0].lastUpdated, "2026-01-01");
	assert.equal(result.results[0].date, undefined);
	assert.equal(result.results[0].id, "result-1");
	assert.deepEqual(result.usage, { credits: 1 });
});

test("Search maps documented hour recency natively", async () => {
	let sent: any;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async (_url, init) => {
		sent = JSON.parse(init!.body as string); return json({ id: "hour", results: [] });
	} });
	await client.discoverPerplexity("topic", { recencyFilter: "hour" });
	assert.equal(sent.search_recency_filter, "hour");
});

test("invalid request options reject before fetch OR key lookup", async () => {
	let calls = 0;
	const client = createPerplexityClient({ apiKey: () => { calls++; throw Error("must not run"); }, fetch: async () => { calls++; return json({}); } });
	for (const options of [{ numResults: 0 }, { numResults: 21 }, { numResults: 1.5 }, { recencyFilter: "minute" },
		{ domainFilter: ["example.com", "-other.com"] }, { domainFilter: ["https://example.com"] }, { domainFilter: Array(21).fill("example.com") },
		{ domainFilter: ["user@example.com"] }, { domainFilter: ["example.com?token=secret"] }, { surprise: true }]) {
		await assert.rejects(client.discoverPerplexity("topic", options as any));
	}
	await assert.rejects(client.discoverPerplexity(" "));
	await assert.rejects(client.researchPerplexity(messages, { preset: "high" } as any), /Only the fast/);
	await assert.rejects(client.researchPerplexity(messages, { maxTokens: 8193 }));
	await assert.rejects(client.researchPerplexity([{ role: "developer", content: "x" }] as any));
	await assert.rejects(client.researchPerplexity([{ role: "user", content: "x".repeat(PROVIDER_LIMITS.maxRequestBytes) }]), /request exceeds/);
	assert.equal(calls, 0);
});

test("preflightResearchRequest shares the exact transport request validation, with typed codes and no network or key access", async () => {
	assert.equal(preflightResearchRequest(messages), undefined);
	assert.equal(preflightResearchRequest(messages, { maxTokens: 800 }), undefined);
	assert.equal(preflightResearchRequest(messages, { preset: "fast" }, false), undefined);
	let calls = 0;
	const client = createPerplexityClient({ apiKey: () => { calls++; return "fixture"; }, fetch: async () => { calls++; return json(answer); } });
	// Each entry is the exact argument list passed to both preflight and transport.
	const cases: Array<[unknown[], RegExp, string]> = [
		[[[{ role: "developer", content: "x" }]], /messages must contain 1–128/, "message-limit"],
		[[], /messages must contain 1–128/, "message-limit"],
		[[Array(129).fill(messages[0])], /messages must contain 1–128/, "message-limit"],
		[[[{ role: "user", content: "x".repeat(PROVIDER_LIMITS.maxRequestBytes) }]], /request exceeds 256 KiB/, "request-size-limit"],
		[[messages, { maxTokens: 8193 }], /maxTokens must be an integer from 1 to 8192/, "invalid-request"],
		[[messages, { preset: "high" }], /Only the fast preset is supported/, "invalid-request"],
		[[messages, { surprise: true }], /Unsupported Perplexity option/, "invalid-request"],
	];
	const typed = (error: any) => typeof error.code === "string";
	for (const [args, pattern, code] of cases) {
		const check = (error: any) => typed(error) && error.code === code && pattern.test(error.message);
		assert.throws(() => (preflightResearchRequest as (...a: unknown[]) => void)(...args), check);
		await assert.rejects((client.researchPerplexity as (...a: unknown[]) => Promise<unknown>)(...args), check);
	}
	const tokens = (error: any) => typed(error) && error.code === "invalid-request" && /maxTokens must be an integer from 1 to 8192/.test(error.message);
	// The streaming transport shares the same underlying size/message gates too.
	await assert.rejects(client.streamPerplexity(messages, { maxTokens: 8193 }), tokens);
	await assert.rejects(client.streamPerplexity([{ role: "user", content: "x".repeat(PROVIDER_LIMITS.maxRequestBytes) }]), (error: any) => error.code === "request-size-limit");
	assert.equal(calls, 0); // every gate rejects before fetch or key lookup, exactly like preflight
	// A preflight-passing request proceeds on the real transport (no drift, no skip).
	const result = await client.researchPerplexity(messages);
	assert.equal(result.responseId, "response-fixture");
	assert.ok(calls >= 2);
});

test("denylist is native, and valid empty Search is different from malformed envelope", async () => {
	let sent: any;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async (_url, init) => {
		sent = JSON.parse(init!.body as string); return json({ id: "empty", results: [] });
	} });
	assert.deepEqual((await client.discoverPerplexity("topic", { domainFilter: ["-example.com"] })).results, []);
	assert.deepEqual(sent.search_domain_filter, ["-example.com"]);
	for (const data of [{}, { id: "s", results: {} }, { results: [] }, { id: "s", results: [{ ...page, snippet: 7 }] },
		{ id: "s", results: [{ ...page, url: "file:///secret" }] }, { id: "s", results: [{ ...page, date: 7 }] }]) {
		await assert.rejects(fixture(data).discoverPerplexity("topic"), /Invalid Perplexity/);
	}
});

test("Agent request only selects fast, text message input and bounded web search", async () => {
	let sent: any;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async (url, init) => {
		assert.equal(url, "https://api.perplexity.ai/v1/agent"); sent = JSON.parse(init!.body as string); return json(answer);
	} });
	const result = await client.researchPerplexity([{ role: "system", content: "guidance" }, ...messages], { maxTokens: 800 });
	assert.deepEqual(sent, { preset: "fast", input: [{ type: "message", role: "system", content: "guidance" }, { type: "message", role: "user", content: "fixture query" }], stream: false, store: false, max_steps: 1, max_output_tokens: 800, tools: [{ type: "web_search", max_results: 5 }] });
	assert.equal(result.responseId, "response-fixture");
	assert.equal(result.content, "Claim[7].");
	assert.deepEqual(result.citations, [{ id: "7", title: "A", url: page.url }]);
	assert.deepEqual(result.usage, answer.usage);
});

test("strict Agent envelope rejects empty, malformed, incompatible output and non-completed states", () => {
	for (const data of [{}, { ...answer, output: [] }, { ...answer, id: "" }, { ...answer, object: "chat.completion" },
		{ ...answer, output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }] },
		{ ...answer, output: [{ type: "sandbox_results", status: "completed" }] },
		{ ...answer, error: { message: "secret" } }, { ...answer, output: [{ type: "search_results", results: [{ ...page }] }] }]) {
		assert.throws(() => normalizeAgentResponse(data), /Invalid Perplexity|returned an error/);
	}
	for (const status of ["failed", "incomplete", "queued", "in_progress", "cancelled"]) {
		assert.throws(() => normalizeAgentResponse({ ...answer, status }), /did not complete/);
	}
});

test("transport never exposes HTTP body, status text or raw network diagnostics, never falls back", async () => {
	let calls = 0;
	const client = createPerplexityClient({ apiKey: () => "secret-fixture", fetch: async () => {
		calls++; return new Response("Bearer secret-fixture token=private", { status: 401, statusText: "secret-fixture" });
	} });
	await assert.rejects(client.researchPerplexity(messages), (error: Error) => /HTTP 401/.test(error.message) && !/secret-fixture|private/.test(error.message));
	assert.equal(calls, 1);
	await assert.rejects(createPerplexityClient({ apiKey: () => "fixture", fetch: async () => { throw Error("https://secret?key=secret-fixture"); } }).discoverPerplexity("x"), /^Error: Perplexity transport failed/);
});

test("deadlines cover fetch and body reads; caller abort stays AbortError", async () => {
	const pending = new Promise<Response>(() => {});
	await assert.rejects(createPerplexityClient({ apiKey: () => "fixture", fetch: async () => pending, deadlineMs: 5 }).discoverPerplexity("x"), /deadline exceeded/);
	const client = createPerplexityClient({ apiKey: () => "fixture", deadlineMs: 5, fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }) });
	await assert.rejects(client.discoverPerplexity("x"), /deadline exceeded/);
	const controller = new AbortController(); controller.abort(new Error("secret cancellation reason"));
	await assert.rejects(fixture({}).discoverPerplexity("x", { signal: controller.signal }), { name: "AbortError" });
	const during = new AbortController();
	const running = createPerplexityClient({ apiKey: () => "fixture", fetch: async () => pending }).discoverPerplexity("x", { signal: during.signal });
	during.abort(); await assert.rejects(running, { name: "AbortError" });
});

test("JSON bodies and content types are bounded and checked", async () => {
	await assert.rejects(fixture({ id: "s", results: [page] }, { maxBodyBytes: 16 }).discoverPerplexity("x"), /body limit/);
	await assert.rejects(createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response("{}") }).discoverPerplexity("x"), /content type/);
	await assert.rejects(createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response("not json secret", { headers: { "content-type": "application/json" } }) }).discoverPerplexity("x"), /schema/);
});
