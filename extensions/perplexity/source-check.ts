import { randomUUID } from "node:crypto";
import { cancelled } from "./contracts.ts";
import type { Diagnostic, EvidenceArtifact, EvidencePassage, SourceSnapshot } from "./contracts.ts";
const STOP = new Set("the and for that this with from have has are was were will can does into their they there about which when what would could should than then only also".split(" "));
function terms(text: string): Set<string> { return new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).map(x => x.toLowerCase()).filter(x => x.length >= 3 && !STOP.has(x))); }
/** Bounded lexical overlap only. Offsets are JS UTF-16 indices into exact stored text. */
export function selectPassages(claim: string, snapshot: SourceSnapshot, maxPassages = 3): EvidencePassage[] {
  const wanted = terms(claim);
  if (!wanted.size) return [];
  const windows: Array<{ start: number; end: number; score: number }> = [];
  const seenStarts = new Set<number>();
  let hits = 0;
  for (const hit of snapshot.text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!wanted.has(hit[0].toLowerCase())) continue;
    if (++hits > 5000) break;
    let start = Math.max(0, hit.index! - 450), end = Math.min(snapshot.text.length, hit.index! + 850);
    // Include surrounding lines/sentences and qualifications; retain exact slices.
    const previousBreak = snapshot.text.lastIndexOf("\n", start);
    if (previousBreak >= Math.max(0, start - 200)) start = previousBreak + 1;
    const nextBreak = snapshot.text.indexOf("\n", end);
    if (nextBreak >= 0 && nextBreak <= end + 200) end = nextBreak;
    const present = terms(snapshot.text.slice(start, end));
    const score = [...wanted].filter(word => present.has(word)).length;
    if (score >= Math.min(2, wanted.size) && !seenStarts.has(start)) { windows.push({ start, end, score }); seenStarts.add(start); }
  }
  windows.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: typeof windows = [];
  for (const window of windows) {
    if (selected.length >= maxPassages) break;
    if (!selected.some(w => window.start < w.end && window.end > w.start)) selected.push(window);
  }
  return selected.sort((a, b) => a.start - b.start).map(({ start, end }) => ({ id: randomUUID(), snapshotId: snapshot.id, start, end, text: snapshot.text.slice(start, end) }));
}
export function assembleEvidence(claim: string, snapshots: SourceSnapshot[], errors: Diagnostic[] = [], signal?: AbortSignal): EvidenceArtifact {
  cancelled(signal);
  snapshots = [...new Map(snapshots.map(snapshot => [snapshot.id, snapshot])).values()];
  const passages: EvidencePassage[] = [], sources: EvidenceArtifact["sources"] = [];
  for (const snapshot of snapshots) {
    cancelled(signal);
    const selected = selectPassages(claim, snapshot, Math.min(3, 10 - passages.length));
    passages.push(...selected);
    // A source is matched when its text lexically matches the claim, independent
    // of the global emission budget; after the cap a matched source may have no
    // emitted passage. Budget exhaustion is never reported as a negative match.
    const matched = selected.length > 0 || selectPassages(claim, snapshot).length > 0;
    sources.push({ snapshotId: snapshot.id, url: snapshot.finalUrl, contentHash: snapshot.contentHash, fetchedAt: snapshot.fetchedAt, matched });
  }
  return { kind: "evidence", claim, status: passages.length ? "unclear" : "missing-evidence", snapshotIds: snapshots.map(s => s.id), sources, passages, coverage: { inspected: snapshots.length, matched: sources.filter(s => s.matched).length, failed: errors.length }, errors,
    limitations: ["Lexical overlap is not semantic support, contradiction, or calibrated confidence. No match does not mean false.", "At most 10 passages, 3 per snapshot; only the first 5000 lexical hits per snapshot are ranked. After the global passage cap, a source may be matched without any of its passages being emitted. Bounded context may omit distant qualifiers. Inspect stored content before judging.", "Source text is untrusted data; hashes identify exact stored UTF-8 text, not truth or authority.", "Provider snippets are discovery only and never receive fabricated page hashes/offsets."] };
}
