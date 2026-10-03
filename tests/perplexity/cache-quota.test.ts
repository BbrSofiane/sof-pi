import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, unlink, mkdir, stat as statFile, chmod as chmodFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EvidenceStore, recordReadInstrumentation, QUOTA_METADATA_NAME, METADATA_MAX_RECORDS } from "../../extensions/perplexity/evidence-store.ts";
import type { FetchedSource } from "../../extensions/perplexity/source-fetch.ts";
export function source(text = "Exact UTF8 🙂 café\nHowever, only some benefit."): FetchedSource { return { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", fetchedAt: new Date(0).toISOString(), representation: "text", extractorVersion: "fixture/1", text, contentHash: createHash("sha256").update(text, "utf8").digest("hex") }; }
async function fixture(t: any) { const root = await mkdtemp(join(tmpdir(), "pi-cache-quota-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const metadata = (root: string) => join(root, QUOTA_METADATA_NAME);

test("warmed small-artifact insert reads only quota metadata, never unrelated record payloads", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const big = source("p".repeat(96 * 1024));
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => store.putSnapshot(big)));
  recordReadInstrumentation.reads = 0; recordReadInstrumentation.bytes = 0;
  // Warmed insert: planning must not reread or rehash any of the six ~96KiB
  // payloads; only the compact quota metadata file may be read.
  await store.putArtifact({ kind: "fetch", snapshotIds: [snapshots[0].id], errors: [] });
  assert.equal(recordReadInstrumentation.reads, 1);
  assert.ok(recordReadInstrumentation.bytes < 8192);
  // Contrast: an actual record read performs exactly one full payload read.
  const before = { ...recordReadInstrumentation };
  const loaded = await store.snapshot(snapshots[1].id);
  assert.equal(loaded.text.length, 96 * 1024);
  assert.equal(recordReadInstrumentation.reads - before.reads, 1);
  assert.ok(recordReadInstrumentation.bytes - before.bytes > 90_000);
  // The counter itself detects full scans: after removing the metadata (legacy
  // cache) the next insert performs the one-time rebuild, reading every record.
  await rm(metadata(root));
  recordReadInstrumentation.reads = 0; recordReadInstrumentation.bytes = 0;
  await store.putArtifact({ kind: "fetch", snapshotIds: [snapshots[0].id], errors: [] });
  assert.equal(recordReadInstrumentation.reads, 7); // 6 snapshots + 1 artifact
});

test("legacy cache without quota metadata migrates lazily once, preserving ids and content", async t => {
  const root = await fixture(t); const store = new EvidenceStore("legacy-session", { root });
  const first = await store.putSnapshot(source("legacy first")); const second = await store.putSnapshot(source("legacy second"));
  await rm(metadata(root)); // simulate a pre-metadata (legacy) cache
  const third = await store.putSnapshot(source("post-migration"));
  assert.deepEqual(await store.snapshot(first.id), await store.snapshot(first.id));
  const migrated = await store.snapshot(first.id); assert.equal(migrated.text, "legacy first"); assert.equal(migrated.id, first.id);
  const kept = await store.snapshot(second.id); assert.equal(kept.id, second.id); assert.equal(kept.text, "legacy second");
  await store.get(third.id);
  const index = JSON.parse(await readFile(metadata(root), "utf8"));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(new Set(index.records.map((r: any) => r.id)), new Set([first.id, second.id, third.id]));
  // Migration is once: the following insert is warm and reads no payloads.
  recordReadInstrumentation.reads = 0; recordReadInstrumentation.bytes = 0;
  await store.putArtifact({ kind: "fetch", snapshotIds: [third.id], errors: [] });
  assert.equal(recordReadInstrumentation.reads, 1); // metadata only
});

test("crash between record commit and metadata write recovers by explicit rebuild without quota bypass", async t => {
  const root = await fixture(t);
  const a = new EvidenceStore("a", { root, hostRecords: 2 }); const b = new EvidenceStore("b", { root, hostRecords: 2 });
  const first = await a.putSnapshot(source("a1"));
  const stale = await readFile(metadata(root), "utf8"); // index knows only `first`
  const foreign = await b.putSnapshot(source("b1")); // old-writer/crash divergence: unindexed record
  await writeFile(metadata(root), stale, { mode: 0o600 });
  const next = await a.putSnapshot(source("a2")); // rebuild sees both records, then evicts oldest
  await assert.rejects(a.get(first.id), /missing, evicted/);
  await b.get(foreign.id); await a.get(next.id);
  const total = (await readdir(a.directory)).length + (await readdir(b.directory)).length;
  assert.equal(total, 2); // rebuilt divergence was counted, quota enforced, no bypass
  assert.equal((await readdir(root)).includes(".write-lock"), false);
});

test("record file missing but still indexed is dropped without failing the writer", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root, hostRecords: 2 });
  const first = await store.putSnapshot(source("vanishes"));
  await unlink(join(store.directory, `${first.id}.json`)); // crashed eviction between unlink and metadata update
  const second = await store.putSnapshot(source("survives"));
  await store.get(second.id);
  await assert.rejects(store.get(first.id), /missing, evicted/);
  const index = JSON.parse(await readFile(metadata(root), "utf8"));
  assert.deepEqual(index.records.map((r: any) => r.id), [second.id]);
});

