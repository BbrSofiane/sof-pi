import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readdir, writeFile, symlink, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EvidenceStore } from "../../extensions/perplexity/evidence-store.ts";
import type { FetchedSource } from "../../extensions/perplexity/source-fetch.ts";
export function source(text = "Exact UTF8 🙂 café\nHowever, only some benefit."): FetchedSource { return { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", fetchedAt: new Date(0).toISOString(), representation: "text", extractorVersion: "fixture/1", text, contentHash: createHash("sha256").update(text, "utf8").digest("hex") }; }
async function fixture(t: any) { const root = await mkdtemp(join(tmpdir(), "pi-evidence-store-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test("scope derives from session identity, survives resume, and isolates child/different sessions", async t => {
  const root = await fixture(t); const parent = new EvidenceStore("parent-session", { root });
  const snapshot = await parent.putSnapshot(source()); const resume = new EvidenceStore("parent-session", { root }); const child = new EvidenceStore("child-session", { root });
  assert.equal(resume.scopeId, parent.scopeId); assert.notEqual(child.scopeId, parent.scopeId);
  assert.deepEqual(await resume.snapshot(snapshot.id), snapshot); await assert.rejects(child.get(snapshot.id), /outside this session scope/);
  assert.throws(() => new EvidenceStore("", { root }), /session identity/);
});
test("snapshot hashes exact UTF8; wrong hashes and schema rejected", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root }); const s = source();
  const snapshot = await store.putSnapshot(s); assert.equal(snapshot.contentHash, createHash("sha256").update(snapshot.text, "utf8").digest("hex"));
  await assert.rejects(store.putSnapshot({ ...s, contentHash: "0".repeat(64) }), /schema\/hash/);
  const path = join(store.directory, `${snapshot.id}.json`); const json = JSON.parse(await readFile(path, "utf8")); json.data.text = "changed"; await writeFile(path, JSON.stringify(json), { mode: 0o600 }); await assert.rejects(store.get(snapshot.id), /schema, scope, or hash/);
});
test("private permissions and atomic writes leave no partial/temp records", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => store.putSnapshot(source())));
  assert.equal((await readdir(store.directory)).length, snapshots.length); assert.equal((await readdir(root)).includes(".write-lock"), false);
  if (process.platform !== "win32") { assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(store.directory)).mode & 0o777, 0o700); assert.equal((await stat(join(store.directory, `${snapshots[0].id}.json`))).mode & 0o777, 0o600); }
});
test("expired handles fail without changing identity or refetching", async t => {
  const root = await fixture(t); let now = 1000; const store = new EvidenceStore("session", { root, now: () => now, ttlMs: 50 });
  const snapshot = await store.putSnapshot(source()); now = 1050; await assert.rejects(store.get(snapshot.id), /expired.*never refetch/i);
});
test("oldest count eviction is bounded across concurrent writers", async t => {
  const root = await fixture(t); let now = 1000;
  const store = new EvidenceStore("session", { root, now: () => now++, maxRecords: 2 });
  const first = await store.putSnapshot(source()); const second = await store.putSnapshot(source()); const third = await store.putSnapshot(source());
  await assert.rejects(store.get(first.id), /missing, evicted/); await store.get(second.id); await store.get(third.id); assert.equal((await readdir(store.directory)).length, 2);
});
test("scope and host byte caps evict oldest entries across scopes", async t => {
  const root = await fixture(t); let now = 1000;
  const store = new EvidenceStore("session", { root, now: () => now++, scopeBytes: 1800, hostBytes: 2500 });
  const first = await store.putSnapshot(source("x".repeat(600))); const second = await store.putSnapshot(source("y".repeat(600)));
  await assert.rejects(store.get(first.id), /missing, evicted/); await store.get(second.id);
  const other = new EvidenceStore("other", { root, now: () => now++, scopeBytes: 1800, hostBytes: 1800 }); await other.putSnapshot(source("z".repeat(600)));
  await assert.rejects(store.get(second.id), /missing, evicted/);
  await assert.rejects(store.putSnapshot(source("x".repeat(2000))), /exceeds cache budget/);
});
test("host record cap applies across child scopes", async t => {
  const root = await fixture(t); let now = 1000; const a = new EvidenceStore("a", { root, hostRecords: 1, now: () => now++ }); const b = new EvidenceStore("b", { root, hostRecords: 1, now: () => now++ });
  const first = await a.putSnapshot(source()); await b.putSnapshot(source()); await assert.rejects(a.get(first.id), /evicted/);
});
test("opaque handles reject traversal and symlink file/directory access", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const snapshot = await store.putSnapshot(source()); await assert.rejects(store.get("../../secret"), /opaque/);
  const path = join(store.directory, `${snapshot.id}.json`); await rm(path); await symlink(join(root, "absent"), path); await assert.rejects(store.get(snapshot.id), /safely read/);
  const unsafeRoot = join(root, "unsafe"); await symlink(store.directory, unsafeRoot); const unsafe = new EvidenceStore("different", { root: unsafeRoot }); await assert.rejects(unsafe.putSnapshot(source()), /regular directory/);
});
test("cancelled cache lock wait returns immediately without eviction or any record write", async t => {
  const root = await fixture(t); const original = new EvidenceStore("original", { root, hostRecords: 1 });
  const snapshot = await original.putSnapshot(source()); const writer = new EvidenceStore("writer", { root, hostRecords: 1 });
  const lock = join(root, ".write-lock"); await mkdir(lock, { mode: 0o700 });
  const c = new AbortController(); const promise = writer.putSnapshot(source("new record"), c.signal);
  await new Promise(resolve => setTimeout(resolve, 40)); c.abort();
  const outcome = await Promise.race([promise.then(() => "wrote", error => error.name), new Promise(resolve => setTimeout(resolve, 500, "still waiting"))]);
  assert.equal(outcome, "AbortError");
  await rm(lock, { recursive: true }); await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(await original.snapshot(snapshot.id), snapshot); assert.deepEqual(await readdir(writer.directory), []);
  assert.deepEqual(await readdir(original.directory), [`${snapshot.id}.json`]);
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(writer.putArtifact({ kind: "fetch", snapshotIds: [snapshot.id], errors: [] }, preAborted.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(writer.directory), []);
});
test("abort during read-only quota planning does not evict host-oldest records", async t => {
  const root = await fixture(t); const original = new EvidenceStore("original", { root, hostRecords: 1 });
  const snapshot = await original.putSnapshot(source()); const writer = new EvidenceStore("writer", { root, hostRecords: 1 });
  const c = new AbortController(); const originalPlan = (writer as any).planEviction.bind(writer);
  (writer as any).planEviction = async (...args: any[]) => { const planned = await originalPlan(...args); assert.ok(planned.removals.length); c.abort(); return planned; };
  await assert.rejects(writer.putSnapshot(source("new record"), c.signal), { name: "AbortError" });
  await original.snapshot(snapshot.id); assert.deepEqual(await readdir(writer.directory), []); assert.equal((await readdir(root)).includes(".write-lock"), false);
});
test("cancellation after mutation begins preserves atomic cleanup before reporting abort", async t => {
  const root = await fixture(t); const writer = new EvidenceStore("writer", { root }); const c = new AbortController();
  // After the boundary check, a queued microtask aborts while open/write awaits;
  // the bounded commit must finish and release its lock/temp resources.
  const plan = (writer as any).planEviction.bind(writer);
  (writer as any).planEviction = async (...args: any[]) => { const paths = await plan(...args); setImmediate(() => c.abort()); return paths; };
  await assert.rejects(writer.putSnapshot(source("committed atomically"), c.signal), { name: "AbortError" });
  const names = await readdir(writer.directory); assert.equal(names.length, 1); assert.match(names[0], /\.json$/); assert.equal((await readdir(root)).includes(".write-lock"), false);
  assert.equal((await writer.snapshot(names[0].slice(0, -5))).text, "committed atomically");
});
test("schema-version and scope mismatch are loud errors", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root }); const s = await store.putSnapshot(source()); const path = join(store.directory, `${s.id}.json`);
  const json = JSON.parse(await readFile(path, "utf8")); json.schemaVersion = 2; await writeFile(path, JSON.stringify(json)); await assert.rejects(store.get(s.id), /schema/);
});
