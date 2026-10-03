import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createPerplexityClient, PROVIDER_LIMITS } from "../../extensions/perplexity/perplexity.ts";

const messages = [{ role: "user" as const, content: "fixture" }];
const source = { id: 8, title: "Eight", url: "https://example.com/eight", snippet: "excerpt" };
const terminal = { id: "r", object: "response", created_at: 1, model: "fixture", status: "completed", output: [
	{ type: "search_results", results: [source] },
	{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Final café[8]" }] },
], usage: { total_tokens: 3 } };
const event = (type: string, extra: object = {}) => ({ type, sequence_number: 1, ...extra });
const delta = (text: string) => event("response.output_text.delta", { delta: text, item_id: "m", output_index: 0, content_index: 0 });
const frame = (data: unknown, newline = "\n") => `data: ${JSON.stringify(data)}${newline}${newline}`;
function fixture(text: string, splits: number[] = [], extra = {}) {
	const encoded = new TextEncoder().encode(text);
	return createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		start(controller) {
			let offset = 0;
			for (const size of splits) { controller.enqueue(encoded.slice(offset, offset + size)); offset += size; }
			controller.enqueue(encoded.slice(offset)); controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } }), ...extra });
}
const encoder = new TextEncoder();
function rawFixture(chunks: Uint8Array[]) {
	return createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
	}), { headers: { "content-type": "text/event-stream" } }) });
}
const joinBytes = (head: Uint8Array, tail: Uint8Array) => {
	const all = new Uint8Array(head.length + tail.length);
	all.set(head); all.set(tail, head.length);
	return all;
};

test("framed SSE handles every byte boundary, UTF8, CRLF, comments, multiline data and final buffered terminal", async () => {
	const multiline = `data: {"type":"response.reasoning.search_results",\r\ndata: "sequence_number":2,"results":${JSON.stringify([source])}}\r\n\r\n`;
	const text = ":keepalive\r\n\r\n" + frame(delta("café"), "\r\n") + multiline + "data: " + JSON.stringify(event("response.completed", { response: terminal }));
	let streamed = "", sources: any[] = [];
	const result = await fixture(text, Array(new TextEncoder().encode(text).length).fill(1)).streamPerplexity(messages, {
		onDelta: (s) => { streamed += s; }, onCitations: (s) => { sources = s; },
	});
	assert.equal(streamed, "café");
	assert.equal(result.content, "Final café[8]"); // final differs deliberately; authoritative terminal wins
	assert.equal(result.citations[0].id, "8");
	assert.deepEqual(sources, result.citations);
	assert.deepEqual(result.usage, { total_tokens: 3 });
});

test("output-item source events are parsed by ID, not event index", async () => {
	const text = frame(event("response.output_item.done", { output_index: 0, item: { type: "search_results", results: [source] } })) + frame(event("response.completed", { response: terminal })) + "data: [DONE]\n\n";
	let first: any;
	await fixture(text).streamPerplexity(messages, { onCitations: (sources) => { first ??= sources; } });
	assert.equal(first[0].id, "8");
});

test("stream source IDs reconcile across frames and terminal; conflicting mapping is an error", async () => {
	const first = event("response.reasoning.search_results", { results: [source] });
	const second = event("response.reasoning.search_results", { results: [{ ...source, id: 9, url: "https://example.com/nine" }] });
	let preview: any[] = [];
	await fixture(frame(first) + frame(second) + frame(event("response.completed", { response: terminal }))).streamPerplexity(messages, { onCitations: (s) => { if (s.length === 2) preview = s; } });
	assert.deepEqual(preview.map((s) => s.id), ["8", "9"]);
	const conflicting = event("response.reasoning.search_results", { results: [{ ...source, url: "https://example.com/wrong" }] });
	await assert.rejects(fixture(frame(first) + frame(conflicting)).streamPerplexity(messages), /conflicting source ID/);
	await assert.rejects(fixture(frame(conflicting) + frame(event("response.completed", { response: terminal }))).streamPerplexity(messages), /conflicting source ID/);
});