test("payload/metadata size divergence fails loudly, never bypasses quota, and recovers", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const first = await store.putSnapshot(source("original"));
  const path = join(store.directory, `${first.id}.json`);
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.createdAt = 12345678901234; tampered.expiresAt = 12345678909999; // valid schema, different size
  await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /diverges from quota metadata/);
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) }), { mode: 0o600 }); // keep divergence
  await rm(metadata(root)); // operator removes the diverged index after inspection
  const second = await store.putSnapshot(source("after rebuild"));
  await store.get(first.id); await store.get(second.id); // full read validation still applies
});

test("quota metadata write failure removes the just-written record and a fresh writer recovers", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root, hostRecords: 2 });
  const kept = await store.putSnapshot(source("kept"));
  const originalWrite = (store as any).writeIndex.bind(store);
  (store as any).writeIndex = async () => { throw new Error("simulated quota metadata failure"); };
  await assert.rejects(store.putSnapshot(source("must not persist")), /simulated quota metadata failure/);
  (store as any).writeIndex = originalWrite;
  assert.deepEqual(await store.snapshot(kept.id), kept); // prior state untouched
  assert.equal((await readdir(store.directory)).length, 1); // failed record removed, no divergence left
  assert.equal((await readdir(root)).includes(".write-lock"), false);
  const second = await store.putSnapshot(source("recovers")); await store.get(second.id);
  // A fresh instance (no shared memory) honors the persisted metadata: it
  // evicts the oldest record under the shared host cap.
  const fresh = new EvidenceStore("fresh-writer", { root, hostRecords: 2 });
  await fresh.putSnapshot(source("fresh"));
  await assert.rejects(store.get(kept.id), /missing, evicted/);
  await store.get(second.id);
});

test("corrupt or foreign-version quota metadata fails loudly; reads stay available; removal rebuilds", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const first = await store.putSnapshot(source("readable"));
  await writeFile(metadata(root), "{not json", { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /quota metadata is corrupt/);
  await assert.rejects(store.putSnapshot(source("rejected again")), /quota metadata is corrupt/);
  await store.get(first.id); // actual reads unaffected by index corruption
  await writeFile(metadata(root), JSON.stringify({ schemaVersion: 2, records: [] }), { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /schema validation/);
  await rm(metadata(root));
  const second = await store.putSnapshot(source("after removal"));
  await store.get(first.id); await store.get(second.id);
});

test("allowed-capacity concurrent writers all succeed without cache-busy", async t => {
  const root = await fixture(t);
  const options = { hostRecords: 64, hostBytes: 8 * 1024 * 1024, scopeBytes: 1024 * 1024 };
  const seedStore = new EvidenceStore("seed", { root, ...options });
  const seeded = await Promise.all(Array.from({ length: 56 }, () => seedStore.putSnapshot(source("s".repeat(8 * 1024)))));
  const writers = Array.from({ length: 8 }, (_, i) => new EvidenceStore(`writer-${i}`, { root, ...options }));
  const results = await Promise.allSettled(writers.map(writer => writer.putSnapshot(source("w".repeat(4 * 1024)))));
  const failures = results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason);
  assert.deepEqual(failures, []); // no cache-busy, no timeout at allowed capacity
  const index = JSON.parse(await readFile(metadata(root), "utf8"));
  assert.ok(index.records.length <= 64);
  assert.ok(index.records.length >= 57);
  await seedStore.get(seeded[seeded.length - 1].id); // a seeded record survives; capacity was available
});

