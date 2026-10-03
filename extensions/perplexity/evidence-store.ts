import { constants } from "node:fs";
import { mkdir, lstat, chmod, open, readdir, rename, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { EvidenceError, IdSchema, ArtifactSchema, cancelled } from "./contracts.ts";
import type { Artifact, SourceSnapshot } from "./contracts.ts";
import type { FetchedSource } from "./source-fetch.ts";

export const CACHE_POLICY = Object.freeze({ ttlMs: 3_600_000, maxRecords: 128, scopeBytes: 64 * 1024 * 1024, hostBytes: 512 * 1024 * 1024, hostRecords: 2048, recordBytes: 16 * 1024 * 1024 });
export interface StoreOptions { root?: string; ttlMs?: number; maxRecords?: number; scopeBytes?: number; hostBytes?: number; hostRecords?: number; now?: () => number }
export interface StoredRecord { schemaVersion: 1; id: string; scopeId: string; createdAt: number; expiresAt: number; kind: "snapshot" | "artifact"; data: SourceSnapshot | Artifact }
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const RecordSchema = Type.Object({ schemaVersion: Type.Literal(1), id: IdSchema, scopeId: Type.String({ pattern: "^[0-9a-f]{64}$" }), createdAt: Type.Number(), expiresAt: Type.Number(), kind: Type.Union([Type.Literal("snapshot"), Type.Literal("artifact")]), data: Type.Unknown() }, { additionalProperties: false });
const SnapshotSchema = Type.Object({ schemaVersion: Type.Literal(1), id: IdSchema, scopeId: Type.String(), requestedUrl: Type.String(), finalUrl: Type.String(), fetchedAt: Type.String(), representation: Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("readable-html")]), extractorVersion: Type.String(), text: Type.String(), contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false });
function validRecord(record: any): record is StoredRecord {
  if (!Value.Check(RecordSchema, record) || record.expiresAt <= record.createdAt) return false;
  const d = record.data;
  if (record.kind === "snapshot") return Value.Check(SnapshotSchema, d) && d.id === record.id && d.scopeId === record.scopeId && hash(d.text) === d.contentHash;
  return Value.Check(ArtifactSchema, d);
}
async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError("unsafe-cache", "Cache directory is not a private regular directory.");
  await chmod(path, 0o700);
}
// Observability seam for offline regression tests: counts full reads of
// private cache files performed through readPrivate. Quota planning must not
// read record payloads once the quota metadata is warm; only the metadata
// file itself, a one-time explicit rebuild/migration, and actual record reads
// may. Tests assert on the deltas to prove planning stays payload-free.
export const recordReadInstrumentation = { reads: 0, bytes: 0 };
async function readPrivate(path: string, maxBytes: number = CACHE_POLICY.recordBytes): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new EvidenceError("unsafe-cache", "Cache file is unsafe or exceeds its size budget.");
    const text = await file.readFile("utf8");
    recordReadInstrumentation.reads += 1;
    recordReadInstrumentation.bytes += stat.size;
    return text;
  } finally { await file.close(); }
}