test("EOF/DONE alone, failed/incomplete/cancelled and malformed terminal cannot become success", async () => {
	for (const text of [frame(delta("partial")), "data: [DONE]\n\n", "data: {broken}\n\n",
		frame(event("response.failed", { error: { message: "secret-fixture" } })),
		frame(event("response.incomplete")), frame(event("response.cancelled")),
		frame(event("response.completed", { response: { ...terminal, status: "incomplete" } })),
		frame(event("response.completed")), frame({ type: "response.output_text.delta", delta: "x" })]) {
		await assert.rejects(fixture(text).streamPerplexity(messages), (error: Error) => !error.message.includes("secret-fixture"));
	}
});

test("first authoritative terminal ends dispatch; trailing frames are never parsed, identically across chunk framings", async () => {
	const completed = frame(event("response.completed", { response: terminal }));
	const completedBytes = encoder.encode(completed).length; // café makes string length ≠ byte length
	const tails: Record<string, string> = {
		"repeated terminal": frame(event("response.completed", { response: { ...terminal, id: "duplicate" } })),
		"trailing failure": frame(event("response.failed", { error: { message: "late-failure" } })),
		"trailing delta": frame(delta("after")),
		"unknown malformed": "data: not-json{{\n\n",
		"unterminated partial frame": "data: {\"type\":\"response.out",
	};
	for (const [label, tail] of Object.entries(tails)) {
		const text = completed + tail;
		const framings = [
			["single chunk", () => fixture(text)],
			["terminal and tail in separate chunks", () => fixture(text, [completedBytes])],
			["byte split", () => fixture(text, Array(encoder.encode(text).length).fill(1))],
		] as const;
		for (const [framing, make] of framings) {
			let deltas = "";
			const result = await make().streamPerplexity(messages, { onDelta: (s) => { deltas += s; } });
			assert.equal(result.content, "Final café[8]", `${label} / ${framing}`);
			assert.deepEqual(result.usage, { total_tokens: 3 }, `${label} / ${framing}`);
			assert.equal(deltas, "", `${label} / ${framing}: nothing dispatched after the terminal`);
		}
	}
});

test("terminal completion is byte-framing independent: raw tails after the terminal are never scanned, decoded, or charged", async () => {
	const completedBytes = encoder.encode(frame(event("response.completed", { response: terminal })));
	const invalidTail = new Uint8Array([0xff]);
	const hugeTail = encoder.encode(":comment\n\n".repeat(900_000)); // tail alone exceeds the 8 MiB body limit
	for (const [label, tail] of [["invalid UTF-8 byte", invalidTail], ["huge comment tail", hugeTail]] as const) {
		const bytes = joinBytes(completedBytes, tail);
		// every two-fragment cut for the small stream; boundary-focused cuts for huge tails
		const cuts = tail.length > 4096
			? [0, 1, completedBytes.length - 4, completedBytes.length - 1, completedBytes.length, completedBytes.length + 1, bytes.length - 1]
			: [...Array(bytes.length + 1).keys()];
		const layouts: Array<[string, Uint8Array[]]> = [
			["single chunk", [bytes]],
			...cuts.map((cut): [string, Uint8Array[]] => [`two fragments cut at ${cut}`, [bytes.slice(0, cut), bytes.slice(cut)]]),
			// byte-wise through the terminal framing, huge tail intact: bounded overhead
			["byte-wise terminal framing", [...Array(completedBytes.length).keys()].map((i) => bytes.subarray(i, i + 1)).concat([tail])],
		];
		for (const [framing, chunks] of layouts) {
			let deltas = "";
			const result = await rawFixture(chunks).streamPerplexity(messages, { onDelta: (s) => { deltas += s; } });
			assert.equal(result.content, "Final café[8]", `${label} / ${framing}`);
			assert.deepEqual(result.usage, { total_tokens: 3 }, `${label} / ${framing}`);
			assert.equal(deltas, "", `${label} / ${framing}: nothing dispatched after the terminal`);
		}
	}
});

