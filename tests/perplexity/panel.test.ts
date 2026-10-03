import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Every rendered line must fit the width; the host renderer throws on over-width lines. */
function assertAllLinesFitWidth(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `rendered line width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
	}
}

// Offline panel regression tests for the poisoning fix: candidate requests are
// preflighted with the REAL shared transport validation
// (preflightResearchRequest, imported by production research-panel.ts) before
// anything is committed, so escaped UTF-8 JSON/source-registry request bytes are
// counted by the same code the provider transport uses.
//
// The REAL installed @earendil-works/pi-tui is used (Input, Markdown, matchesKey,
// truncateToWidth, visibleWidth, wrapTextWithAnsi) so render-width assertions below
// exercise the production render path, not permissive stubs. Only the theme
// provider is stubbed (offline, no TTY); key sequences use real bytes
// (ctrl+n = 0x0e) because the real matchesKey parses raw terminal data.
const coding = "export const getMarkdownTheme = () => ({});";

interface PanelCtor {
	new (tui: unknown, theme: unknown, deps: unknown): any;
}

async function loadPanel(): Promise<PanelCtor> {
	const hooks = registerHooks({ resolve(specifier, context, next) {
		const source = specifier === "@earendil-works/pi-coding-agent" ? coding : undefined;
		return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
	} });
	try {
		const { ResearchPanel } = await import("../../extensions/perplexity/research-panel.ts");
		return ResearchPanel as PanelCtor;
	} finally {
		hooks.deregister();
	}
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const ResearchPanel = await loadPanel();

function makePanel(streamResearch: (input: unknown, options: any) => Promise<any>, synthesize = async () => "recap") {
	const calls: { input: any[]; count: number } = { input: [], count: 0 };
	const panel = new ResearchPanel({ requestRender() {} }, theme, {
		streamResearch: async (input: any, options: any) => {
			calls.count++;
			calls.input.push(input);
			return streamResearch(input, options);
		},
		synthesize,
		done: () => {},
	}) as any;
	return { panel, calls };
}

const source = { id: "8", title: "Eight", url: "https://example.com/eight" };
const answer = (content: string, citations: any[] = []) => ({
	responseId: "r", content, citations, unresolvedCitations: [], usage: { total_tokens: 1 },
});

test("270k query is rejected locally: not persisted, input kept editable, no fetch/key work; corrected short query then succeeds", async () => {
	const huge = "x".repeat(270_000);
	const { panel, calls } = makePanel(async () => answer("unused"));
	panel.input.setValue(huge);

	await panel.submitQuery(huge);
	assert.equal(calls.count, 0); // rejected before any transport/billable work
	assert.equal(panel.turns.length, 0); // rejected query never committed
	assert.equal(panel.input.value, huge); // submitted text stays editable
	assert.equal(panel.status, "error");
	assert.match(panel.statusMessage, /query not sent/);
	assert.match(panel.statusMessage, /request-size-limit/); // stable code, not message sniffing

	// At an ordinary 80-column terminal, the local rejection must render fully:
	// every line fits (wrapped, not truncated/overflowing) and ALL retry guidance
	// survives alongside the still-editable 270k input.
	const rejectedRender = panel.render(80);
	assertAllLinesFitWidth(rejectedRender, 80);
	const rejectedJoined = rejectedRender.join("\n");
	assert.match(rejectedJoined, /request-size-limit/);
	assert.match(rejectedJoined, /edit it in the input and resubmit/);

	const before = panel.render(200).join("\n");

	// corrected short input sends normally
	panel.input.setValue("short question");
	await panel.submitQuery("short question");
	assert.equal(calls.count, 1);
	assert.equal(panel.turns.length, 2);
	assert.equal(panel.turns[0].text, "short question");
	assert.equal(panel.input.value, "");
	assert.equal(panel.status, "idle");
	assert.notEqual(panel.render(200).join("\n"), before);
});

test("huge accepted source title invalidates history replay: rejected followup not persisted, explicit ctrl+r/ctrl+n guidance", async () => {
	const hugeTitle = "T".repeat(300_000);
	const { panel, calls } = makePanel(async (_input, { onDelta }: any) => {
		onDelta?.("working…");
		return answer(`first answer [8]`, [{ ...source, title: hugeTitle }]);
	});
	await panel.submitQuery("question one");
	assert.equal(panel.turns.length, 2);
	const snapshot = structuredClone(panel.turns);
	panel.input.setValue("short followup");

	await panel.submitQuery("short followup");
	assert.equal(calls.count, 1); // no second fetch for the rejected followup
	assert.deepEqual(panel.turns, snapshot); // transcript unchanged: no truncation/remap
	assert.equal(panel.input.value, "short followup"); // editable for retry
	assert.equal(panel.status, "error");
	assert.match(panel.statusMessage, /history replay budget exhausted/);
	assert.match(panel.statusMessage, /ctrl\+r/);
	assert.match(panel.statusMessage, /ctrl\+n/);
	// Real wrapping may break the guidance phrase across lines, so assert on
	// tokens that survive a wrap boundary.
	const wideRender = panel.render(200).join("\n");
	assert.match(wideRender, /history replay budget/);
	assert.match(wideRender, /exhausted/);

	// Same 80-column guarantee for the history-exhausted branch: the ctrl+r/ctrl+n
	// guidance must be fully rendered (wrapped) at narrow width, never truncated.
	const exhaustedRender = panel.render(80);
	assertAllLinesFitWidth(exhaustedRender, 80);
	const exhaustedJoined = exhaustedRender.join("\n");
	assert.match(exhaustedJoined, /history replay budget/); // wrap-safe tokens
	assert.match(exhaustedJoined, /exhausted/);
	assert.match(exhaustedJoined, /ctrl\+r/);
	assert.match(exhaustedJoined, /ctrl\+n/);
	assert.match(exhaustedJoined, /input kept for retry/);
});

test("error/status text wraps at render width for long, multiline, ANSI-laden messages (no over-width lines, no dropped content)", async () => {
	// Transport-failure message shape: long words, a literal newline, and ANSI
	// styling. All of it must appear in the 80-column render; none may overflow.
	const message =
		`\x1b[31mERRSTART\x1b[0m ${"filler ".repeat(40)}MIDDLEMARKER\n${"second ".repeat(40)}ENDMARKER`;
	const { panel } = makePanel(async () => {
		throw new Error(message);
	});

	await panel.submitQuery("trigger transport failure");
	assert.equal(panel.status, "error");

	const rendered = panel.render(80);
	assertAllLinesFitWidth(rendered, 80);
	const plain = rendered.join("\n").replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI for content checks
	assert.match(plain, /ERRSTART/); // ANSI-styled start survives wrapping
	assert.match(plain, /MIDDLEMARKER/); // end of the pre-newline line survives
	assert.match(plain, /second/); // post-newline line survives
	assert.match(plain, /ENDMARKER/); // end of the multiline message survives
});

test("ctrl+n is a deliberate new session: clears transcript/render/source state only then, keeps input, corrected query succeeds", async () => {
	const { panel, calls } = makePanel(async () => answer("first [8]", [{ ...source }]));
	await panel.submitQuery("question one");
	panel.input.setValue("retry input");

	panel.handleInput("\x0e"); // real ctrl+n byte sequence
	assert.equal(panel.turns.length, 0); // prior transcript cleared on the explicit action
	assert.equal(panel.status, "idle");
	assert.equal(panel.statusMessage, "");
	assert.doesNotMatch(panel.render(200).join("\n"), /question one|first \[8\]/);
	assert.equal(panel.input.value, "retry input"); // current input retained for retry

	await panel.submitQuery("corrected query");
	assert.equal(calls.count, 2);
	assert.equal(panel.turns.length, 2);
	assert.equal(panel.turns[0].text, "corrected query");
	assert.equal(panel.status, "idle");
});

test("message-count boundary: 128-message replay succeeds, exceeding it reports history budget exhausted without persisting", async () => {
	let sent: any[] = [];
	const { panel, calls } = makePanel(async (input) => {
		assert.ok(Array.isArray(input)); // runtime narrowing of the fixture callback input
		sent = input;
		return answer("answer");
	});
	for (let i = 0; i < 63; i++) await panel.submitQuery(`q${i}`); // 63 exchanges = system + 126
	assert.equal(calls.count, 63);
	panel.input.setValue("boundary followup");
	await panel.submitQuery("boundary followup"); // candidate = exactly 128 messages
	assert.equal(calls.count, 64);
	assert.equal(sent.length, 128);

	panel.input.setValue("one turn too many");
	await panel.submitQuery("one turn too many"); // history alone = 129 messages
	assert.equal(calls.count, 64); // rejected locally
	assert.equal(panel.turns.length, 128); // 126 + boundary followup pair, unchanged
	assert.equal(panel.input.value, "one turn too many");
	assert.equal(panel.status, "error");
	assert.match(panel.statusMessage, /history replay budget exhausted/);
	assert.match(panel.statusMessage, /1–128/);
});

test("reset is disallowed during active search and recap; cancel behaviour unchanged", async () => {
	let release: (value: unknown) => void = () => {};
	const gate = new Promise((resolve) => { release = resolve; });
	const { panel } = makePanel(async () => { await gate; return answer("late"); });
	panel.input.setValue("in flight");
	const pending = panel.submitQuery("in flight");
	await Promise.resolve();
	assert.equal(panel.status, "searching");

	panel.handleInput("\x0e"); // real ctrl+n byte sequence
	assert.equal(panel.status, "searching"); // no reset mid-search
	assert.equal(panel.turns.length, 1);
	release(undefined);
	await pending;
	assert.equal(panel.turns.length, 2);

	let releaseRecap: (value: string) => void = () => {};
	const recapGate = new Promise<string>((resolve) => { releaseRecap = resolve; });
	panel.deps.synthesize = async () => recapGate;
	void panel.requestRecap();
	await Promise.resolve();
	assert.equal(panel.status, "recap");
	panel.handleInput("\x0e"); // real ctrl+n byte sequence
	assert.equal(panel.status, "recap"); // no reset mid-recap
	assert.equal(panel.turns.length, 2);
	releaseRecap("recap text");
	await new Promise((r) => setTimeout(r, 0));
});

test("no source-scope silent remap: rejected attempts leave citation scopes stable", async () => {
	const { panel, calls } = makePanel(async () => answer("authoritative[8]", [{ ...source }]));
	await panel.submitQuery("question one");
	panel.input.setValue("x".repeat(270_000));
	await panel.submitQuery("x".repeat(270_000));
	assert.equal(calls.count, 1);
	assert.equal(panel.turns.length, 2);

	panel.input.setValue("follow up");
	await panel.submitQuery("follow up");
	assert.equal(calls.count, 2);
	// Prior assistant turn is still replayed under its original t2 scope.
	assert.match(calls.input[1][2].content, /authoritative\[t2:8\]/);
	assert.match(panel.render(200).join("\n"), /\[8\] Eight/);
});