// --- Quota metadata ---------------------------------------------------------
// Compact, schema-versioned quota/expiry index stored at the HOST ROOT (never
// inside a scope directory), so a scope's record listing keeps showing only
// record files and no public listing semantics change. Under the host writer
// lock, planning reads this metadata plus stat-level size/identity checks
// instead of rereading and rehashing every snapshot payload on every write;
// actual record reads keep full schema/scope/hash validation in get().
//
// Bounds: at most METADATA_MAX_RECORDS entries and METADATA_MAX_BYTES bytes.
// At default limits (2048 records) an entry is ~180 bytes, so overhead is
// well under 400 KiB; writes or loads beyond these bounds fail loudly
// ("cache-size" / "invalid-cache-schema") rather than growing without bound.
export const METADATA_MAX_RECORDS = 8192;
export const METADATA_MAX_BYTES = 2 * 1024 * 1024;
export const QUOTA_METADATA_NAME = ".evidence-quota-v1.json";
interface IndexEntry { id: string; scope: string; bytes: number; createdAt: number; expiresAt: number }
interface QuotaIndex { schemaVersion: 1; records: IndexEntry[] }
const IndexEntrySchema = Type.Object({ id: IdSchema, scope: Type.String({ pattern: "^[0-9a-f]{64}$" }), bytes: Type.Integer({ minimum: 0 }), createdAt: Type.Number(), expiresAt: Type.Number() }, { additionalProperties: false });
const QuotaIndexSchema = Type.Object({ schemaVersion: Type.Literal(1), records: Type.Array(IndexEntrySchema, { maxItems: METADATA_MAX_RECORDS }) }, { additionalProperties: false });
const metadataPath = (root: string) => join(root, QUOTA_METADATA_NAME);
async function loadIndex(root: string, signal?: AbortSignal): Promise<QuotaIndex | null> {
  cancelled(signal);
  let text: string;
  // The metadata budget (not the record budget) is enforced on the opened file
  // before reading, so an oversized index is rejected without being read or
  // silently rewritten.
  try { text = await readPrivate(metadataPath(root), METADATA_MAX_BYTES); }
  catch (error: any) {
    // Missing metadata (legacy cache written before quota metadata existed, or
    // a removed index) is the explicit trigger for a one-time rebuild below.
    if (error.code === "ENOENT") return null;
    throw error; // never swallow non-ENOENT IO failures
  }
  let index: any;
  try { index = JSON.parse(text); }
  catch { throw new EvidenceError("invalid-cache-schema", "Cache quota metadata is corrupt and must be removed or inspected by an operator."); }
  if (!Value.Check(QuotaIndexSchema, index)) throw new EvidenceError("invalid-cache-schema", "Cache quota metadata failed schema validation.");
  // Corrupt relationships or duplicate identities must fail before any quota
  // accounting or eviction decision can act on them.
  const identities = new Set<string>();
  for (const entry of index.records) {
    if (entry.expiresAt <= entry.createdAt) throw new EvidenceError("invalid-cache-schema", "Cache quota metadata contains an entry whose expiry is not after its creation; the cache must be inspected or removed by an operator.");
    const identity = `${entry.scope}/${entry.id}`;
    if (identities.has(identity)) throw new EvidenceError("invalid-cache-schema", "Cache quota metadata contains duplicate record identities; the cache must be inspected or removed by an operator.");
    identities.add(identity);
  }
  return index;
}
// One-time explicit migration/rebuild: fully read, parse and validate every
// existing record (same validation as the pre-metadata planner). Never
// refetches content and never changes identifiers; it only indexes what is
// already on disk. Also collects leftover temporary files from crashed
// writers, including the index's own temp files at the host root.
async function rebuildIndex(root: string, signal?: AbortSignal): Promise<{ index: QuotaIndex; removals: string[] }> {
  const records: IndexEntry[] = [];
  const removals: string[] = [];
  for (const name of await readdir(root)) {
    if (name.startsWith(".tmp-quota-") && Value.Check(IdSchema, name.slice(11))) removals.push(join(root, name));
  }
  for (const scope of await readdir(root)) {
    cancelled(signal);
    if (!/^[0-9a-f]{64}$/.test(scope)) continue;
    const directory = join(root, scope);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError("unsafe-cache", "Cache scope path is unsafe.");
    for (const name of await readdir(directory)) {
      cancelled(signal);
      if (name.startsWith(".tmp-") && Value.Check(IdSchema, name.slice(5))) { removals.push(join(directory, name)); continue; }
      if (!name.endsWith(".json") || !Value.Check(IdSchema, name.slice(0, -5))) continue;
      const path = join(directory, name);
      let record: any;
      try { record = JSON.parse(await readPrivate(path)); } catch (error) { throw new EvidenceError("invalid-cache-schema", "Cache contains an unreadable or unsafe record."); }
      if (!validRecord(record) || record.scopeId !== scope || record.id !== name.slice(0, -5)) throw new EvidenceError("invalid-cache-schema", "Cache contains an invalid record.");
      records.push({ id: record.id, scope, bytes: (await lstat(path)).size, createdAt: record.createdAt, expiresAt: record.expiresAt });
    }
  }
  return { index: { schemaVersion: 1, records }, removals };
}
async function writeQuotaIndex(root: string, index: QuotaIndex): Promise<void> {
  const json = JSON.stringify(index);
  if (Buffer.byteLength(json) > METADATA_MAX_BYTES || index.records.length > METADATA_MAX_RECORDS) throw new EvidenceError("cache-size", "Cache quota metadata exceeds its bounded size/count budget.");
  const temporary = join(root, `.tmp-quota-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(json, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, metadataPath(root));
  } finally { await unlink(temporary).catch((e: any) => { if (e.code !== "ENOENT") throw e; }); }
}
// The directory lock serializes quota enforcement across processes/children.
// A crashed writer leaves a lock: fail loudly rather than race a stale-lock
// deletion. An operator may remove .write-lock only after stopping writers.
async function lockWait(signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, 20);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function locked<T>(root: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = join(root, ".write-lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    cancelled(signal);
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      cancelled(signal);
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new EvidenceError("cache-busy", "Cache writer lock is busy; a crashed writer may require operator cleanup.");
      await lockWait(signal);
    }
  }
  try { cancelled(signal); return await action(); } finally { await rmdir(lock); }
}
export class EvidenceStore {
  readonly scopeId: string;
  readonly root: string;
  readonly directory: string;
  private options: StoreOptions;
  constructor(sessionIdentity: string, options: StoreOptions = {}) {
    if (!sessionIdentity) throw new EvidenceError("missing-session", "A Pi session identity is required; cwd is not a cache scope.");
    this.scopeId = hash(`sof-pi-evidence-v1:${sessionIdentity}`);
    this.root = options.root ?? join(homedir(), ".cache", "sof-pi", "evidence-v1");
    this.directory = join(this.root, this.scopeId);
    this.options = options;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private async initialize() { await privateDir(this.root); await privateDir(this.directory); }
  async putSnapshot(source: FetchedSource, signal?: AbortSignal): Promise<SourceSnapshot> {
    const id = randomUUID();
    const snapshot: SourceSnapshot = { schemaVersion: 1, id, scopeId: this.scopeId, ...source };
    await this.put("snapshot", snapshot, id, signal);
    return snapshot;
  }
  async putArtifact(artifact: Artifact, signal?: AbortSignal): Promise<string> { const id = randomUUID(); await this.put("artifact", artifact, id, signal); return id; }
  private async put(kind: StoredRecord["kind"], data: StoredRecord["data"], id: string, signal?: AbortSignal) {
    cancelled(signal);
    const now = this.now();
    const record: StoredRecord = { schemaVersion: 1, id, scopeId: this.scopeId, createdAt: now, expiresAt: now + (this.options.ttlMs ?? CACHE_POLICY.ttlMs), kind, data };
    if (!validRecord(record)) throw new EvidenceError("invalid-cache-schema", "Evidence record failed schema/hash validation.");
    const json = JSON.stringify(record);
    const bytes = Buffer.byteLength(json);
    if (bytes > Math.min(CACHE_POLICY.recordBytes, this.options.scopeBytes ?? CACHE_POLICY.scopeBytes, this.options.hostBytes ?? CACHE_POLICY.hostBytes)) throw new EvidenceError("cache-size", "Record exceeds cache budget.");
    await this.initialize();
    await locked(this.root, async () => {
      // Planning reads compact quota metadata plus stat-level checks; record
      // payloads are not reread or rehashed here except for the one-time
      // explicit rebuild of a legacy/unindexed cache.
      const planned = await this.planEviction(bytes, signal);
      // Commit boundary: cancellation before here cannot evict or write any
      // record. Once mutation begins, finish bounded atomic cleanup even if the
      // caller aborts, then report cancellation after releasing the host lock.
      cancelled(signal);
      for (const path of new Set(planned.removals)) await unlink(path);
      const temporary = join(this.directory, `.tmp-${randomUUID()}`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(json, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, `${id}.json`));
      } finally { await unlink(temporary).catch((e: any) => { if (e.code !== "ENOENT") throw e; }); }
      // The index update follows the record commit. A hard crash between the
      // two leaves an unindexed record that the next writer recovers by the
      // explicit rebuild; a handled index-write failure here removes the
      // just-written record so no divergence persists (a failed cleanup leaves
      // the same recoverable state as a crash, and the original error is
      // still the one reported).
      try { await this.writeIndex({ schemaVersion: 1, records: [...planned.records, { id, scope: this.scopeId, bytes, createdAt: now, expiresAt: record.expiresAt }] }); }
      catch (error) { await unlink(join(this.directory, `${id}.json`)).catch(() => undefined); throw error; }
    }, signal);
    cancelled(signal);
  }
  // Overridable seam so tests can inject quota-metadata write failures.
  private async writeIndex(index: QuotaIndex): Promise<void> { await writeQuotaIndex(this.root, index); }
  // Read-only quota planning: load the persisted quota metadata (rebuilt once,
  // explicitly, for a legacy cache without metadata), reconcile it against
  // stat-level record file sizes/identities, then evict oldest-first under the
  // same count/byte/expiry limits as before. Never rereads or rehashes record
  // payloads; actual reads keep full validation in get().
  private async planEviction(incomingBytes: number, signal?: AbortSignal): Promise<{ removals: string[]; records: IndexEntry[] }> {
    const index = await loadIndex(this.root, signal);
    if (!index) {
      const rebuilt = await rebuildIndex(this.root, signal);
      return this.evict(rebuilt.index, rebuilt.removals, incomingBytes, signal);
    }
    return this.evict(index, [], incomingBytes, signal);
  }
  private async evict(index: QuotaIndex, removals: string[], incomingBytes: number, signal?: AbortSignal): Promise<{ removals: string[]; records: IndexEntry[] }> {
    const rows: IndexEntry[] = [];
    const seen = new Set<string>();
    for (const entry of index.records) {
      cancelled(signal);
      const path = join(this.root, entry.scope, `${entry.id}.json`);
      let stat: { isFile(): boolean; size: number; mode: number };
      try { stat = await lstat(path); }
      catch (error: any) {
        // The record file is already gone (crash between an eviction unlink
        // and the metadata update): drop the stale entry. Never swallow
        // non-ENOENT IO failures.
        if (error.code === "ENOENT") continue;
        throw error;
      }
      // Same safety gate as readPrivate (regular file, no following symlinks,
      // POSIX private permissions), applied stat-only so warm planning never
      // reloads payload text.
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new EvidenceError("unsafe-cache", "Cache record path is unsafe.");
      // Records are immutable once written, so a size that diverges from the
      // metadata means tampering or corruption. Failing loudly keeps stale
      // metadata from being trusted for quota accounting (no bypass).
      if (stat.size !== entry.bytes) throw new EvidenceError("invalid-cache-schema", "Cache record diverges from quota metadata; the cache must be inspected or removed by an operator.");
      seen.add(`${entry.scope}/${entry.id}.json`);
      if (entry.expiresAt <= this.now()) { removals.push(path); continue; }
      rows.push(entry);
    }
    for (const scope of await readdir(this.root)) {
      cancelled(signal);
      // With the host writer lock held, a root quota temporary can only be a
      // stranded leftover from a crashed/handled-failure index write (its own
      // failed cleanup could not remove it, e.g. after the root lost write
      // permission). rebuildIndex covers the cold path; this warm scan is the
      // only recovery once the index exists. Only validated UUID names join
      // planned removals, executed after the cancellation commit boundary;
      // unknown or malformed names are never touched.
      if (scope.startsWith(".tmp-quota-") && Value.Check(IdSchema, scope.slice(11))) { removals.push(join(this.root, scope)); continue; }
      if (!/^[0-9a-f]{64}$/.test(scope)) continue;
      const directory = join(this.root, scope);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError("unsafe-cache", "Cache scope path is unsafe.");
      for (const name of await readdir(directory)) {
        cancelled(signal);
        // With the host writer lock held, these can only be leftovers from a
        // failed/crashed atomic write, not another writer's active temporary.
        if (name.startsWith(".tmp-") && Value.Check(IdSchema, name.slice(5))) { removals.push(join(directory, name)); continue; }
        if (!name.endsWith(".json") || !Value.Check(IdSchema, name.slice(0, -5))) continue;
        if (!seen.has(`${scope}/${name}`)) {
          // Record on disk absent from the metadata: an old pre-metadata
          // writer, or a crash between the record commit and the metadata
          // update. Recover with one explicit full rebuild (no refetch, no new
          // ids); old writers simply keep triggering this rebuild.
          const rebuilt = await rebuildIndex(this.root, signal);
          // Dedup: the warm scan and the rebuild both collect the same root
          // quota temporaries, and the post-commit cleanup must unlink each
          // path exactly once (no ENOENT from a repeated removal).
          return this.evict(rebuilt.index, [...new Set([...removals, ...rebuilt.removals])], incomingBytes, signal);
        }
      }
    }
    rows.sort((a, b) => a.createdAt - b.createdAt || `${a.scope}/${a.id}`.localeCompare(`${b.scope}/${b.id}`));
    const totalBytes = (list: typeof rows) => list.reduce((n, row) => n + row.bytes, 0);
    for (;;) {
      const own = rows.filter(row => row.scope === this.scopeId);
      const ownOver = own.length + 1 > (this.options.maxRecords ?? CACHE_POLICY.maxRecords) || totalBytes(own) + incomingBytes > (this.options.scopeBytes ?? CACHE_POLICY.scopeBytes);
      const hostOver = rows.length + 1 > (this.options.hostRecords ?? CACHE_POLICY.hostRecords) || totalBytes(rows) + incomingBytes > (this.options.hostBytes ?? CACHE_POLICY.hostBytes);
      if (!ownOver && !hostOver) break;
      const victim = ownOver ? own[0] : rows[0];
      if (!victim) throw new EvidenceError("cache-size", "Cache cannot accommodate this record.");
      removals.push(join(this.root, victim.scope, `${victim.id}.json`)); rows.splice(rows.indexOf(victim), 1);
    }
    cancelled(signal);
    return { removals, records: rows };
  }
  async get(id: string): Promise<StoredRecord> {
    if (!Value.Check(IdSchema, id)) throw new EvidenceError("invalid-handle", "Expected an opaque evidence response/source handle.");
    await this.initialize();
    let record: any;
    try { record = JSON.parse(await readPrivate(join(this.directory, `${id}.json`))); }
    catch (error: any) { if (error.code === "ENOENT") throw new EvidenceError("missing-handle", "Evidence handle is missing, evicted, or outside this session scope; reads never refetch."); throw new EvidenceError("invalid-cache-schema", "Evidence record cannot be safely read."); }
    if (!validRecord(record) || record.id !== id || record.scopeId !== this.scopeId) throw new EvidenceError("invalid-cache-schema", "Evidence record failed schema, scope, or hash validation.");
    if (record.expiresAt <= this.now()) throw new EvidenceError("expired-handle", "Evidence handle expired; reads never refetch. Request fresh retrieval explicitly.");
    return record;
  }
  async snapshot(id: string): Promise<SourceSnapshot> {
    const record = await this.get(id);
    if (record.kind !== "snapshot") throw new EvidenceError("wrong-handle-kind", "Expected a locally fetched snapshot handle.");
    return record.data as SourceSnapshot;
  }
}
