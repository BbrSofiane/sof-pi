import { test } from "node:test";
import assert from "node:assert/strict";
import { SseFramer } from "../../extensions/perplexity/sse-framer.ts";

const enc = new TextEncoder();
const decoder = new TextDecoder();

/** Feed chunks (empty cuts = coalesced) and flush; returns frames plus framer accounting. */
function run(text: string, cuts: number[], maxFrameBytes: number, maxTotalBytes = 8 * 1024 * 1024, stop?: (frame: string) => boolean) {
	const encoded = enc.encode(text);
	const bounds = [0, ...cuts.filter((cut) => cut > 0 && cut < encoded.length).sort((a, b) => a - b), encoded.length];
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] > bounds[i]) chunks.push(encoded.subarray(bounds[i], bounds[i + 1]));
	const framer = new SseFramer(maxFrameBytes, maxTotalBytes);
	const frames: string[] = [];
	const onFrame = (frame: Uint8Array) => {
		const decoded = decoder.decode(frame);
		frames.push(decoded);
		return stop?.(decoded) ?? false;
	};
	for (const chunk of chunks) framer.feed(chunk, onFrame);
	framer.flush(onFrame);
	return { frames, charged: framer.charged, stats: framer.stats };
}

test("frames split at every byte cut identically for LF, CRLF and CRCR delimiters", () => {
	for (const delimiter of ["\n\n", "\r\n\r\n", "\r\r"]) {
		const text = "one" + delimiter + "two" + delimiter + "three";
		const expected = ["one", "two", "three"];
		const length = enc.encode(text).length;
		assert.deepEqual(run(text, [], 1024).frames, expected, `coalesced ${JSON.stringify(delimiter)}`);
		for (let cut = 0; cut <= length; cut++) {
			assert.deepEqual(run(text, [cut], 1024).frames, expected, `${JSON.stringify(delimiter)} cut at ${cut}`);
		}
	}
});

test("delimiter candidates straddling several chunk edges resolve exactly once", () => {
	const text = "a\r\n\r\nb\n\nc\r\rd";
	const length = enc.encode(text).length;
	for (let first = 0; first <= length; first++) {
		for (let second = first; second <= length; second++) {
			assert.deepEqual(run(text, [first, second], 1024).frames, ["a", "b", "c", "d"], `cuts ${first},${second}`);
		}
	}
});

test("randomized fragmented feeds match a reference delimiter split, including multibyte and EOF partial prefixes", () => {
	let seed = 0x2f6e2b1;
	const random = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
	const delimiters = ["\n\n", "\r\n\r\n", "\r\r"];
	for (let iteration = 0; iteration < 200; iteration++) {
		let text = "";
		const frameCount = 1 + random(4);
		for (let i = 0; i < frameCount; i++) text += `data ${iteration}-${i} café🛰️` + delimiters[random(delimiters.length)];
		if (random(2)) text += "tail\r"; // a partial delimiter prefix at EOF is payload
		const segments = text.split(/\r\n\r\n|\n\n|\r\r/);
		const last = segments.at(-1)!;
		const expected = segments.slice(0, -1).concat(last ? [last] : []);
		const cuts = Array.from({ length: random(8) }, () => 1 + random(enc.encode(text).length));
		assert.deepEqual(run(text, cuts, 4096).frames, expected, `iteration ${iteration} cuts ${cuts.join(",")}`);
	}
});