test("preterminal invalid UTF-8 and body-limit excess still fail every chunk layout", async () => {
	const completedBytes = encoder.encode(frame(event("response.completed", { response: terminal })));
	const deltaBytes = encoder.encode(frame(delta("café")));
	const cafPrefix = encoder.encode('data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"m","output_index":0,"content_index":0,"delta":"caf');
	const corrupt = new Uint8Array(deltaBytes); corrupt[cafPrefix.length] = 0xff; // é lead byte → invalid UTF-8 before the terminal
	const comments = encoder.encode(":comment\n\n".repeat(900_000)); // body-limit excess strictly before the terminal
	const failures: Array<[string, Uint8Array, RegExp]> = [
		["invalid UTF-8 before terminal", joinBytes(corrupt, completedBytes), /not valid/],
		["body-limit excess before terminal", joinBytes(comments, completedBytes), /body limit/],
	];
	for (const [label, bytes, pattern] of failures) {
		const cuts = bytes.length > 4096
			? [0, 1, bytes.length - completedBytes.length, bytes.length - completedBytes.length + 1, bytes.length - 1, bytes.length]
			: [...Array(bytes.length + 1).keys()];
		for (const cut of cuts) {
			await assert.rejects(rawFixture([bytes.slice(0, cut), bytes.slice(cut)]).streamPerplexity(messages), pattern, `${label} cut at ${cut}`);
		}
		await assert.rejects(rawFixture([bytes]).streamPerplexity(messages), pattern, `${label} single chunk`);
		// bytewise only where bounded: full stream for small fixtures, head for huge ones
		const byteChunks = bytes.length > 4096
			? [...Array(64).keys()].map((i) => bytes.subarray(i, i + 1)).concat([bytes.slice(64)])
			: [...Array(bytes.length).keys()].map((i) => bytes.subarray(i, i + 1));
		await assert.rejects(rawFixture(byteChunks).streamPerplexity(messages), pattern, `${label} byte-wise`);
	}
});

test("frame and body limits hold at the boundary including the final flush", async () => {
	await assert.rejects(fixture("data: " + "x".repeat(58), [], { maxBodyBytes: 64 }).streamPerplexity(messages), /SSE JSON/); // exactly at the frame limit passes, then fails schema
	await assert.rejects(fixture("data: " + "x".repeat(59), [], { maxBodyBytes: 64 }).streamPerplexity(messages), /frame limit/); // one byte over at the final flush
	await assert.rejects(fixture("data: " + "x".repeat(59) + "\n\n" + frame(event("response.completed", { response: terminal })), [], { maxBodyBytes: 64 }).streamPerplexity(messages), /frame limit/); // oversize frame wins over later terminal
});

test("early stop cancels and releases the reader without waiting for post-terminal chunks", async () => {
	let cancelled = false;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		start(c) {
			// Never closes: an early-stop policy must not wait for EOF after the terminal.
			c.enqueue(new TextEncoder().encode(frame(event("response.completed", { response: terminal })) + frame(delta("after"))));
		},
		cancel() { cancelled = true; },
	}), { headers: { "content-type": "text/event-stream" } }) });
	const result = await client.streamPerplexity(messages);
	assert.equal(result.content, "Final café[8]");
	assert.equal(cancelled, true);
});

test("callback errors propagate rather than swallowed as JSON errors; reader is cancelled", async () => {
	const sentinel = new Error("callback sentinel");
	await assert.rejects(fixture(frame(delta("x")) + frame(event("response.completed", { response: terminal }))).streamPerplexity(messages, { onDelta: () => { throw sentinel; } }), (error) => error === sentinel);
	await assert.rejects(fixture(frame(event("response.completed", { response: terminal }))).streamPerplexity(messages, { onCitations: () => { throw sentinel; } }), (error) => error === sentinel);
	let cancelled = false;
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		start(c) { c.enqueue(new TextEncoder().encode(frame(delta("x")))); }, cancel() { cancelled = true; },
	}), { headers: { "content-type": "text/event-stream" } }) });
	await assert.rejects(client.streamPerplexity(messages, { onDelta: () => { throw sentinel; } }), (error) => error === sentinel);
	assert.equal(cancelled, true);
});

test("stream frame limit includes complete frames and pending frame, total body is bounded", async () => {
	await assert.rejects(fixture(frame(delta("x".repeat(200))), [], { maxBodyBytes: 64 }).streamPerplexity(messages), /frame limit/);
	await assert.rejects(fixture("data: " + "x".repeat(200), [], { maxBodyBytes: 64 }).streamPerplexity(messages), /frame limit/);
	await assert.rejects(fixture(":comment\n\n".repeat(900_000)).streamPerplexity(messages), /body limit/);
});