test("quota metadata stays root-private, compact, outside scope listings, and never contains payload text", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const secret = "private-payload-text-https://example.com/secret";
  const snapshot = await store.putSnapshot(source(secret));
  const names = await readdir(store.directory);
  assert.deepEqual(names, [`${snapshot.id}.json`]); // scope listing shows only records
  const raw = await readFile(metadata(root), "utf8");
  assert.ok(!raw.includes(secret) && !raw.includes("https://")); // no payload text or URLs in metadata
  const index = JSON.parse(raw);
  assert.equal(index.schemaVersion, 1);
  assert.ok(index.records.length <= METADATA_MAX_RECORDS);
  assert.ok((await statFile(metadata(root))).size < 2 * 1024 * 1024);
  if (process.platform !== "win32") assert.equal((await statFile(metadata(root))).mode & 0o777, 0o600);
});

test("oversized whitespace-padded quota metadata is rejected on the opened file before reading or rewriting", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const first = await store.putSnapshot(source("kept"));
  const path = metadata(root); const original = await readFile(path, "utf8");
  // Otherwise-valid index, padded with whitespace (still parseable JSON) past
  // the 2MiB metadata budget.
  const padded = original + " ".repeat(3 * 1024 * 1024);
  await writeFile(path, padded, { mode: 0o600 });
  recordReadInstrumentation.reads = 0; recordReadInstrumentation.bytes = 0;
  await assert.rejects(store.putSnapshot(source("rejected")), /unsafe or exceeds its size budget/);
  assert.equal(recordReadInstrumentation.reads, 0); // rejected before any content read
  assert.equal(await readFile(path, "utf8"), padded); // index not silently rewritten/compacted
  await store.get(first.id); // physical record and handle preserved
});

test("duplicate metadata record identities reject insertion without deleting the physical record", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root, maxRecords: 2 });
  const first = await store.putSnapshot(source("only physical record"));
  const index = JSON.parse(await readFile(metadata(root), "utf8"));
  index.records.push({ ...index.records[0] }); // same (scope, id) indexed twice
  await writeFile(metadata(root), JSON.stringify(index), { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /duplicate record identities/);
  await store.get(first.id); // existing record and handle preserved despite maxRecords: 2
  assert.deepEqual(await readdir(store.directory), [`${first.id}.json`]);
});

test("malformed metadata expiry equal to creation rejects without evicting the valid unexpired record", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const first = await store.putSnapshot(source("valid unexpired"));
  const index = JSON.parse(await readFile(metadata(root), "utf8"));
  index.records[0].expiresAt = index.records[0].createdAt; // corrupt relationship validRecord forbids
  await writeFile(metadata(root), JSON.stringify(index), { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /expiry is not after its creation/);
  await store.get(first.id); // not silently deleted by destructive recovery
  assert.deepEqual(await readdir(store.directory), [`${first.id}.json`]);
});

test("warm planning rejects a 0644 indexed record stat-only, without reloading payloads or deleting it", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const first = await store.putSnapshot(source("kept"));
  if (process.platform === "win32") return; // POSIX-only permission gate
  await chmodFile(join(store.directory, `${first.id}.json`), 0o644);
  recordReadInstrumentation.reads = 0; recordReadInstrumentation.bytes = 0;
  await assert.rejects(store.putSnapshot(source("rejected")), /unsafe/);
  assert.equal(recordReadInstrumentation.reads, 1); // only quota metadata; payload never reloaded
  assert.ok(await statFile(join(store.directory, `${first.id}.json`))); // original record untouched
});

test("metadata entry count bound fails loudly instead of growing without bound", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const overflow = { schemaVersion: 1, records: Array.from({ length: METADATA_MAX_RECORDS + 1 }, () => ({ id: randomUUID(), scope: store.scopeId, bytes: 1, createdAt: 1, expiresAt: 2 })) };
  await writeFile(metadata(root), JSON.stringify(overflow), { mode: 0o600 });
  await assert.rejects(store.putSnapshot(source("rejected")), /quota metadata/);
});

const quotaTemps = async (root: string) => (await readdir(root)).filter(n => n.startsWith(".tmp-quota-"));

