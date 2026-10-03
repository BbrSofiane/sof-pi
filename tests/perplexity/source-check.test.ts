import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { selectPassages, assembleEvidence } from "../../extensions/perplexity/source-check.ts";
import type { SourceSnapshot } from "../../extensions/perplexity/contracts.ts";
function snapshot(text: string): SourceSnapshot { return { schemaVersion: 1, id: randomUUID(), scopeId: "scope", requestedUrl: "https://example.com", finalUrl: "https://example.com", fetchedAt: new Date(0).toISOString(), representation: "text", extractorVersion: "fixture/1", text, contentHash: createHash("sha256").update(text, "utf8").digest("hex") }; }
test("lexical passages preserve exact UTF16 slicing invariant and surrounding qualifiers", () => {
  const s = snapshot("🙂 A Unicode intro.\nThe intervention increased survival. However, only eligible adults benefited; this is not guaranteed.\n| Group | Benefit |\n| Children | not tested |\n```\nif (eligible) benefit();\n```\n");
  const passages = selectPassages("intervention increased survival", s); assert.ok(passages.length);
  for (const passage of passages) { assert.equal(s.text.slice(passage.start, passage.end), passage.text); assert.equal(passage.snapshotId, s.id); assert.match(passage.text, /However, only eligible/); assert.match(passage.text, /not guaranteed/); }
  assert.match(passages[0].text, /not tested/); assert.match(passages[0].text, /if \(eligible\)/);
});
test("no lexical match honestly reports missing evidence without semantic judgment/confidence", () => {
  const artifact = assembleEvidence("antibiotics reduce infection", [snapshot("Unrelated astronomy and distant galaxies.")]); assert.equal(artifact.status, "missing-evidence"); assert.deepEqual(artifact.passages, []); assert.equal(artifact.coverage.inspected, 1); assert.equal(artifact.sources[0].matched, false); assert.equal("confidence" in artifact, false); assert.equal("supported" in artifact, false);
});
test("matched negative wording still means unclear, never contradicted/supported", () => {
  const artifact = assembleEvidence("vaccination prevents infection", [snapshot("Vaccination does not always prevent infection. Larger studies are needed.")]); assert.equal(artifact.status, "unclear"); assert.match(artifact.passages[0].text, /not always/); assert.equal(artifact.coverage.matched, 1); assert.ok(artifact.limitations.some(x => x.includes("not semantic")));
});
test("selection is bounded, overlap-free, deterministic except opaque passage IDs", () => {
  const s = snapshot(Array.from({ length: 100 }, (_, i) => `Study ${i}: treatment improved outcome. ` + "padding ".repeat(300)).join("\n"));
  const first = selectPassages("treatment improved outcome", s); const second = selectPassages("treatment improved outcome", s);
  assert.equal(first.length, 3); assert.deepEqual(first.map(p => [p.start, p.end, p.text]), second.map(p => [p.start, p.end, p.text]));
  for (let i = 1; i < first.length; i++) assert.ok(first[i].start >= first[i - 1].end);
  const artifact = assembleEvidence("treatment improved outcome", Array.from({ length: 10 }, () => ({ ...s, id: randomUUID() }))); assert.equal(artifact.passages.length, 10);
});
test("budget exhaustion never turns lexical matches into matched:false negatives", () => {
  const matching = () => snapshot(Array.from({ length: 3 }, (_, i) => `Study ${i}: treatment improved outcome. ` + "padding ".repeat(300)).join("\n"));
  const unrelated = snapshot("Unrelated astronomy and distant galaxies only.");
  const snapshots = Array.from({ length: 5 }, matching).concat(unrelated);
  const artifact = assembleEvidence("treatment improved outcome", snapshots);
  assert.equal(artifact.status, "unclear");
  assert.equal(artifact.passages.length, 10);
  assert.equal(artifact.coverage.inspected, 6);
  assert.equal(artifact.coverage.matched, 5);
  assert.ok(artifact.sources.slice(0, 5).every(s => s.matched));
  assert.equal(artifact.sources[4].matched, true);
  assert.equal(artifact.sources[5].matched, false);
  assert.equal(selectPassages("treatment improved outcome", snapshots[4]).length, 3);
});
test("assembly deduplicates repeated snapshots before coverage and passage selection", () => {
  const s = snapshot("Drug treatment improves outcome. However, only some benefit.");
  const artifact = assembleEvidence("drug treatment outcome", Array(50).fill(s));
  assert.equal(artifact.coverage.inspected, 1); assert.equal(artifact.sources.length, 1); assert.deepEqual(artifact.snapshotIds, [s.id]); assert.equal(artifact.passages.length, 1);
});
test("case folding never changes passage offsets", () => {
  const s = snapshot("İstanbul🙂 condition observed. CONDITION OBSERVED, but limited."); const passages = selectPassages("condition observed", s); assert.ok(passages.length); for (const p of passages) assert.equal(s.text.slice(p.start, p.end), p.text);
});
test("errors count retrieval coverage, cancellation remains cancellation", () => {
  const artifact = assembleEvidence("drug outcome", [], [{ index: 0, code: "http-error", message: "Source unavailable" }]); assert.equal(artifact.coverage.failed, 1); assert.equal(artifact.status, "missing-evidence");
  const c = new AbortController(); c.abort(); assert.throws(() => assembleEvidence("drug outcome", [], [], c.signal), { name: "AbortError" });
});