test("pending frame bytes count toward the body budget: open streams reject with the body limit before the deadline", async () => {
	const commentBytes = encoder.encode(":comment\n\n".repeat(838_860)); // 8,388,600 charged bytes, under the 8,388,608 limit
	const pendingBytes = encoder.encode('data: {"x":'); // 11 undelimited pending bytes → 8,388,611 > 8,388,608
	const layouts: Uint8Array[][] = [
		[joinBytes(commentBytes, pendingBytes)], // coalesced
		[commentBytes, pendingBytes], // split comments/pending across chunks
		[commentBytes.subarray(0, 4_194_300), commentBytes.subarray(4_194_300), pendingBytes], // split comments too
	];
	for (const chunks of layouts) {
		let cancelled = false;
		const client = createPerplexityClient({ apiKey: () => "fixture", deadlineMs: 1000, fetch: async () => new Response(new ReadableStream({
			start(c) { for (const chunk of chunks) c.enqueue(chunk); /* stream deliberately left open */ },
			cancel() { cancelled = true; },
		}), { headers: { "content-type": "text/event-stream" } }) });
		await assert.rejects(client.streamPerplexity(messages), /body limit/); // a deadline wait would fail as "deadline exceeded" instead
		assert.equal(cancelled, true);
	}
});

test("a legal max-size frame succeeds identically coalesced and cut at every delimiter byte before completion (LF/CRLF/CRCR)", async () => {
	const comment = ":" + "x".repeat(PROVIDER_LIMITS.maxBodyBytes - 1); // comment frame of exactly maxBody frame bytes
	const completed = frame(event("response.completed", { response: terminal }));
	for (const delimiter of ["\n\n", "\r\n\r\n", "\r\r"]) {
		const bytes = encoder.encode(comment + delimiter + completed);
		const cuts = [comment.length - 1, ...Array(delimiter.length + 2).keys()].map((offset) => comment.length + offset - 1);
		for (const cut of [...cuts, 0]) {
			const chunks = cut === 0 ? [bytes] : [bytes.slice(0, cut), bytes.slice(cut)];
			let deltas = "";
			const result = await rawFixture(chunks).streamPerplexity(messages, { onDelta: (s) => { deltas += s; } });
			assert.equal(result.content, "Final café[8]", `${JSON.stringify(delimiter)} cut at ${cut}`);
			assert.equal(deltas, ""); // a comment frame never dispatches deltas
		}
	}
});

test("a true oversize frame rejects every layout including the final flush, while the body cap stays exact", async () => {
	const oversize = ":" + "x".repeat(PROVIDER_LIMITS.maxBodyBytes); // one byte over the frame cap
	const completed = frame(event("response.completed", { response: terminal }));
	for (const delimiter of ["\n\n", "\r\n\r\n", "\r\r"]) {
		const bytes = encoder.encode(oversize + delimiter + completed);
		for (const cut of [0, 1, oversize.length - 1, oversize.length, oversize.length + delimiter.length - 1, oversize.length + delimiter.length, bytes.length - 1]) {
			const chunks = cut === 0 ? [bytes] : [bytes.slice(0, cut), bytes.slice(cut)];
			await assert.rejects(rawFixture(chunks).streamPerplexity(messages), /frame limit/, `cut at ${cut}`);
		}
	}
	// EOF flush with a disproven partial delimiter prefix still enforces the exact cap
	await assert.rejects(rawFixture([encoder.encode(oversize)]).streamPerplexity(messages), /frame limit/);
	await assert.rejects(rawFixture([encoder.encode(oversize.slice(0, -1) + "\r")]).streamPerplexity(messages), /frame limit/);
	// accepted pending only via the partial-prefix exclusion (maxBody raw bytes + 1 partial "\r"), then rejected at the exact dispatch cap
	await assert.rejects(rawFixture([encoder.encode(":" + "x".repeat(PROVIDER_LIMITS.maxBodyBytes - 1)), encoder.encode("\r")]).streamPerplexity(messages), /frame limit/);
});

