import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentResponse } from "../../extensions/perplexity/perplexity.ts";
import { normalizeRecapCitations, scopeTranscriptCitations, unresolvedCitationMarkers } from "../../extensions/perplexity/citations.ts";

const a = { id: "9", title: "A", url: "https://example.com/a" };
const b = { id: "1", title: "B", url: "https://example.com/b" };
function response(content: string, sources = [a, b]) {
	return { id: "r", object: "response", created_at: 1, model: "fixture", status: "completed", output: [
		{ type: "search_results", results: sources.map((s) => ({ ...s, id: Number(s.id), snippet: "fixture" })) },
		{ type: "message", id: "msg", status: "completed", role: "assistant", content: [{ type: "output_text", text: content }] },
	] };
}

test("source-ID counterexample: reversed arrays and nonconsecutive IDs never renumber", () => {
	const result = normalizeAgentResponse(response("B[1] A[9] missing[2] typed[web:1] unknown[file:9]"));
	assert.equal(result.citations.find((s) => s.id === "1")!.url, b.url);
	assert.deepEqual(result.unresolvedCitations, ["[2]", "[file:9]"]);
	assert.match(result.content, /B\[1\]/);
});

test("URL duplicates retain separate IDs; conflicting source IDs fail loudly", () => {
	const result = normalizeAgentResponse(response("duplicate[1][9]", [a, { ...b, url: a.url }]));
	assert.equal(result.citations.length, 2);
	assert.throws(() => normalizeAgentResponse(response("claim[1]", [b, { ...a, id: "1" }])), /conflicting source ID/);
	assert.equal(normalizeAgentResponse(response("claim[1]", [b, b])).citations.length, 1);
	const raw = response("claim[1]", [b]);
	raw.output.push({ type: "search_results", results: [{ ...a, id: 1, snippet: "fixture" }] } as any);
	assert.throws(() => normalizeAgentResponse(raw), /conflicting/);
});

test("recap helper namespaces cross-turn references and labels unknowns visibly", () => {
	const turns = [{ role: "user" as const, text: "literal[1]" },
		{ role: "assistant" as const, text: "B[1] unknown[8]", citations: [b], responseId: "r1" },
		{ role: "user" as const, text: "next" },
		{ role: "assistant" as const, text: "A[web:1] B[2]", citations: [{ ...a, id: "1" }, { ...b, id: "2" }], responseId: "r2" }];
	const result = scopeTranscriptCitations(turns);
	assert.equal(result.turns[0].text, "literal[1]");
	assert.equal(result.turns[1].text, "B[t2:1] unknown[unresolved:t2:8]");
	assert.equal(result.turns[3].text, "A[t4:1] B[t4:2]");
	assert.deepEqual(result.citations.map((s) => [s.id, s.url]), [["t2:1", b.url], ["t4:1", a.url], ["t4:2", b.url]]);
	assert.deepEqual(result.unresolvedCitations, ["t2:8"]);
	assert.equal(turns[1].text, "B[1] unknown[8]");
});

test("recap validates scoped markers and cannot guess which turn a bare number means", () => {
	const result = normalizeRecapCitations("A[t2:1] B[t4:1] unknown[t3:1] ambiguous[1]", [{ ...a, id: "t2:1" }, { ...b, id: "t4:1" }]);
	assert.equal(result.content, "A[t2:1] B[t4:1] unknown[unresolved:t3:1] ambiguous[unresolved:1]");
	assert.deepEqual(result.unresolvedCitations, ["[t3:1]", "[1]"]);
	assert.deepEqual(result.citations.map((s) => s.url), [a.url, b.url]);
});

test("unknown markers are not guessed; duplicate unknowns deduplicate; cancelled partials remain unresolved", () => {
	assert.deepEqual(unresolvedCitationMarkers("[3][3][web:3][file:1]", [b]), ["[3]", "[web:3]", "[file:1]"]);
	assert.equal(scopeTranscriptCitations([{ role: "assistant", text: "partial[1]" }]).turns[0].text, "partial[unresolved:t1:1]");
});