test("pending frame cap excludes only a real partial delimiter prefix; disproven prefix bytes count as payload immediately", () => {
	const collect: string[] = [];
	const onFrame = (frame: Uint8Array) => { collect.push(decoder.decode(frame)); return false; };
	// 8-byte cap: pending "1234567\r" is 8 raw bytes but only 7 candidate frame bytes → accepted.
	const framer = new SseFramer(8, 1_000_000);
	framer.feed(enc.encode("1234567\r"), onFrame);
	assert.equal(framer.pendingFrameBytes, 8);
	// The next byte disproves the delimiter prefix → payload cap applies immediately.
	assert.throws(() => framer.feed(enc.encode("x"), onFrame), /frame limit/);
	assert.throws(() => run("1234567\rx", [], 8), /frame limit/); // coalesced equivalent
	// Completing the delimiter instead keeps the 7-byte frame legal, across layouts.
	for (const cuts of [[], [8], [7, 8], [8, 9]]) {
		assert.deepEqual(run("1234567\r\rz", cuts, 8).frames, ["1234567", "z"], `cuts ${cuts.join(",")}`);
	}
	// A 2-byte partial prefix ("\r\n") is excluded while it can still complete…
	assert.deepEqual(run("12345\r\n", [5], 8).frames, ["12345\r\n"]); // …and is payload at the EOF flush
	// …and counts as payload the moment later bytes disprove it: 5 + 4 = 9 > 8.
	assert.throws(() => run("12345\r\nxy", [5], 8), /frame limit/);
	// 3 bytes ("\r\n\r") is the maximum partial prefix relaxation.
	assert.deepEqual(run("12345\r\n\r\nz", [8], 8).frames, ["12345", "z"]);
});

test("EOF flush delivers the exact frame cap; the consumer's dispatch enforces it on the delivered frame", () => {
	assert.deepEqual(run("12345678", [], 8).frames, ["12345678"]); // exactly at the cap passes through
	assert.throws(() => run("123456789", [], 8), /frame limit/); // one over at the pre-copy check
	assert.deepEqual(run("1234567\r", [], 8).frames, ["1234567\r"]); // partial prefix is payload at EOF, exactly at cap
	// Raw pending 9 with a 1-byte partial prefix is accepted pending; the flush
	// delivers all 9 bytes and the consumer's exact dispatch check rejects.
	assert.deepEqual(run("12345678\r", [], 8).frames, ["12345678\r"]);
});

test("total budget charges every pre-terminal byte exactly once, including delimiters and pending bytes", () => {
	const ok = run("ab\n\ncd", [], 1024, 6);
	assert.deepEqual(ok.frames, ["ab", "cd"]);
	assert.equal(ok.charged, 6);
	assert.throws(() => run("ab\n\ncd", [], 1024, 5), /body limit/); // the pending tail pushes past the total
	assert.deepEqual(run("a\n\nb\n\nc", [], 1024, 7).frames, ["a", "b", "c"]);
	assert.throws(() => run("a\n\nb\n\nc", [], 1024, 6), /body limit/);
});

test("post-terminal tail bytes inside a chunk are never copied or charged", () => {
	const tail = enc.encode("x".repeat(5 * 1024 * 1024));
	const chunk = new Uint8Array(4 + tail.length);
	chunk.set(enc.encode("ab\n\n"), 0);
	chunk.set(tail, 4);
	const framer = new SseFramer(1024, 1024);
	const frames: string[] = [];
	framer.feed(chunk, (frame) => { frames.push(decoder.decode(frame)); return frames.at(-1) === "ab"; });
	assert.deepEqual(frames, ["ab"]);
	assert.equal(framer.charged, 4); // the 5 MiB tail is untouched
});

test("retained storage is amortized linear: geometric growth bounds reallocations and moved bytes", () => {
	const framer = new SseFramer(2 * 1024 * 1024, 8 * 1024 * 1024);
	const onFrame = () => false;
	const fragment = enc.encode("0123456789abcdef");
	for (let i = 0; i < 131_072; i++) framer.feed(fragment, onFrame);
	assert.equal(framer.pendingFrameBytes, 2 * 1024 * 1024);
	// stats count reallocation/compaction moves only; each received byte is
	// appended once by construction. Doubling from 64 B to 2 MiB ≈ 15 grows.
	assert.ok(framer.stats.reallocations <= 20, `geometric growth (${framer.stats.reallocations} reallocations)`);
	assert.ok(framer.stats.bytesCopied <= 4 * framer.pendingFrameBytes, `copy bound (${framer.stats.bytesCopied} bytes moved)`);
	// Dispatching frames keeps storage bounded instead of retaining dispatched bytes.
	const framing = run(":c\n\n".repeat(4096), Array.from({ length: 4096 }, (_, i) => i * 4 + 3), 1024);
	assert.deepEqual(framing.frames.filter((frame) => frame !== ":c"), []);
	assert.ok(framing.stats.reallocations <= 20);
});