test("pending bytes that only looked like a delimiter prefix count as payload the moment they are disproven", async () => {
	// maxBody-1 frame bytes + "\r" is accepted pending (candidate = maxBody); "x" disproves the prefix → immediate frame limit
	const bytes = encoder.encode(":" + "x".repeat(PROVIDER_LIMITS.maxBodyBytes - 1) + "\rx");
	for (const chunks of [[bytes], [bytes.slice(0, bytes.length - 2), bytes.slice(bytes.length - 2)], [bytes.slice(0, bytes.length - 1), bytes.slice(bytes.length - 1)]]) {
		await assert.rejects(rawFixture(chunks).streamPerplexity(messages), /frame limit/);
	}
});

function pullFixture(bytes: Uint8Array, fragment: number, extra = {}) {
	let offset = 0;
	return createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(offset, offset + fragment)); offset += fragment; },
	}), { headers: { "content-type": "text/event-stream" } }), ...extra });
}

const boundedComment = () => encoder.encode(":" + "x".repeat(PROVIDER_LIMITS.maxBodyBytes - 512) + "\n\n" + frame(event("response.completed", { response: terminal })));

test("a short injected deadline rejects before all fragments are consumed and macrotask timers keep firing", async () => {
	const bytes = boundedComment();
	for (const fragment of [64, 16]) {
		let offset = 0, cancelled = false, timerFired = false;
		// Independent timer sits clearly INSIDE the injected 10ms deadline window: the
		// in-loop deadline check may legitimately win the race at ~10ms, so a 10ms
		// timer would be flaky; 5ms must fire while consumption is still running.
		const timer = setTimeout(() => { timerFired = true; }, 5);
		const client = createPerplexityClient({ apiKey: () => "fixture", deadlineMs: 10, fetch: async () => new Response(new ReadableStream({
			pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(offset, offset + fragment)); offset += fragment; },
			cancel() { cancelled = true; },
		}), { headers: { "content-type": "text/event-stream" } }) });
		await assert.rejects(client.streamPerplexity(messages), /deadline exceeded/);
		clearTimeout(timer);
		assert.equal(timerFired, true, `an independent ${fragment}-byte-fragment timer must fire during consumption`);
		assert.ok(offset < bytes.length, `${fragment}-byte fragments: deadline rejects before all fragments are consumed`);
		assert.equal(cancelled, true);
	}
});

test("caller abort during fragmented consumption is delivered as AbortError with reader cancel", async () => {
	const bytes = boundedComment();
	let offset = 0, cancelled = false;
	const controller = new AbortController();
	const client = createPerplexityClient({ apiKey: () => "fixture", fetch: async () => new Response(new ReadableStream({
		pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(offset, offset + 16)); offset += 16; },
		cancel() { cancelled = true; },
	}), { headers: { "content-type": "text/event-stream" } }) });
	const promise = client.streamPerplexity(messages, { signal: controller.signal });
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(promise, { name: "AbortError" });
	assert.equal(cancelled, true);
	assert.ok(offset < bytes.length, "abort interrupts consumption before all fragments");
});

test("a valid 2 MiB stream in 16-byte fragments keeps the event loop responsive and completes fast", async () => {
	const bytes = boundedComment();
	let timerFired = false;
	const timer = setTimeout(() => { timerFired = true; }, 10);
	const start = performance.now();
	let deltas = "";
	const result = await pullFixture(bytes, 16).streamPerplexity(messages, { onDelta: (s) => { deltas += s; } });
	const elapsed = performance.now() - start;
	clearTimeout(timer);
	assert.equal(result.content, "Final café[8]");
	assert.equal(deltas, "");
	assert.equal(timerFired, true, `macrotask timer fired during consumption (${Math.round(elapsed)}ms, no 9s starvation)`);
	assert.ok(elapsed < 5_000, `fragmented consumption stays fast (took ${Math.round(elapsed)}ms; the quadratic baseline was ~9400ms)`);
});