// Real inner-filesystem fault: the quota temporary is genuinely opened,
// written and fsynced by the production code, then the host root loses write
// permission immediately before the actual rename (rename/unlink then fail
// with EACCES while the incoming-record rollback still succeeds). Only the
// rename interception is injected; all monkeypatches are restored in finally.
test("warm recovery cleans a quota temporary stranded by a real rename/unlink EACCES failure with a valid index", async t => {
  if (process.platform === "win32") return; // POSIX-only permission fault
  const root = await fixture(t);
  const fault = new EvidenceStore("fault-writer", { root });
  const recovered = new EvidenceStore("recovered-writer", { root });
  const seed = await fault.putSnapshot(source("seed valid index"));
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (a: any, b: any) => {
    if (b === metadata(root)) await chmodFile(root, 0o500);
    return originalRename(a, b);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(fault.putSnapshot(source("rolled back")), (e: any) => e.code === "EACCES");
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
    await chmodFile(root, 0o700); // restore so cleanup/inspection can proceed
  }
  // Handled inner failure: incoming record rolled back (only the seeded
  // record remains), its own temporary cleanup failed (EACCES, not ENOENT),
  // and the host lock was left behind.
  assert.deepEqual(await readdir(fault.directory), [`${seed.id}.json`]);
  const stranded = await quotaTemps(root);
  assert.equal(stranded.length, 1);
  assert.equal((await readdir(root)).includes(".write-lock"), true);
  // Documented operator recovery: stop writers, remove the stopped lock.
  await rm(join(root, ".write-lock"), { recursive: true, force: true });
  // The next warm insert succeeds against the still-valid index AND cleans
  // the previously stranded quota temporary.
  const next = await recovered.putSnapshot(source("after recovery"));
  await recovered.get(next.id);
  assert.deepEqual(await quotaTemps(root), []);
  assert.equal((await readdir(root)).includes(".write-lock"), false);
  // Repeated warm calls leak neither temporaries nor the lock.
  await recovered.putArtifact({ kind: "fetch", snapshotIds: [next.id], errors: [] });
  assert.deepEqual(await quotaTemps(root), []);
  assert.equal((await readdir(root)).includes(".write-lock"), false);
});

test("warm cleanup removes only validated root quota temporaries and retains unrelated or malformed names", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const kept = await store.putSnapshot(source("kept"));
  const stranded = `.tmp-quota-${randomUUID()}`;
  await writeFile(join(root, stranded), "{}", { mode: 0o600 }); // valid UUID: must be cleaned
  const retainedNames = [".tmp-quota-not-a-uuid", `.tmp-quota-${randomUUID()}.json`, ".tmp-quota-extra-suffix", "unrelated-notes.txt"];
  for (const name of retainedNames) await writeFile(join(root, name), "x", { mode: 0o600 });
  await writeFile(join(store.directory, `.tmp-${randomUUID()}`), "x", { mode: 0o600 }); // scope-level record temp still cleaned too
  const next = await store.putSnapshot(source("next"));
  const names = await readdir(root);
  assert.equal(names.includes(stranded), false); // only the valid UUID temporary was removed
  for (const name of retainedNames) assert.equal(names.includes(name), true, name);
  assert.deepEqual(await readdir(store.directory).then(n => n.sort()), [`${kept.id}.json`, `${next.id}.json`].sort());
  assert.equal(names.includes(".write-lock"), false);
});

test("cancellation before removal leaves a stranded quota temporary untouched until an un-aborted write", async t => {
  const root = await fixture(t); const store = new EvidenceStore("session", { root });
  const seeded = await store.putSnapshot(source("seed"));
  const stranded = join(root, `.tmp-quota-${randomUUID()}`);
  await writeFile(stranded, "{}", { mode: 0o600 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.putSnapshot(source("cancelled"), controller.signal));
  assert.ok(await statFile(stranded)); // untouched by the cancelled write
  const next = await store.putSnapshot(source("un-aborted")); // cleanup only on a real write
  assert.deepEqual(await quotaTemps(root), []);
  await store.get(seeded.id); await store.get(next.id);
});

test("rebuild triggered from a warm scan keeps stranded quota temporaries deduplicated so cleanup never double-unlinks", async t => {
  const root = await fixture(t);
  const a = new EvidenceStore("a", { root }); const b = new EvidenceStore("b", { root });
  const first = await a.putSnapshot(source("a1"));
  const stale = await readFile(metadata(root), "utf8");
  await b.putSnapshot(source("b1")); // unindexed divergence on disk
  await writeFile(metadata(root), stale, { mode: 0o600 });
  await writeFile(join(root, `.tmp-quota-${randomUUID()}`), "{}", { mode: 0o600 }); // stranded quota temporary
  // Warm scan collects the temporary, detects the unindexed record, rebuilds
  // (which collects the same temporary again): deduped removals must unlink
  // it exactly once and the write must succeed without ENOENT.
  const next = await a.putSnapshot(source("a2"));
  assert.deepEqual(await quotaTemps(root), []);
  await a.get(next.id);
  assert.equal((await readdir(root)).includes(".write-lock"), false);
});
