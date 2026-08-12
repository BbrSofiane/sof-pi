/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, stdin ignored) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Closing a terminal's scope kills the whole process
 * tree (SIGTERM → SIGKILL escalation).
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching async coordination.
 *
 * Plain TypeScript port of the original Effect-based implementation. The
 * async core is small: Deferred is replaced with Promise + resolve, FiberSet
 * with a self-removing cleanup-task set, and Effect.addFinalizer with the
 * explicit `disposed` flag checked in `start()` and torn down by
 * `disposeAll()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ConcurrencyLimitError,
	formatExit,
	SpawnError,
	UnknownTerminalError,
	type TerminalSnapshot,
	type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
const MAX_SETTLED_HISTORY = MAX_TRACKED * 4;
/** In-memory retained cap per stream. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
/** Private full-log spills are bounded so a firehose cannot fill the temp disk. */
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
/** Bound on waiting for spill WriteStreams to flush before settling; a hung
 * filesystem must not leave an exited entry "running" (and kill() waiting).
 * Terminate (≤2.5s) + settle grace (1s) + flush (1.5s) stays inside the 5s
 * scope-close bound, so teardown remains bounded end to end. */
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
	return bounded(error instanceof Error ? error.message : String(error));
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly TerminalSnapshot type.
 * stdout/stderr are getters over the live OutputBuffers. */
interface MutableSnapshot extends TerminalSnapshot {
	status: TerminalStatus;
	pid?: number;
	settledAt?: number;
	exitCode?: number;
	signal?: string;
	errorText?: string;
}

interface Entry {
	snapshot: MutableSnapshot;
	child: ChildProcess;
	stdoutBuf: OutputBuffer;
	stderrBuf: OutputBuffer;
	spillStreams: fs.WriteStream[];
	/** Set in the same synchronous block that sends SIGTERM so a natural exit
	 * before signaling keeps its truthful status. */
	killSignaled: boolean;
	/** The child emitted 'error' (spawn failure etc.); settles as "failed".
	 * Kept separate from errorText, which also carries non-fatal notes
	 * (spill failures) that must not flip a clean exit to "failed". */
	processErrored: boolean;
	/** 'exit' event observed (code/signal recorded). */
	exited: boolean;
	/** 'close' event observed (stdio flushed; the settle trigger). */
	stdioClosed: boolean;
	/** A settle-after-spill-flush is in flight; don't start a second one. */
	settling: boolean;
	/** The shell exited without stdio closing; a bounded scope close is queued
	 * to reap descendants that still hold the inherited pipes open. */
	exitCleanupStarted: boolean;
	/** Completed exactly once when the entry settles. Kill callers and the
	 * teardown path can all await the same result without missing a
	 * notification. Replaces Effect Deferred. */
	settledPromise: Promise<void>;
	settledResolve: () => void;
	/** Idempotent close-in-progress flag + promise for closeEntryScope. */
	closing: boolean;
	closingPromise?: Promise<void>;
}

export interface StartOptions {
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
}

export interface KillResult {
	readonly id: string;
	readonly title: string;
	readonly status: TerminalStatus;
	/** True when the entry was still running when this kill began. */
	readonly wasRunning: boolean;
	/** True when this call initiated the termination AND the entry settled as
	 * killed (a natural exit that won the race reports killed: false). */
	readonly killed: boolean;
	/** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
	 * so reports stay accurate even if the entry is pruned afterwards. */
	readonly exit: string;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
	list(): ReadonlyArray<TerminalSnapshot>;
	get(id: string): TerminalSnapshot | undefined;
	size(): number;
	/** Any-change notification (widget, /ps list). */
	subscribe(listener: () => void): () => void;
	/** Per-terminal notification (/ps detail view). */
	subscribeTo(id: string, listener: () => void): () => void;
	/** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
	 * settle still flows back to the model as a follow-up message. */
	requestKill(id: string): void;
	/**
	 * Register the settle hook. `consumed` is true when an active bg_kill is
	 * collecting the result (so it must not also be delivered as a follow-up).
	 */
	setOnSettled(
		hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined,
	): void;
}

// --- Process helpers ------------------------------------------------------------

function shellInvocation(command: string) {
	if (process.platform === "win32") {
		const shell = process.env.ComSpec ?? "cmd.exe";
		return { shell, args: ["/d", "/s", "/c", command] };
	}
	return { shell: "/bin/sh", args: ["-c", command] };
}

/** Signal the whole process group on POSIX so descendants (servers a shell
 * command spawned) die with it; a wedged child must not orphan its tree. */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (process.platform === "win32" && child.pid) {
		try {
			const killer = spawn(
				"taskkill",
				[
					"/pid",
					String(child.pid),
					"/T",
					...(signal === "SIGKILL" ? ["/F"] : []),
				],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.once("error", () => {
				try {
					child.kill(signal);
				} catch {
					// Process may already be gone.
				}
			});
			killer.once("exit", (code) => {
				if (code === 0) return;
				try {
					child.kill(signal);
				} catch {
					// Process may already be gone.
				}
			});
			killer.unref();
			return;
		} catch {
			// Fall through to the direct signal when taskkill cannot be launched.
		}
	}
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Group may already be gone; fall through to the direct signal.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Process may already be gone.
	}
}

/** Resolve once the child emits 'close', or after `timeoutMs` regardless.
 * Replaces Effect's callback + timeout race. */
function waitForClose(child: ChildProcess, closed: () => boolean, timeoutMs: number): Promise<void> {
	if (closed()) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			child.off("close", finish);
			clearTimeout(timer);
			resolve();
		};
		child.once("close", finish);
		const timer = setTimeout(finish, timeoutMs);
		// Clear the timer on the happy path so the deadline doesn't fire as a
		// no-op after 'close' already resolved.
		// NOTE: do NOT unref — this timer is the bound guarantee that the
		// promise resolves; unref'ing it lets the event loop empty first.
	});
}

/** SIGTERM → deadline → SIGKILL; waits for stdio closure rather than only the
 * shell's exit because descendants can keep the inherited pipes and process
 * group alive after the shell itself is gone. */
async function terminateChild(
	child: ChildProcess,
	closed: () => boolean,
	onSignal: () => void,
) {
	if (closed()) return;
	onSignal();
	killTree(child, "SIGTERM");
	await waitForClose(child, closed, FORCE_KILL_AFTER_MS);
	if (closed()) return;
	killTree(child, "SIGKILL");
	await waitForClose(child, closed, 500);
}

/** Race a promise against a timeout; resolves void either way. The timer is
 * cleared on the happy path so a no-op deadline cannot keep the event loop
 * (and pi's shutdown) alive past teardown. NOT unref'd — the timer is the
 * bound guarantee the promise resolves when `p` hangs (e.g. a wedged
 * disposeAll); unref'ing it would let the loop empty first and stall teardown. */
function withTimeoutVoid(p: Promise<unknown>, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => resolve(), timeoutMs);
		p.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			},
		);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// scheduleExitCleanup uses this as a 1s grace before a no-op check; once
		// the entry settles the check is harmless. Unref so the timer doesn't
		// pin the event loop through shutdown — the runCleanup task completes
		// whenever it fires, and a withTimeoutVoid bounds disposeAll anyway.
		timer.unref?.();
	});
}

// --- Implementation --------------------------------------------------------------

export class TerminalManager {
	private readonly entries = new Map<string, Entry>();
	/** Small immutable tombstones preserve truthful kill reports if pruning
	 * races the tool boundary after an id was validated. */
	private readonly settledHistory = new Map<
		string,
		Pick<KillResult, "title" | "status" | "exit">
	>();
	/** ids with an in-flight kill() collecting the result (settle → consumed). */
	private readonly killInterest = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private readonly idListeners = new Map<string, Set<() => void>>();
	/** Fire-and-forget cleanup tasks; self-removing on completion. Replaces
	 * Effect's FiberSet. */
	private readonly cleanupTasks = new Set<Promise<void>>();
	private counter = 0;
	private reserved = 0;
	private disposed = false;
	private spillDir: string | undefined | null;
	private onSettled:
		| ((snap: TerminalSnapshot, consumed: boolean) => void)
		| undefined;

	readonly view: TerminalReadModel;

	constructor() {
		const self = this;
		this.view = {
			list: () => [...self.entries.values()].map((entry) => entry.snapshot),
			get: (id) => self.entries.get(id)?.snapshot,
			size: () => self.entries.size,
			subscribe: (listener) => {
				self.listeners.add(listener);
				return () => self.listeners.delete(listener);
			},
			subscribeTo: (id, listener) => {
				let set = self.idListeners.get(id);
				if (!set) {
					set = new Set();
					self.idListeners.set(id, set);
				}
				set.add(listener);
				return () => {
					set!.delete(listener);
					if (set!.size === 0) self.idListeners.delete(id);
				};
			},
			requestKill: (id) => {
				const entry = self.entries.get(id);
				if (!entry) return;
				// UI-initiated kills are not "consumed": the killed result still
				// flows back to the model as a follow-up message (subagents
				// precedent).
				if (entry.snapshot.status !== "running") return;
				self.runCleanup(withTimeoutVoid(self.closeEntryScope(entry), STOP_TIMEOUT_MS));
			},
			setOnSettled: (hook) => {
				self.onSettled = hook;
			},
		};
	}

	// --- Notification + cleanup plumbing ----------------------------------

	private notify(id?: string) {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A failed widget/render listener must not corrupt lifecycle state.
			}
		}
		if (id) {
			for (const listener of this.idListeners.get(id) ?? []) {
				try {
					listener();
				} catch {
					// Same.
				}
			}
		}
	}

	/** Fire-and-forget a promise; self-removes from cleanupTasks on completion.
	 * Replaces Effect's FiberSet.runtime(). */
	private runCleanup(p: Promise<unknown>): void {
		const tracked = p.then(() => {}, () => {}) as Promise<void>;
		this.cleanupTasks.add(tracked);
		tracked.finally(() => this.cleanupTasks.delete(tracked));
	}

	/** Wait for all in-flight fire-and-forget cleanup to finish. */
	private awaitCleanup(): Promise<void> {
		return Promise.all([...this.cleanupTasks]).then(() => {});
	}

	// --- Concurrency + kill interest --------------------------------------

	private runningCount(): number {
		return [...this.entries.values()].filter(
			(e) => e.snapshot.status === "running",
		).length;
	}

	private addKillInterest(ids: ReadonlyArray<string>) {
		for (const id of ids)
			this.killInterest.set(id, (this.killInterest.get(id) ?? 0) + 1);
	}

	private releaseKillInterest(ids: ReadonlyArray<string>) {
		for (const id of ids) {
			const count = (this.killInterest.get(id) ?? 1) - 1;
			if (count <= 0) this.killInterest.delete(id);
			else this.killInterest.set(id, count);
		}
	}

	private pruneSettled() {
		if (this.entries.size <= MAX_TRACKED) return;
		const candidates = [...this.entries.values()]
			.filter(
				(e) =>
					e.snapshot.status !== "running" &&
					!this.killInterest.has(e.snapshot.id),
			)
			.sort(
				(a, b) =>
					(a.snapshot.settledAt ?? a.snapshot.createdAt) -
					(b.snapshot.settledAt ?? b.snapshot.createdAt),
			);
		for (const entry of candidates) {
			if (this.entries.size <= MAX_TRACKED) break;
			this.entries.delete(entry.snapshot.id);
			this.runCleanup(this.closeEntryScope(entry));
		}
	}

	// --- Spill plumbing ---------------------------------------------------

	private resolveSpillDir(): string | undefined {
		if (this.spillDir !== undefined) return this.spillDir ?? undefined;
		try {
			const base = path.join(os.tmpdir(), "pi-background-terminals");
			fs.mkdirSync(base, { recursive: true, mode: 0o700 });
			fs.chmodSync(base, 0o700);
			// Reap stale session dirs from prior sessions that crashed (SIGKILL,
			// power loss) before session_shutdown → disposeAll could clean up.
			// Their spill files contain process output (build logs, env dumps,
			// tokens) and must not persist indefinitely. Dirs are named
			// `session-<pid>-<suffix>`; reaping skips dirs whose PID is still alive
			// (probed via process.kill(pid, 0)), only dead-PID (or unparseable/
			// old-format) dirs are reaped. This prevents deleting a live
			// concurrent session's spill dir.
			try {
				for (const name of fs.readdirSync(base)) {
					if (!name.startsWith("session-")) continue;
					// session-<pid>-<suffix>: parse the pid between the first and second
					// `-` after `session-`. Missing third segment or NaN → stale.
					const rest = name.slice("session-".length);
					const firstDash = rest.indexOf("-");
					const pidStr = firstDash === -1 ? "" : rest.slice(0, firstDash);
					const pid = Number(pidStr);
					if (!Number.isInteger(pid) || pid <= 0) {
						const stale = path.join(base, name);
						try {
							fs.rmSync(stale, { recursive: true, force: true });
						} catch {
							// One stale dir we can't remove must not block the new session.
						}
						continue;
					}
					try {
						process.kill(pid, 0);
						// Alive → live concurrent session (or this very process); SKIP.
						continue;
					} catch (e) {
						const code = (e as NodeJS.ErrnoException).code;
						if (code === "ESRCH") {
							const stale = path.join(base, name);
							try {
								fs.rmSync(stale, { recursive: true, force: true });
							} catch {
								// One stale dir we can't remove must not block the new session.
							}
						} else if (code === "EPERM") {
							// Not ours but alive → SKIP to be safe.
							continue;
						} else {
							const stale = path.join(base, name);
							try {
								fs.rmSync(stale, { recursive: true, force: true });
							} catch {
								// One stale dir we can't remove must not block the new session.
							}
						}
					}
				}
			} catch {
				// readdir failure (base not readable) is non-fatal.
			}
			this.spillDir = fs.mkdtempSync(path.join(base, `session-${process.pid}-`));
			fs.chmodSync(this.spillDir, 0o700);
		} catch {
			this.spillDir = null;
		}
		return this.spillDir ?? undefined;
	}

	private makeSpill(
		entryRef: () => Entry | undefined,
		id: string,
		stream: "stdout" | "stderr",
		resumeSource: () => void,
	): { spillPath: string; file: fs.WriteStream; write: (chunk: string) => boolean } | undefined {
		const dir = this.resolveSpillDir();
		if (!dir) return undefined;
		const spillPath = path.join(dir, `${id}.${stream}.log`);
		try {
			const file = fs.createWriteStream(spillPath, {
				flags: "a",
				mode: 0o600,
			});
			let broken = false;
			let capped = false;
			let writtenBytes = 0;
			file.on("error", (error) => {
				broken = true;
				resumeSource();
				const current = entryRef();
				if (current) {
					const buf =
						stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
					buf.spillPath = undefined;
					current.snapshot.errorText ??= bounded(
						`Full-log spill to ${spillPath} failed: ${boundedError(error)}`,
					);
				}
			});
			return {
				spillPath,
				file,
				write: (chunk: string) => {
					// writableEnded guard: late 'data' after the settle flush must not
					// error the ended stream (and falsely report the spill as broken).
					if (broken || capped || file.writableEnded) return true;
					const chunkBytes = Buffer.byteLength(chunk, "utf8");
					if (writtenBytes + chunkBytes > MAX_SPILL_BYTES_PER_STREAM) {
						capped = true;
						const current = entryRef();
						if (current) {
							const buf =
								stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
							buf.spillPath = undefined;
							current.snapshot.errorText ??= bounded(
								`${stream} full-log spill reached the ${MAX_SPILL_BYTES_PER_STREAM}-byte safety limit`,
							);
						}
						return true;
					}
					writtenBytes += chunkBytes;
					let accepted = true;
					try {
						accepted = file.write(chunk);
					} catch {
						// A WriteStream that hit a write error (disk-full EIO/ENOSPC,
						// EPIPE) transitions to destroyed and throws on the next
						// write — before our 'error' listener sets `broken`. This runs
						// inside the child's stdout/stderr 'data' handler, so an
						// uncaught throw would crash pi. Treat a throw as broken.
						broken = true;
						resumeSource();
						return true;
					}
					if (!accepted) file.once("drain", resumeSource);
					return accepted;
				},
			};
		} catch {
			return undefined;
		}
	}

	// --- Settle / flush / teardown ---------------------------------------

	/** End all spill streams; resolves when their buffers are flushed to disk
	 * (bounded), so a settle notification never points at a partial file. */
	private async flushSpillStreams(entry: Entry): Promise<void> {
		const streams = entry.spillStreams;
		entry.spillStreams = [];
		const flushes = streams.map(
			(stream) =>
				new Promise<void>((resolve) => {
					const done = () => resolve();
					try {
						stream.end(done);
					} catch {
						// Best effort; tmpdir contents are disposable.
						done();
					}
				}),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timedOut = await Promise.race([
				Promise.all(flushes).then(() => false),
				new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), SPILL_FLUSH_TIMEOUT_MS); }),
			]);
			if (timedOut) {
				entry.stdoutBuf.spillPath = undefined;
				entry.stderrBuf.spillPath = undefined;
				entry.snapshot.errorText ??=
					"Full-log spill flush timed out; full output may be incomplete";
				// Force-close the FDs so a hung filesystem cannot leak descriptors
				// (or block process exit) past teardown. flushSpillStreams already
				// reassigned entry.spillStreams to [] earlier, so nothing else closes them.
				for (const stream of streams) {
					try {
						stream.destroy();
					} catch {
						// Best effort; tmpdir contents are disposable.
					}
				}
			}
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Single settle path — idempotent; kill vs natural exit vs error races are
	 * resolved by whichever lands first (the second call is a no-op). */
	private settle(entry: Entry) {
		const s = entry.snapshot;
		if (s.status !== "running") return;
		s.settledAt = Date.now();
		s.status = entry.killSignaled
			? "killed"
			: entry.processErrored
				? "failed"
				: s.exitCode === 0
					? "done"
					: "failed";
		this.settledHistory.set(s.id, {
			title: s.title,
			status: s.status,
			exit: formatExit(s),
		});
		while (this.settledHistory.size > MAX_SETTLED_HISTORY) {
			const oldest = this.settledHistory.keys().next().value;
			if (oldest === undefined) break;
			this.settledHistory.delete(oldest);
		}
		// Resolving the settle promise can immediately resume kill waiters,
		// whose ensuring blocks release interest. Snapshot consumption first so
		// the settle hook observes the interest that existed when settlement
		// won.
		const consumed = (this.killInterest.get(s.id) ?? 0) > 0;
		entry.settledResolve();
		this.notify(s.id);
		try {
			// During teardown, don't queue results into a shutting-down session.
			if (!this.disposed) this.onSettled?.(s, consumed);
		} catch {
			// The parent session may be unavailable; settlement stays final.
		}
		this.pruneSettled();
	}

	/** Flush the spill files, then settle: the completion follow-up (and the
	 * kill() resolution) reference the spill path, so the full capture must be
	 * on disk before anyone is told about it. Idempotent via `settling`. */
	private settleAfterFlush(entry: Entry) {
		if (entry.settling || entry.snapshot.status !== "running") return;
		entry.settling = true;
		this.runCleanup(
			(async () => {
				await this.flushSpillStreams(entry);
				this.settle(entry);
			})(),
		);
	}

	private scheduleExitCleanup(entry: Entry) {
		if (entry.exitCleanupStarted) return;
		entry.exitCleanupStarted = true;
		this.runCleanup(
			(async () => {
				await sleep(SETTLE_GRACE_MS);
				if (entry.snapshot.status === "running" && !entry.stdioClosed) {
					await withTimeoutVoid(this.closeEntryScope(entry), STOP_TIMEOUT_MS);
				}
			})(),
		);
	}

	/** The ONE teardown path (idempotent via `closing` flag). Kill, requestKill,
	 * pruning, disposeAll, and scheduleExitCleanup all converge here. */
	private closeEntryScope(entry: Entry): Promise<void> {
		if (entry.closing) return entry.closingPromise ?? Promise.resolve();
		entry.closing = true;
		entry.closingPromise = (async () => {
			// Only claim "killed" when we are actually about to signal a
			// live process; a natural exit that already happened (still
			// waiting on 'close') keeps its truthful done/failed status.
			await terminateChild(entry.child, () => entry.stdioClosed, () => {
				entry.killSignaled ||=
					!entry.exited && entry.snapshot.status === "running";
			});
			// Give the natural close→flush→settle path a bounded grace,
			// then force the settle: a grandchild holding the pipe open
			// (detached into a new group) must not leave the entry
			// "running" forever.
			if (entry.snapshot.status === "running") {
				await withTimeoutVoid(entry.settledPromise, SETTLE_GRACE_MS);
			}
			if (entry.snapshot.status === "running" && !entry.settling) {
				// Force the settle ourselves. When `settling` is set, the
				// close path's flush→settle is already in flight (bounded by
				// SPILL_FLUSH_TIMEOUT_MS) — settling here first would cite a
				// spill file that is still being flushed.
				if (!entry.stdioClosed) {
					entry.snapshot.errorText ??=
						"stdio did not close after termination; output may be incomplete";
				}
				entry.settling = true;
				await this.flushSpillStreams(entry);
				this.settle(entry);
			}
		})();
		return entry.closingPromise;
	}

	// --- Public API -------------------------------------------------------

	async start(options: StartOptions): Promise<TerminalSnapshot> {
		// Reserve synchronously (before any await) so parallel tool calls
		// cannot race past the cap.
		if (this.disposed) {
			throw new SpawnError(
				"Background terminal manager is shutting down.",
			);
		}
		if (this.runningCount() + this.reserved >= MAX_RUNNING) {
			throw new ConcurrencyLimitError(
				`Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
			);
		}
		this.reserved++;

		try {
			// The entire spawn → setEncoding → on('data'/'error'/'exit'/'close')
			// → entries.set sequence must be SYNCHRONOUS (no await between the
			// reservation check and entries.set) so an abort/teardown can't
			// leave a live child no entry knows about.
			const { shell, args } = shellInvocation(options.command);
			let child: ChildProcess;
			try {
				child = spawn(shell, args, {
					cwd: options.cwd,
					env: process.env,
					// stdin IGNORED: there is no input surface, ever. A process
					// that reads stdin sees EOF immediately.
					stdio: ["ignore", "pipe", "pipe"],
					// Own process group on POSIX → group kill takes the whole tree.
					detached: process.platform !== "win32",
				});
			} catch (error) {
				throw new SpawnError(boundedError(error));
			}

			const id = `bt-${++this.counter}`;
			const entryRef = () => this.entries.get(id);
			const stdoutSpill = this.makeSpill(entryRef, id, "stdout", () =>
				child.stdout?.resume(),
			);
			const stderrSpill = this.makeSpill(entryRef, id, "stderr", () =>
				child.stderr?.resume(),
			);
			const stdoutBuf = new OutputBuffer(
				RETAINED_PER_STREAM,
				stdoutSpill?.write,
			);
			const stderrBuf = new OutputBuffer(
				RETAINED_PER_STREAM,
				stderrSpill?.write,
			);
			stdoutBuf.spillPath = stdoutSpill?.spillPath;
			stderrBuf.spillPath = stderrSpill?.spillPath;

			const snapshot: MutableSnapshot = {
				id,
				command: options.command,
				title: options.title,
				cwd: options.cwd,
				pid: child.pid,
				status: "running",
				createdAt: Date.now(),
				get stdout() {
					return stdoutBuf.view();
				},
				get stderr() {
					return stderrBuf.view();
				},
			};

			// Create settled promise (replaces Effect Deferred).
			let settledResolve!: () => void;
			const settledPromise = new Promise<void>((res) => {
				settledResolve = res;
			});

			const entry: Entry = {
				snapshot,
				child,
				stdoutBuf,
				stderrBuf,
				spillStreams: [stdoutSpill?.file, stderrSpill?.file].filter(
					(file): file is fs.WriteStream => file !== undefined,
				),
				killSignaled: false,
				processErrored: false,
				exited: false,
				stdioClosed: false,
				settling: false,
				exitCleanupStarted: false,
				settledPromise,
				settledResolve,
				closing: false,
			};

			// Plain-callback stream plumbing (the codex-backend precedent):
			// setEncoding's internal StringDecoder is multibyte-safe across
			// chunk boundaries.
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				if (!stdoutBuf.push(chunk)) child.stdout?.pause();
				this.notify(id);
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				if (!stderrBuf.push(chunk)) child.stderr?.pause();
				this.notify(id);
			});
			// Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
			// still emits 'close' afterwards (with a bogus errno as code), so
			// record the failure here and let the close path do the one settle.
			child.once("error", (error) => {
				entry.processErrored = true;
				snapshot.errorText ??= boundedError(error);
				entry.exited = true;
				this.settleAfterFlush(entry);
			});
			// Record code/signal on 'exit'; settle on 'close' so the completion
			// notification always carries the final flushed output.
			child.once("exit", (code, signal) => {
				entry.exited = true;
				snapshot.exitCode = code ?? undefined;
				snapshot.signal = signal ?? undefined;
				// A descendant can keep the pipes open after the shell exits. Give
				// close a short natural grace, then close the scope to terminate
				// the surviving process group and force a bounded settlement.
				this.scheduleExitCleanup(entry);
			});
			child.once("close", (code, signal) => {
				entry.exited = true;
				entry.stdioClosed = true;
				// Only trust close's code/signal when 'exit' never fired (a spawn
				// 'error' close reports the errno, e.g. -2, as its code).
				if (!entry.processErrored) {
					snapshot.exitCode ??= code ?? undefined;
					snapshot.signal ??= signal ?? undefined;
				}
				this.settleAfterFlush(entry);
			});

			// disposeAll may have swept the entries map while we were setting up;
			// an entry added after the sweep would never be torn down. Close our
			// own scope (kills the child) and fail instead (subagents precedent).
			if (this.disposed) {
				// Don't await — just fire and forget the close, then throw.
				this.runCleanup(this.closeEntryScope(entry));
				throw new SpawnError(
					"Background terminal manager shut down while starting.",
				);
			}
			this.entries.set(id, entry);
			this.notify(id);
			return snapshot as TerminalSnapshot;
		} finally {
			this.reserved--;
			this.notify();
		}
	}

	async status(id: string): Promise<TerminalSnapshot> {
		const entry = this.entries.get(id);
		if (!entry) {
			const known = [...this.entries.keys()];
			throw new UnknownTerminalError(
				`Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
			);
		}
		return entry.snapshot as TerminalSnapshot;
	}

	/** Kill running terminals; resolves only after they have settled. */
	async kill(ids: ReadonlyArray<string>): Promise<ReadonlyArray<KillResult>> {
		const unique = [...new Set(ids)];
		const byId = new Map(
			unique
				.map((id) => this.entries.get(id))
				.filter((entry): entry is Entry => entry !== undefined)
				.map((entry) => [entry.snapshot.id, entry]),
		);
		// Validate all known first (UnknownTerminalError listing known ids).
		const unknown = unique.filter((id) => !byId.has(id));
		if (unknown.length > 0) {
			const known = [...this.entries.keys()];
			throw new UnknownTerminalError(
				`Unknown terminal id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
			);
		}
		const running = [...byId.values()].filter(
			(entry) => entry.snapshot.status === "running",
		);
		const runningIds = running.map((entry) => entry.snapshot.id);
		// Mark consumed before signaling so this kill's settlements are not
		// ALSO queued as automatic follow-up messages to the model.
		this.addKillInterest(runningIds);
		try {
			// For each running entry, fire-and-forget the close (killEntry).
			for (const entry of running) {
				if (entry.snapshot.status !== "running") continue;
				this.runCleanup(
					withTimeoutVoid(this.closeEntryScope(entry), STOP_TIMEOUT_MS),
				);
			}
			// Every caller waits on the entries that were running when its kill
			// began. Settled promise completion cannot be missed and supports
			// concurrent overlapping/multi-id kill calls.
			await Promise.all(running.map((entry) => entry.settledPromise));
			// Capture the report BEFORE the ensuring below releases interest and
			// prunes — a just-settled entry must not vanish out from under it.
			return unique.map((id): KillResult => {
				const snapshot = byId.get(id)?.snapshot;
				const history = this.settledHistory.get(id);
				const status = snapshot?.status ?? history?.status ?? "killed";
				const wasRunning = runningIds.includes(id);
				return {
					id,
					title: snapshot?.title ?? history?.title ?? "?",
					status,
					wasRunning,
					// A natural exit can win the race with our SIGTERM; report what
					// actually happened rather than claiming the kill did it.
					killed: wasRunning && status === "killed",
					exit: snapshot
						? formatExit(snapshot)
						: (history?.exit ?? "unknown"),
				};
			});
		} finally {
			this.releaseKillInterest(runningIds);
			this.pruneSettled();
		}
	}

	list(): TerminalSnapshot[] {
		return [...this.entries.values()].map((e) => e.snapshot);
	}

	async disposeAll(): Promise<void> {
		this.disposed = true;
		const all = [...this.entries.values()];
		this.entries.clear();
		await Promise.all(
			all.map((entry) =>
				withTimeoutVoid(this.closeEntryScope(entry), STOP_TIMEOUT_MS),
			),
		);
		// Detached kill/prune/flush work is tracked in cleanupTasks. Wait for
		// it within the shutdown bound; remaining tasks self-remove.
		await withTimeoutVoid(this.awaitCleanup(), STOP_TIMEOUT_MS);
		const dir = this.spillDir;
		this.spillDir = null;
		if (dir) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort; tmpdir contents are disposable.
			}
		}
		this.notify();
	}
}