test("panel keeps fast-only controls, cancellation and explicit recap boundary (offline UI stubs)", async () => {
	const coding = "export const getMarkdownTheme = () => ({});";
	const tui = `
		export class Input { value = ''; setValue(v) { this.value = v; } getValue() { return this.value; } invalidate() {} handleInput() {} render() { return [this.value]; } }
		export class Markdown { constructor(text) { this.text = text; } render() { return [this.text]; } }
		export const matchesKey = (data, key) => data === key;
		export const truncateToWidth = (text, width) => text.slice(0, width);
		export const visibleWidth = (text) => text.length;
		export const wrapTextWithAnsi = (text) => [text];
	`;
	const hooks = registerHooks({ resolve(specifier, context, next) {
		const source = specifier === "@earendil-works/pi-coding-agent" ? coding : specifier === "@earendil-works/pi-tui" ? tui : undefined;
		return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
	} });
	try {
		const { ResearchPanel } = await import("../../extensions/perplexity/research-panel.ts");
		const closed: any[] = [];
		let sent: any[] = [];
		let recapSignal: AbortSignal | undefined;
		const theme = { fg: (_color, text) => text, bold: (text) => text } as any;
		const panel = new ResearchPanel({ requestRender() {} } as any, theme, {
			streamResearch: async (input, options) => {
				sent = input;
				options!.onDelta?.("preview[8]");
				return { responseId: "r", content: "authoritative[8] unresolved[2]", citations: [{ id: "8", title: source.title, url: source.url }], unresolvedCitations: ["[2]"] };
			},
			synthesize: async (_turns, signal) => { recapSignal = signal; panel.handleInput("escape"); return "must not close when cancelled"; },
			done: (value) => closed.push(value),
		}) as any;
		await panel.submitQuery("fixture");
		assert.equal(closed.length, 0); // answers do not auto-submit into main context
		assert.equal(panel.turns[1].text, "authoritative[8] unresolved[2]");
		assert.match(panel.render(200).join("\n"), /\[8\] Eight/);
		assert.match(panel.render(200).join("\n"), /Unresolved citations: \[2\]/);
		panel.handleInput("ctrl+p"); panel.handleInput("ctrl+t");
		assert.match(panel.render(200).join("\n"), /fast/);
		assert.doesNotMatch(panel.render(200).join("\n"), /sonar|deep-research/);
		await panel.submitQuery("follow up");
		assert.match(sent[2].content, /authoritative\[t2:8\]/);
		assert.match(sent[2].content, /not locally inspected/);
		await panel.requestRecap();
		assert.equal(recapSignal!.aborted, true);
		assert.equal(closed.length, 0);
		panel.deps.synthesize = async () => "editable recap";
		await panel.requestRecap();
		assert.equal(closed.length, 1);
		assert.equal(closed[0].recap, true);
		assert.equal(closed[0].recapText, "editable recap");
		const cancelled = new ResearchPanel({ requestRender() {} } as any, theme, {
			streamResearch: async (_input, options) => {
				options!.onDelta?.("partial[9]");
				cancelled.handleInput("escape");
				throw new DOMException("fixture cancellation", "AbortError");
			}, synthesize: async () => "unused", done: (value) => closed.push(value),
		}) as any;
		await cancelled.submitQuery("cancel me");
		assert.match(cancelled.turns[1].text, /search cancelled/);
		assert.deepEqual(cancelled.turns[1].unresolvedCitations, ["[9]"]);
		assert.equal(cancelled.status, "idle");
		cancelled.handleInput("escape");
		assert.equal(closed.at(-1), null);
	} finally { hooks.deregister(); }
});

test("stream cancellation and deadline cancel readers without accepting partial text", async () => {
	for (const mode of ["abort", "deadline"]) {
		let cancelled = false;
		const controller = new AbortController();
		const client = createPerplexityClient({ apiKey: () => "fixture", deadlineMs: 10, fetch: async () => new Response(new ReadableStream({
			start(c) { c.enqueue(new TextEncoder().encode(frame(delta("partial")))); }, cancel() { cancelled = true; },
		}), { headers: { "content-type": "text/event-stream" } }) });
		const promise = client.streamPerplexity(messages, { signal: controller.signal, onDelta: () => { if (mode === "abort") controller.abort(); } });
		if (mode === "abort") await assert.rejects(promise, { name: "AbortError" });
		else await assert.rejects(promise, /deadline exceeded/);
		assert.equal(cancelled, true);
	}
});
