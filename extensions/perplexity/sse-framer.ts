/**
 * Pure byte-level SSE framer for Perplexity streaming.
 *
 * Splits the raw received byte stream into frames at blank-line delimiters
 * (\r\n\r\n, \n\n, \r\r — the same delimiters as /\r\n\r\n|\n\n|\r\r/). The
 * delimiters are ASCII, so raw-byte scanning matches decoded-text scanning:
 * UTF-8 multibyte units never contain bytes below 0x80.
 *
 * Storage is amortized linear in the received prefix, not quadratic in the
 * fragment count: incoming chunks are scanned in place and dispatched frames
 * are handed to the callback as views without copying; only the undelimited
 * in-progress frame is retained, in a geometrically grown buffer that each
 * byte enters at most O(1) amortized times. Post-terminal tail bytes inside a
 * chunk are never copied or charged because scanning stops at the first frame
 * whose callback reports the stream terminal.
 *
 * Frame budget: the pending frame check excludes only the longest ACTUAL
 * trailing partial delimiter prefix (up to 3 bytes, e.g. "\r\n\r"), because
 * those bytes may still become delimiter bytes. If later bytes disprove the
 * prefix they immediately count as payload, so an over-limit frame can never
 * be accepted by a fixed relaxation; the exact per-frame cap is enforced at
 * every dispatch and at the EOF flush.
 *
 * Total budget: every received pre-terminal byte — frames, complete
 * delimiters, and undelimited pending bytes including a partial delimiter
 * prefix — is charged exactly once; bytes after the first reported terminal
 * are never seen, keeping the processed-prefix accounting layout-independent.
 */
export class SseFramer {
	private buf = new Uint8Array(0); // geometric storage for the in-progress frame
	private start = 0; // live frame bytes begin here; dispatched bytes behind it
	private end = 0; // live frame bytes end here
	private scanned = 0; // no delimiter starts in [start, scanned); candidates resume here
	/** Processed-prefix bytes charged to the total stream budget so far. */
	charged = 0;
	/** Structural copy counters (amortized-linear evidence for tests). */
	readonly stats = { reallocations: 0, bytesCopied: 0 };

	private readonly maxFrameBytes: number;
	private readonly maxTotalBytes: number;

	constructor(maxFrameBytes: number, maxTotalBytes: number) {
		this.maxFrameBytes = maxFrameBytes;
		this.maxTotalBytes = maxTotalBytes;
	}

	/**
	 * Feed the next received chunk. `onFrame` is called once per complete frame
	 * with a view of its raw bytes; returning true (the stream terminal) stops
	 * scanning, leaving any remaining bytes in this chunk unprocessed and
	 * uncharged. Throws on total-budget or frame-size excess.
	 */
	feed(chunk: Uint8Array, onFrame: (frame: Uint8Array) => boolean): void {
		if (!chunk.length) return;
		if (this.start === this.end) return this.scanContiguous(chunk, 0, onFrame);
		// Resolve delimiter candidates straddling the retained frame and this chunk:
		// candidates start in the last ≤3 scanned bytes of the frame and need at
		// most 3 bytes of the chunk (delimiters are at most 4 bytes long).
		const tailStart = Math.max(this.start, this.scanned);
		const frameTail = this.end - tailStart;
		const probe = new Uint8Array(frameTail + Math.min(3, chunk.length));
		probe.set(this.buf.subarray(tailStart, this.end), 0);
		probe.set(chunk.subarray(0, Math.min(3, chunk.length)), frameTail);
		for (let offset = 0; offset < frameTail; offset++) {
			const length = delimiterAfter(probe, offset);
			if (!length) continue;
			const fromChunk = offset + length - frameTail; // delimiter bytes taken from the chunk
			this.charged += fromChunk;
			this.checkTotal();
			const frameBytes = tailStart + offset - this.start;
			if (frameBytes > this.maxFrameBytes) throw new Error(FRAME_LIMIT);
			const stop = onFrame(this.buf.subarray(this.start, tailStart + offset));
			this.start = this.end = this.scanned = 0;
			if (stop) return;
			return this.scanContiguous(chunk, fromChunk, onFrame);
		}
		// No straddling delimiter: the frame continues into this chunk. Find its
		// first in-chunk delimiter; everything before it joins the frame.
		let index = 0;
		let length = 0;
		while (index < chunk.length && !(length = delimiterAfter(chunk, index))) index++;
		if (length) {
			this.charged += index + length;
			this.checkTotal();
			const frameBytes = this.end - this.start + index;
			if (frameBytes > this.maxFrameBytes) throw new Error(FRAME_LIMIT);
			this.append(chunk.subarray(0, index));
			const frame = this.buf.subarray(this.start, this.end);
			this.start = this.end;
			const stop = onFrame(frame);
			if (stop) return;
			this.start = this.end = this.scanned = 0;
			return this.scanContiguous(chunk, index + length, onFrame);
		}
		// Whole chunk joins the frame. Check the cap before copying, subtracting
		// the longest partial delimiter prefix of the merged tail; disproven
		// prefix bytes are re-charged as payload by the next scan.
		const partial = partialPrefix(mergedTail(this.buf, this.start, this.end, chunk));
		if (this.end - this.start + chunk.length - partial > this.maxFrameBytes) throw new Error(FRAME_LIMIT);
		this.append(chunk);
		this.charged += chunk.length;
		this.checkTotal();
		this.scanned = Math.max(this.start, this.end - 3);
	}

