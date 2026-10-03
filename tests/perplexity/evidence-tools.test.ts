import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { EvidenceService, OperationGate, registerWebTools } from "../../extensions/perplexity/web-tools.ts";
import { EvidenceStore } from "../../extensions/perplexity/evidence-store.ts";
import { SearchOutput, FetchOutput, ReadOutput, CheckOutput } from "../../extensions/perplexity/contracts.ts";
import type { Discover } from "../../extensions/perplexity/contracts.ts";
const fetched = (url: string, text = "Drug treatment improves outcome. However, only eligible adults benefit.\n".repeat(100)) => ({ requestedUrl: url, finalUrl: url, fetchedAt: new Date(0).toISOString(), representation: "text" as const, extractorVersion: "fixture/1", text, contentHash: createHash("sha256").update(text, "utf8").digest("hex") });
const discovery: Discover = async (query, options) => ({ requestId: `request-${query}`, usage: { searches: 1 }, results: Array.from({ length: Math.min(options.numResults ?? 1, 2) }, (_, i) => ({ id: `${i + 1}`, title: `Source ${query} ${i}`, url: `https://example.com/${query}/${i}`, snippet: `Provider snippet ${query} ${i}`.repeat(100), date: "2026-01-01", lastUpdated: "2026-02-01" })) });
async function setup(t: any, opts: any = {}) { const root = await mkdtemp(join(tmpdir(), "pi-evidence-tools-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new EvidenceStore("session", { root }); const service = new EvidenceService({ discover: discovery, fetch: async url => fetched(url), ...opts }); return { root, store, service }; }
function satisfies(result: any, schema: any) { assert.equal(Value.Check(schema, result.structuredContent), true); assert.deepEqual(result.details, result.structuredContent); assert.ok(result.content[0].text.length <= 16500); }
test("exact registrations declare strict inputs and outputSchema/structuredContent; session resume/child isolate", async t => {
  const { root } = await setup(t); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); const entries: any[] = [];
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); } };
  registerWebTools(pi as any, { discover: discovery, fetch: async url => fetched(url), store: { root } });
  assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content", "source_check"]);
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id, getBranch: () => entries } });
  await handlers.get("session_start")({}, ctx("parent"));
  const result = await tools.get("fetch_content").execute("call", { url: "https://example.com" }, undefined, undefined, ctx("parent")); satisfies(result, FetchOutput);
  await handlers.get("session_start")({}, ctx("parent")); assert.equal(entries.length, 1);
  const read = await tools.get("get_search_content").execute("read", { responseId: result.structuredContent.responseId, sourceId: result.structuredContent.snapshots[0].id }, undefined, undefined, ctx("parent")); satisfies(read, ReadOutput);
  await assert.rejects(tools.get("get_search_content").execute("read", { responseId: result.structuredContent.responseId }, undefined, undefined, ctx("child")), /outside this session/); assert.equal(entries.length, 2);
  for (const tool of tools.values()) { assert.equal(tool.parameters.additionalProperties, false); assert.ok(tool.outputSchema); }
  await handlers.get("session_shutdown")({});
});
test("breaking legacy/unknown parameters and ambiguous modes fail before any network", async t => {
  let calls = 0; const { store, service } = await setup(t, { discover: async () => { calls++; return { results: [] }; }, fetch: async () => { calls++; return fetched("https://example.com"); } });
  await assert.rejects(service.search({ query: "topic", model: "sonar" }, store), /Legacy synthesis/);
  await assert.rejects(service.search({ query: "topic", queries: ["other"] }, store), /exactly one/);
  await assert.rejects(service.search({ queries: Array(6).fill("x") }, store), /invalid/);
  await assert.rejects(service.search({ query: "x", numResults: 11 }, store), /invalid/);
  await assert.rejects(service.search({ query: "x", domainFilter: ["allowed.com", "-blocked.com"] }, store), /cannot be mixed/);
  await assert.rejects(service.fetchContent({ url: "https://example.com", prompt: "summarize" }, store), /Legacy synthesis/);
  await assert.rejects(service.read({ query: "latest" }, store), /responseId/);
  await assert.rejects(service.check({ claim: "topic" }, store), /No network/);
  await assert.rejects(service.check({ claim: "topic", evidence: ["link"] }, store), /unsupported/);
  assert.equal(calls, 0);
});
test("search maps filters/counts, stores provenance, and preserves partial query successes/usage", async t => {
  const seen: any[] = []; const { store, service } = await setup(t, { discover: async (q: string, o: any) => { seen.push(o); if (q === "bad") throw new Error("Authorization Bearer secret"); return discovery(q, o); } });
  const result = await service.search({ queries: ["good", "bad"], numResults: 2, recencyFilter: "week", domainFilter: ["example.com"] }, store); satisfies(result, SearchOutput);
  const data = result.structuredContent; assert.equal(data.status, "partial"); assert.equal(data.queries.length, 1); assert.equal(data.sources.length, 2); assert.deepEqual(data.queries[0].usage, { searches: 1 }); assert.equal(data.errors.length, 1);
  assert.equal(seen[0].numResults, 2); assert.equal(seen[0].recencyFilter, "week"); assert.deepEqual(seen[0].domainFilter, ["example.com"]); assert.ok(seen[0].signal);
  assert.equal(data.sources[0].provenance, "provider-snippet"); assert.equal("contentHash" in data.sources[0], false); assert.equal("start" in data.sources[0], false); assert.doesNotMatch(JSON.stringify(data), /Bearer secret/);
  const read = await service.read({ responseId: data.responseId, sourceId: data.sources[0].id }, store); assert.equal(read.structuredContent.provenance, "provider-snippet"); assert.ok(read.structuredContent.text.length > data.sources[0].snippet.length);
});
test("malformed normalized discovery and all-failed search/fetch fail loudly; valid empty search is distinct", async t => {
  const { store } = await setup(t);
  for (const response of [{}, { results: [{}] }, { results: [{ id: "1", title: "x", url: "file:///secret", snippet: "x" }] }]) {
    const service = new EvidenceService({ discover: async () => response as any }); await assert.rejects(service.search({ query: "x" }, store), /All.*failed/);
  }
  const empty = new EvidenceService({ discover: async () => ({ results: [] }) }); const result = await empty.search({ query: "x" }, store); assert.equal(result.structuredContent.sources.length, 0); assert.equal(result.structuredContent.status, "complete");
  const failed = new EvidenceService({ fetch: async () => { throw Error("blocked"); } }); await assert.rejects(failed.fetchContent({ urls: ["https://a.com", "https://b.com"] }, store), /All 2 operations failed/);
});
test("includeContent is explicit opt-in and bounded, failures do not erase discovery", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; if (url.includes("/one/0")) throw Error("blocked"); return fetched(url); } });
  const plain = await service.search({ query: "one", numResults: 2 }, store); assert.equal(calls, 0); assert.equal(plain.structuredContent.snapshots.length, 0);
  const included = await service.search({ queries: ["one", "two", "three", "four"], numResults: 2, includeContent: true }, store); satisfies(included, SearchOutput);
  assert.equal(calls, 5); assert.equal(included.structuredContent.sources.length, 8); assert.equal(included.structuredContent.snapshots.length, 4); assert.equal(included.structuredContent.status, "partial"); assert.equal(included.structuredContent.sources.filter((s: any) => s.fetchError === "not-fetched-budget").length, 3);
  const allPagesFail = new EvidenceService({ discover: discovery, fetch: async () => { throw Error("blocked"); } }); const partial = await allPagesFail.search({ query: "one", numResults: 2, includeContent: true }, store); assert.equal(partial.structuredContent.status, "partial"); assert.equal(partial.structuredContent.snapshots.length, 0); assert.equal(partial.structuredContent.errors.length, 2);
});
test("fetch batch preserves successes and exact continuation handles; reads never use network", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; if (url.includes("bad")) throw Error("provider secret"); return fetched(url, "🙂abc".repeat(4000)); } });
  const result = await service.fetchContent({ urls: ["https://good.com", "https://bad.com"] }, store); satisfies(result, FetchOutput); assert.equal(result.structuredContent.status, "partial");
  const metadata = result.structuredContent.snapshots[0]; assert.equal(metadata.preview.length, 4000); assert.equal(metadata.nextOffset, 4000);
  const read = await service.read({ responseId: result.structuredContent.responseId, sourceId: metadata.id, offset: 4000, limit: 100 }, store); satisfies(read, ReadOutput);
  const s = await store.snapshot(metadata.id); assert.equal(read.structuredContent.text, s.text.slice(4000, 4100)); assert.equal(read.structuredContent.contentHash, s.contentHash); assert.equal(calls, 2);
});
test("paging/find/source/query selection and expired stored reads are strict", async t => {
  const { root, store, service } = await setup(t); const search = (await service.search({ queries: ["one", "two"], numResults: 2 }, store)).structuredContent;
  const find = await service.read({ responseId: search.responseId, sourceId: search.sources[0].id, findText: "snippet" }, store); assert.equal(find.structuredContent.found, true);
  const missing = await service.read({ responseId: search.responseId, findText: "zzzz-not-in-artifact" }, store); assert.equal(missing.structuredContent.found, false); assert.equal(missing.structuredContent.text, "");
  const query = await service.read({ responseId: search.responseId, queryIndex: 1 }, store); assert.match(query.structuredContent.text, /two/); assert.doesNotMatch(query.structuredContent.text, /Source one/);
  await assert.rejects(service.read({ responseId: search.responseId, queryIndex: 4 }, store), /existing successful query/);
  await assert.rejects(service.read({ responseId: search.responseId, findText: "x", offset: 0 }, store), /exclusive/);
  await assert.rejects(service.read({ responseId: search.responseId, offset: 1e9 }, store), /exceeds/);
  await assert.rejects(service.read({ responseId: search.responseId, sourceId: search.sources[0].id, queryIndex: 0 }, store), /exclusive/);
  const expired = new EvidenceStore("session", { root, now: () => Date.now() + 4_000_000 }); await assert.rejects(service.read({ responseId: search.responseId }, expired), /expired.*never refetch/i);
});
test("source_check snapshot reuse has no hidden requests, offsets/hashes remain exact, artifact can be reread", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; return fetched(url); } });
  const fetch = await service.fetchContent({ url: "https://example.com" }, store); const checked = await service.check({ claim: "drug treatment improves outcome", responseId: fetch.structuredContent.responseId }, store); satisfies(checked, CheckOutput); assert.equal(calls, 1); assert.equal(checked.structuredContent.status, "unclear");
  for (const p of checked.structuredContent.passages) { const s = await store.snapshot(p.snapshotId); assert.equal(s.text.slice(p.start, p.end), p.text); assert.equal(checked.structuredContent.sources[0].contentHash, s.contentHash); assert.match(p.text, /However, only eligible/); }
  const reread = await service.read({ responseId: checked.structuredContent.responseId }, store); assert.match(reread.structuredContent.text, /drug treatment/); assert.equal(calls, 1);
  const recheck = await service.check({ claim: "unrelated astronomy", responseId: checked.structuredContent.responseId }, store); assert.equal(recheck.structuredContent.status, "missing-evidence"); assert.equal(calls, 1);
});
test("source_check requires unambiguous existing artifact or explicit URLs/queries; snippets have no fabricated evidence", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; return fetched(url); } });
  const searched = await service.search({ query: "topic", numResults: 2 }, store);
  const missing = await service.check({ claim: "treatment outcome", responseId: searched.structuredContent.responseId }, store); assert.equal(missing.structuredContent.status, "missing-evidence"); assert.deepEqual(missing.structuredContent.passages, []); assert.equal(calls, 0);
  await assert.rejects(service.check({ claim: "topic", responseId: searched.structuredContent.responseId, sourceIds: [searched.structuredContent.sources[0].id] }, store), /only a provider snippet/);
  await assert.rejects(service.check({ claim: "topic", responseId: searched.structuredContent.responseId, urls: ["https://example.com"] }, store), /OR explicit/);
  const retrieved = await service.check({ claim: "treatment outcome", queries: ["topic"], urls: ["https://explicit.com"] }, store); satisfies(retrieved, CheckOutput); assert.equal(calls, 3); assert.equal(retrieved.structuredContent.coverage.inspected, 3);
});
test("source_check all retrieval failed is an error; partial retrieval successes explicit", async t => {
  const { store, service } = await setup(t, { fetch: async (url: string) => { if (url.includes("bad")) throw Error("blocked"); return fetched(url); } });
  await assert.rejects(service.check({ claim: "treatment", urls: ["https://bad.com"] }, store), /All 1 operations failed/);
  const result = await service.check({ claim: "treatment outcome", urls: ["https://bad.com", "https://good.com"] }, store); assert.equal(result.structuredContent.coverage.failed, 1); assert.equal(result.structuredContent.coverage.inspected, 1); assert.equal(result.structuredContent.errors.length, 1);
});
test("source_check explicit URL successes survive all discovery queries failing", async t => {
  const { store, service } = await setup(t, { discover: async () => { throw Error("provider offline"); } });
  const result = await service.check({ claim: "drug treatment outcome", queries: ["topic"], urls: ["https://example.com"] }, store);
  satisfies(result, CheckOutput); assert.equal(result.structuredContent.coverage.inspected, 1); assert.equal(result.structuredContent.coverage.failed, 1); assert.equal(result.structuredContent.errors[0].code, "all-failed");
});
test("source selection validates membership and supports selected snapshots from search artifacts", async t => {
  const { store, service } = await setup(t);
  const first = await service.search({ query: "topic", numResults: 2, includeContent: true }, store);
  const second = await service.fetchContent({ url: "https://other.com" }, store);
  await assert.rejects(service.check({ claim: "treatment outcome", responseId: first.structuredContent.responseId, sourceIds: [second.structuredContent.snapshots[0].id] }, store), /not part/);
  const checked = await service.check({ claim: "drug treatment outcome", responseId: first.structuredContent.responseId, sourceIds: [first.structuredContent.sources[0].id] }, store);
  assert.equal(checked.structuredContent.coverage.inspected, 1);
  const snapshotId = first.structuredContent.sources[0].snapshotId;
  const read = await service.read({ responseId: first.structuredContent.responseId, sourceId: snapshotId }, store); assert.equal(read.structuredContent.provenance, "locally-fetched-snapshot");
});
test("duplicate fetch/evidence artifact selectors and stored IDs load each snapshot once", async t => {
  const { store, service } = await setup(t);
  const fetched = await service.fetchContent({ url: "https://example.com" }, store); const id = fetched.structuredContent.snapshots[0].id;
  const repeatedFetch = await store.putArtifact({ kind: "fetch", snapshotIds: [id, id], errors: [] });
  const snapshot = store.snapshot.bind(store); let reads = 0; store.snapshot = async id => { reads++; return snapshot(id); };
  const checked = await service.check({ claim: "drug treatment outcome", responseId: repeatedFetch, sourceIds: Array(50).fill(id) }, store);
  satisfies(checked, CheckOutput); assert.equal(reads, 1); assert.equal(checked.structuredContent.coverage.inspected, 1); assert.equal(checked.structuredContent.sources.length, 1);
  const { schemaVersion: _version, responseId: _response, ...artifact } = checked.structuredContent;
  artifact.snapshotIds = [id, id]; const repeatedEvidence = await store.putArtifact(artifact as any);
  reads = 0; const reused = await service.check({ claim: "drug treatment outcome", responseId: repeatedEvidence, sourceIds: [id, id] }, store);
  assert.equal(reads, 1); assert.equal(reused.structuredContent.coverage.inspected, 1); assert.equal(reused.structuredContent.passages.length, checked.structuredContent.passages.length);
  reads = 0; await service.check({ claim: "drug treatment outcome", responseId: repeatedEvidence }, store); assert.equal(reads, 1);
});
test("partial fetch gaps survive whole-artifact and evidence reuse, not selected successful subsets", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; if (url.includes("bad")) throw Error("blocked"); return fetched(url); } });
  const fetch = await service.fetchContent({ urls: ["https://good.com", "https://bad.com"] }, store);
  const reused = await service.check({ claim: "drug treatment outcome", responseId: fetch.structuredContent.responseId }, store);
  satisfies(reused, CheckOutput); assert.equal(reused.structuredContent.coverage.inspected, 1); assert.equal(reused.structuredContent.coverage.failed, 1);
  assert.equal(reused.structuredContent.errors[0].responseId, fetch.structuredContent.responseId); assert.equal(reused.structuredContent.errors[0].stage, "fetch");
  const again = await service.check({ claim: "drug treatment outcome", responseId: reused.structuredContent.responseId }, store);
  assert.deepEqual(again.structuredContent.errors, reused.structuredContent.errors); assert.equal(again.structuredContent.coverage.failed, 1);
  const id = fetch.structuredContent.snapshots[0].id;
  for (const responseId of [fetch.structuredContent.responseId, reused.structuredContent.responseId]) {
    const selected = await service.check({ claim: "drug treatment outcome", responseId, sourceIds: [id] }, store);
    assert.deepEqual(selected.structuredContent.errors, []); assert.equal(selected.structuredContent.coverage.failed, 0);
  }
  assert.equal(calls, 2);
});
test("includeContent failures/omissions and uninspected snippets remain visible on source_check reuse", async t => {
  let calls = 0; const { store, service } = await setup(t, { fetch: async (url: string) => { calls++; if (url.includes("/one/0")) throw Error("blocked"); return fetched(url); }, discover: async (q: string, opts: any) => { if (q === "bad") throw Error("query failed"); return discovery(q, opts); } });
  const search = await service.search({ queries: ["one", "two", "three", "four", "bad"], numResults: 2, includeContent: true }, store);
  const reused = await service.check({ claim: "drug treatment outcome", responseId: search.structuredContent.responseId }, store);
  satisfies(reused, CheckOutput); assert.equal(calls, 5); assert.equal(reused.structuredContent.coverage.inspected, 4); assert.equal(reused.structuredContent.coverage.failed, 5);
  assert.equal(reused.structuredContent.errors.filter((e: any) => e.stage === "discovery").length, 1);
  assert.equal(reused.structuredContent.errors.filter((e: any) => e.code === "not-fetched-budget").length, 3);
  const failed = search.structuredContent.sources[0]; assert.equal(reused.structuredContent.errors.filter((e: any) => e.sourceId === failed.id).length, 1);
  const selectedSource = search.structuredContent.sources.find((s: any) => s.snapshotId);
  const selected = await service.check({ claim: "drug treatment outcome", responseId: search.structuredContent.responseId, sourceIds: [selectedSource.id] }, store);
  assert.equal(selected.structuredContent.coverage.inspected, 1); assert.deepEqual(selected.structuredContent.errors, []); assert.equal(calls, 5);
  const snippets = await service.search({ query: "one", numResults: 2 }, store);
  const gap = await service.check({ claim: "drug treatment outcome", responseId: snippets.structuredContent.responseId }, store);
  assert.equal(gap.structuredContent.status, "missing-evidence"); assert.equal(gap.structuredContent.coverage.failed, 2); assert.ok(gap.structuredContent.errors.every((e: any) => e.code === "uninspected-source")); assert.equal(calls, 5);
});
test("source_check discovery usage/handle persist and remain accessible through stored reads and reuse", async t => {
  let queries = 0; const { store, service } = await setup(t, { discover: async (q: string, opts: any) => { queries++; return discovery(q, opts); } });
  const checked = await service.check({ claim: "drug treatment outcome", queries: ["topic"] }, store); satisfies(checked, CheckOutput);
  const trace = checked.structuredContent.discovery; assert.equal(trace.activity, "performed"); assert.ok(trace.responseId); assert.ok(checked.content[0].text.indexOf(trace.responseId) < 1000); assert.equal(trace.queries[0].usageStatus, "reported"); assert.deepEqual(trace.queries[0].usage, { searches: 1 });
  assert.deepEqual(((await store.get(checked.structuredContent.responseId)).data as any).discovery, trace);
  const read = await service.read({ responseId: checked.structuredContent.responseId, findText: '"discovery"' }, store); satisfies(read, ReadOutput); assert.match(read.structuredContent.text, /searches/); assert.match(read.structuredContent.text, new RegExp(trace.responseId));
  const searchRead = await service.read({ responseId: trace.responseId, queryIndex: 0 }, store); assert.match(searchRead.structuredContent.text, /Provider snippet/);
  const again = await service.check({ claim: "drug treatment outcome", responseId: checked.structuredContent.responseId }, store); assert.equal(again.structuredContent.discovery.activity, "reused"); assert.deepEqual(again.structuredContent.discovery.queries, trace.queries); assert.equal(queries, 1);
});
test("absent/failed discovery usage is unknown, never invented zero cost", async t => {
  const { store, service } = await setup(t, { discover: async (q: string, opts: any) => { if (q === "bad") throw Error("offline"); const result = await discovery(q, opts); delete result.usage; return result; } });
  const checked = await service.check({ claim: "drug treatment outcome", queries: ["good", "bad"] }, store);
  satisfies(checked, CheckOutput); assert.equal(checked.structuredContent.discovery.queries.length, 2);
  assert.ok(checked.structuredContent.discovery.queries.every((q: any) => q.usageStatus === "unknown" && !("usage" in q)));
  const partial = await service.check({ claim: "drug treatment outcome", queries: ["bad"], urls: ["https://good.com"] }, store);
  assert.equal(partial.structuredContent.discovery.responseId, undefined); assert.equal(partial.structuredContent.discovery.queries[0].usageStatus, "unknown"); assert.equal(partial.structuredContent.discovery.activity, "performed");
});
test("reused partial search retains failed queries in discovery provenance with unknown usage", async t => {
  const { store, service } = await setup(t, { discover: async (q: string, opts: any) => { if (q === "failed-query") throw Error("offline"); return discovery(q, opts); } });
  const search = await service.search({ queries: ["successful-query", "failed-query"] }, store); satisfies(search, SearchOutput);
  assert.equal(search.structuredContent.status, "partial");
  assert.deepEqual(search.structuredContent.attempts, [{ query: "successful-query", index: 0 }, { query: "failed-query", index: 1 }]);
  assert.equal(search.structuredContent.queries.length, 1); assert.equal(search.structuredContent.errors[0].index, 1);
  const reused = await service.check({ claim: "drug treatment outcome", responseId: search.structuredContent.responseId }, store); satisfies(reused, CheckOutput);
  const trace = reused.structuredContent.discovery;
  assert.equal(trace.activity, "reused"); assert.equal(trace.responseId, search.structuredContent.responseId);
  assert.deepEqual(trace.queries.map((q: any) => [q.query, q.index, q.usageStatus]), [["successful-query", 0, "reported"], ["failed-query", 1, "unknown"]]);
  assert.equal("usage" in trace.queries[1], false);
  assert.ok(reused.structuredContent.errors.some((e: any) => e.stage === "discovery" && e.index === 1));
  const reread = await service.read({ responseId: reused.structuredContent.responseId }, store); assert.match(reread.structuredContent.text, /failed-query/);
  const again = await service.check({ claim: "drug treatment outcome", responseId: reused.structuredContent.responseId }, store);
  assert.deepEqual(again.structuredContent.discovery.queries, trace.queries);
  await assert.rejects(service.read({ responseId: search.structuredContent.responseId, queryIndex: 1 }, store), /existing successful query/);
  const ok = await service.read({ responseId: search.structuredContent.responseId, queryIndex: 0 }, store); assert.match(ok.structuredContent.text, /successful-query/);
});
test("old search artifacts without attempts keep successful-only discovery provenance without fabricated text", async t => {
  const { store, service } = await setup(t, { discover: async (q: string, opts: any) => { if (q === "bad") throw Error("offline"); return discovery(q, opts); } });
  const search = await service.search({ queries: ["good", "bad"] }, store); satisfies(search, SearchOutput);
  const record = await store.get(search.structuredContent.responseId); const legacy = JSON.parse(JSON.stringify(record.data)) as any;
  delete legacy.attempts;
  const legacyId = await store.putArtifact(legacy);
  const reused = await service.check({ claim: "drug treatment outcome", responseId: legacyId }, store); satisfies(reused, CheckOutput);
  assert.deepEqual(reused.structuredContent.discovery.queries.map((q: any) => [q.index, q.usageStatus]), [[0, "reported"]]);
});
test("service cancellation threads through snapshot cache lock waits without evicting", async t => {
  const { root, service } = await setup(t); const store = new EvidenceStore("session", { root, hostRecords: 1 });
  const existing = await store.putSnapshot(fetched("https://existing.com")); const lock = join(root, ".write-lock"); await mkdir(lock);
  const c = new AbortController(); const operation = service.fetchContent({ url: "https://new.com" }, store, c.signal);
  await new Promise(resolve => setTimeout(resolve, 40)); c.abort(); await assert.rejects(operation, { name: "AbortError" });
  await rm(lock, { recursive: true }); await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(await readdir(store.directory), [`${existing.id}.json`]); await store.snapshot(existing.id);
});
test("three-operation global service gate covers concurrent tools and cancellation removes queued work", async t => {
  let active = 0, max = 0; const operation = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; };
  const { store, service } = await setup(t, { fetch: async (url: string) => { await operation(); return fetched(url); }, discover: async (q: string, o: any) => { await operation(); return discovery(q, o); } });
  await Promise.all([service.fetchContent({ urls: Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`) }, store), service.search({ queries: ["one", "two", "three", "four", "five"] }, store)]); assert.equal(max, 3);
  const gate = new OperationGate(); const waiters: Array<() => void> = []; const running = Array.from({ length: 3 }, () => gate.run(undefined, () => new Promise<void>(resolve => waiters.push(resolve)))); const controller = new AbortController(); const queued = gate.run(controller.signal, async () => { throw Error("must not execute"); }); controller.abort(); await assert.rejects(queued, { name: "AbortError" }); waiters.forEach(resolve => resolve()); await Promise.all(running);
});
test("abort stays cancellation for search/fetch/check/read and does not return missing evidence", async t => {
  const { store, service } = await setup(t); const c = new AbortController(); c.abort();
  await assert.rejects(service.search({ query: "topic" }, store, c.signal), { name: "AbortError" });
  await assert.rejects(service.fetchContent({ url: "https://example.com" }, store, c.signal), { name: "AbortError" });
  await assert.rejects(service.check({ claim: "topic", urls: ["https://example.com"] }, store, c.signal), { name: "AbortError" });
});