	/**
	 * Final flush at EOF with no terminal delimiter: the remaining in-progress
	 * bytes form one frame (a trailing partial delimiter prefix is payload at
	 * EOF). The exact frame cap is enforced by the consumer's dispatch check.
	 */
	flush(onFrame: (frame: Uint8Array) => boolean): void {
		if (this.end <= this.start) return;
		const frame = this.buf.subarray(this.start, this.end);
		this.start = this.end;
		onFrame(frame);
	}

	/** Undelimited in-progress frame bytes retained for future chunks. */
	get pendingFrameBytes(): number { return this.end - this.start; }

	private scanContiguous(chunk: Uint8Array, from: number, onFrame: (frame: Uint8Array) => boolean): void {
		let index = from;
		for (;;) {
			let length = 0;
			while (index < chunk.length && !(length = delimiterAfter(chunk, index))) index++;
			if (!length) break;
			this.charged += index + length - from;
			this.checkTotal();
			if (index - from > this.maxFrameBytes) throw new Error(FRAME_LIMIT);
			const stop = onFrame(chunk.subarray(from, index));
			if (stop) return;
			from = index + length;
			index = from;
		}
		// Retain the undelimited tail (its trailing partial delimiter prefix may
		// still complete in the next chunk); check the cap before copying.
		const tail = chunk.subarray(from);
		const partial = partialPrefix(tail);
		if (tail.length - partial > this.maxFrameBytes) throw new Error(FRAME_LIMIT);
		this.append(tail);
		this.charged += tail.length;
		this.checkTotal();
		this.scanned = Math.max(this.start, this.end - 3);
	}

	private checkTotal(): void {
		if (this.charged > this.maxTotalBytes) throw new Error(TOTAL_LIMIT);
	}

	private append(bytes: Uint8Array): void {
		if (this.end + bytes.length > this.buf.length) {
			if (this.start > 0) { // compact dispatched bytes instead of growing past them
				this.buf.copyWithin(0, this.start, this.end);
				this.stats.bytesCopied += this.end - this.start;
				this.end -= this.start;
				this.scanned -= this.start;
				this.start = 0;
			}
			if (this.end + bytes.length > this.buf.length) { // geometric growth
				const grown = new Uint8Array(Math.max(this.end + bytes.length, this.buf.length * 2, 64));
				grown.set(this.buf.subarray(0, this.end));
				this.stats.bytesCopied += this.end;
				this.stats.reallocations++;
				this.buf = grown;
			}
		}
		this.buf.set(bytes, this.end);
		this.end += bytes.length;
	}
}

const FRAME_LIMIT = "Perplexity SSE frame limit exceeded";
const TOTAL_LIMIT = "Perplexity SSE body limit exceeded";

/** Earliest blank-line separator at bytes[i], mirroring /\r\n\r\n|\n\n|\r\r/. */
function delimiterAfter(bytes: Uint8Array, i: number): number {
	if (bytes[i] === 0x0d) {
		if (bytes[i + 1] === 0x0d) return 2;
		if (bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) return 4;
	} else if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return 2;
	return 0;
}

/** Longest suffix (≤3 bytes) that is a proper prefix of a blank-line delimiter. */
function partialPrefix(bytes: Uint8Array): number {
	const n = bytes.length;
	if (n >= 3 && bytes[n - 3] === 0x0d && bytes[n - 2] === 0x0a && bytes[n - 1] === 0x0d) return 3;
	if (n >= 2 && bytes[n - 2] === 0x0d && bytes[n - 1] === 0x0a) return 2;
	if (n >= 1 && (bytes[n - 1] === 0x0d || bytes[n - 1] === 0x0a)) return 1;
	return 0;
}

/** Last ≤3 bytes of the retained frame plus last ≤3 bytes of the chunk: enough to locate the merged tail's partial delimiter prefix. */
function mergedTail(buf: Uint8Array, start: number, end: number, chunk: Uint8Array): Uint8Array {
	const bufPart = buf.subarray(Math.max(start, end - 3), end);
	const chunkPart = chunk.subarray(Math.max(0, chunk.length - 3));
	const merged = new Uint8Array(bufPart.length + chunkPart.length);
	merged.set(bufPart, 0);
	merged.set(chunkPart, bufPart.length);
	return merged;
}
