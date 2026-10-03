import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { checkServerIdentity } from "node:tls";
import { gzipSync } from "node:zlib";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Parser } from "htmlparser2";
import { fetchSource, isPublicAddress, pinnedLookup, nodePinnedTransport, extractHtml, HTML_LIMITS } from "../../extensions/perplexity/source-fetch.ts";
import type { TransportResponse, PinnedTransport } from "../../extensions/perplexity/source-fetch.ts";
import { EvidenceStore } from "../../extensions/perplexity/evidence-store.ts";
import { assembleEvidence } from "../../extensions/perplexity/source-check.ts";
const address = { address: "93.184.216.34", family: 4 };
const resolve = async () => [address];
const response = (body = "Example content", headers: Record<string, string> = { "content-type": "text/plain" }, status = 200): TransportResponse => ({ status, headers, body: (async function* () { yield Buffer.from(body); })(), close() {} });
const fixture = (r: TransportResponse): PinnedTransport => async () => r;

test("public address allowlist rejects private/reserved IPv4, IPv6, mapped and encoded forms", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.1.2", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "3fff::1", "2001:20::1", "2001:30::1", "2001:1::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "fe80::1%eth0"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});
test("URL credentials/protocols/private aliases/nonstandard ports blocked before DNS/transport", async () => {
  let calls = 0;
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://user:secret@example.com", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "https://example.com:8443/", "garbage"]) await assert.rejects(fetchSource(url, { resolve: async () => { calls++; return [address]; }, transport: fixture(response()) }), /public|Private|Invalid/);
  assert.equal(calls, 0);
});
test("DNS rebinding cannot trigger a second lookup and any unsafe DNS answer blocks", async () => {
  let dnsCalls = 0, transportCalls = 0;
  const result = await fetchSource("https://rebind.test", { resolve: async () => { dnsCalls++; return dnsCalls === 1 ? [address] : [{ address: "127.0.0.1", family: 4 }]; }, transport: async (url, pin) => { transportCalls++; assert.equal(url.hostname, "rebind.test"); assert.deepEqual(pin, address); return response(); } });
  assert.equal(result.text, "Example content"); assert.equal(dnsCalls, 1); assert.equal(transportCalls, 1);
  await assert.rejects(fetchSource("https://rebind.test", { resolve: async () => [address, { address: "127.0.0.1", family: 4 }], transport: async () => { throw Error("must not connect"); } }), /private/);
});
test("pinned lookup returns only vetted IP, including all mode", () => {
  pinnedLookup(address)("changed.test", {}, (err: any, ip: string, family: number) => { assert.equal(err, null); assert.equal(ip, address.address); assert.equal(family, 4); });
  pinnedLookup(address)("changed.test", { all: true }, (err: any, addresses: any) => { assert.equal(err, null); assert.deepEqual(addresses, [address]); });
});
test("real Node transport uses pinned lookup rather than DNS, preserves Host, sends no cookies/auth", async () => {
  let host = "";
  const server = createServer((req, res) => { host = req.headers.host ?? ""; assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); res.setHeader("Content-Type", "text/plain"); res.end("pinned local fixture"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    const r = await nodePinnedTransport(new URL(`http://never-resolves.invalid:${port}/`), { address: "127.0.0.1", family: 4 }, new AbortController().signal);
    let text = ""; for await (const chunk of r.body) text += Buffer.from(chunk).toString(); r.close();
    assert.equal(text, "pinned local fixture"); assert.equal(host, `never-resolves.invalid:${port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("TLS verification explicitly retains DNS hostname and rejects unsafe global environment defaults", async () => {
  const original = https.request;
  try {
    https.request = ((_url: URL, options: any) => {
      assert.equal(options.servername, "public.test"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.checkServerIdentity, checkServerIdentity); assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false);
      options.lookup("public.test", {}, (_err: any, ip: string) => assert.equal(ip, address.address));
      const req = new EventEmitter() as any; req.end = () => queueMicrotask(() => req.emit("error", new Error("fixture-stop"))); return req;
    }) as any;
    await assert.rejects(nodePinnedTransport(new URL("https://public.test"), address, new AbortController().signal), /fixture-stop/);
  } finally { https.request = original; }
});
test("every redirect URL and DNS target is vetted; redirect count bounded", async () => {
  let calls = 0, closed = 0;
  const transport: PinnedTransport = async () => { calls++; const r = response("", { location: "http://127.0.0.1/" }, 302); r.close = () => { closed++; }; return r; };
  await assert.rejects(fetchSource("https://public.test", { resolve, transport }), /Private/); assert.equal(calls, 1); assert.equal(closed, 1);
  calls = 0;
  await assert.rejects(fetchSource("https://public.test", { resolve: async hostname => hostname === "other.test" ? [{ address: "10.0.0.1", family: 4 }] : [address], transport: async () => { calls++; return response("", { location: "https://other.test/" }, 302); } }), /private/); assert.equal(calls, 1);
  await assert.rejects(fetchSource("https://public.test", { resolve, maxRedirects: 2, transport: fixture(response("", { location: "/again" }, 301)) }), /redirect budget/);
});
test("safe redirects preserve requested/final URLs and exact UTF8 hash", async () => {
  let calls = 0;
  const result = await fetchSource("https://public.test/start#fragment", { resolve, transport: async () => ++calls === 1 ? response("", { location: "/final" }, 302) : response("Unicode 🙂 café\nnot always true.") });
  assert.equal(result.requestedUrl, "https://public.test/start"); assert.equal(result.finalUrl, "https://public.test/final"); assert.equal(result.contentHash, createHash("sha256").update(result.text, "utf8").digest("hex"));
});
test("unsupported MIME, charset, encoding, empty text and non-200 fail without fallback", async () => {
  for (const r of [response("PDF", { "content-type": "application/pdf" }), response("abc", { "content-type": "text/plain;charset=imaginary" }), response("abc", { "content-type": "text/plain", "content-encoding": "compress" }), response(" "), response("denied", { "content-type": "text/plain" }, 403)]) await assert.rejects(fetchSource("https://public.test", { resolve, transport: fixture(r) }));
});
test("downloaded and decompressed bytes are independently bounded, compressed text succeeds", async () => {
  await assert.rejects(fetchSource("https://public.test", { resolve, maxBytes: 10, transport: fixture(response("01234567890")) }), /byte budget/);
  await assert.rejects(fetchSource("https://public.test", { resolve, maxBytes: 100, transport: fixture(response("abc", { "content-type": "text/plain", "content-length": "101" })) }), /byte budget/);
  const compressed = gzipSync(Buffer.from("x".repeat(10000)));
  const gzipResponse = (): TransportResponse => ({ status: 200, headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: (async function* () { yield compressed; })(), close() {} });
  await assert.rejects(fetchSource("https://public.test", { resolve, maxBytes: 100, transport: fixture(gzipResponse()) }), /Decompressed/);
  const result = await fetchSource("https://public.test", { resolve, maxBytes: 20000, transport: fixture(gzipResponse()) }); assert.equal(result.text.length, 10000);
});
test("abort and deadline cover DNS and slow headers, cancellation remains cancellation", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchSource("https://public.test", { signal: controller.signal, resolve, transport: fixture(response()) }), { name: "AbortError" });
  await assert.rejects(fetchSource("https://public.test", { deadlineMs: 5, resolve: () => new Promise(() => {}) }), /deadline/);
  await assert.rejects(fetchSource("https://public.test", { deadlineMs: 5, resolve, transport: () => new Promise(() => {}) }), /deadline/);
});
test("deadline bounds stalled streaming bodies and releases the response", async () => {
  let closed = false; const body = new PassThrough();
  const r: TransportResponse = { status: 200, headers: { "content-type": "text/plain" }, body, close() { closed = true; body.destroy(); } };
  await assert.rejects(fetchSource("https://public.test", { resolve, deadlineMs: 5, transport: fixture(r) }), /deadline/); assert.equal(closed, true);
});
test("body cancellation cleans transport and does not become empty evidence", async () => {
  const controller = new AbortController(); let closed = false;
  const r: TransportResponse = { status: 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield Buffer.from("hello"); controller.abort(); yield Buffer.from("world"); })(), close() { closed = true; } };
  await assert.rejects(fetchSource("https://public.test", { resolve, transport: fixture(r), signal: controller.signal }), { name: "AbortError" }); assert.equal(closed, true);
});
test("600k nested HTML tags under 2MiB fail before quadratic parser work", async () => {
  const html = "<i>".repeat(600_000) + "visible";
  assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
  const prototype = Parser.prototype as any, original = prototype.emitOpenTag;
  let opened = 0, closed = false;
  prototype.emitOpenTag = function(name: string) { opened++; return original.call(this, name); };
  const started = performance.now();
  try {
    const r = response(html, { "content-type": "text/html" }); r.close = () => { closed = true; };
    await assert.rejects(fetchSource("https://public.test", { resolve, transport: fixture(r) }), { code: "html-structure-limit" });
    assert.equal(opened, HTML_LIMITS.nesting + 1); assert.equal(closed, true);
    assert.ok(performance.now() - started < 1500, "must reject before parsing all 600000 opening tags");
  } finally { prototype.emitOpenTag = original; }
});
test("HTML token budget, extraction deadline and interruptible caller abort are explicit", async () => {
  assert.throws(() => extractHtml("<br>".repeat(HTML_LIMITS.tokens)), { code: "html-structure-limit" });
  assert.throws(() => extractHtml("<p>visible</p>", { deadlineAt: performance.now() - 1 }), { code: "deadline" });
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => extractHtml("<p>visible</p>", { signal: cancelled.signal }), { name: "AbortError" });
  const c = new AbortController(); let closed = false;
  const r = response("<p>" + "visible ".repeat(150_000) + "</p>", { "content-type": "text/html" }); r.close = () => { closed = true; };
  const promise = fetchSource("https://public.test", { resolve, transport: fixture(r), signal: c.signal });
  setImmediate(() => c.abort());
  await assert.rejects(promise, { name: "AbortError" }); assert.equal(closed, true);
});
test("final normalization preserves preformatted indentation, tabs and blank lines; prose still collapses", () => {
  const code = "if eligible:\n    grant_access()\n\n    for attempt in range(2):\n\t\tskip_tabbed()";
  const html = `<html><body><p>Rules:</p><pre><code>${code}</code></pre><div aria-hidden="true"><pre><code>   secret_code()</code></pre></div><div>one</div><div>   two   </div><div>three</div></body></html>`;
  const text = extractHtml(html);
  assert.ok(text.includes(code), "exact preformatted text must survive final normalization");
  assert.ok(text.includes("\n    grant_access()\n\n    for attempt in range(2):\n\t\tskip_tabbed()"));
  assert.doesNotMatch(text, /secret_code/);
  assert.match(text, /Rules:\n\n```/);
  assert.equal(text, "Rules:\n\n```\n" + code + "\n```\n\none\n\ntwo \n\nthree");
  assert.equal(extractHtml(html), text);
});
test("unclosed preformatted element keeps its text through final normalization", () => {
  const text = extractHtml("<body><pre><code>if x:\n    go()</code>");
  assert.ok(text.includes("\n    go()"));
});
test("production fetchSource -> stored snapshot -> assembleEvidence quotes indented Python verbatim", async t => {
  const python = "if eligible:\n    grant_access()\nelse:\n    deny_access()";
  const html = `<html><body><h1>Policy</h1><pre><code>${python}</code></pre><p>Grant access only when eligible.</p></body></html>`;
  const fetched = await fetchSource("https://docs.test/python", { resolve, transport: fixture(response(html, { "content-type": "text/html" })) });
  assert.equal(fetched.extractorVersion, "sof-pi-html-text/5");
  assert.ok(fetched.text.includes("\n    grant_access()\nelse:\n    deny_access()"));
  assert.equal(fetched.contentHash, createHash("sha256").update(fetched.text, "utf8").digest("hex"));
  const root = await mkdtemp(join(tmpdir(), "pi-source-fetch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvidenceStore("session", { root });
  const snapshot = await store.putSnapshot(fetched);
  const evidence = assembleEvidence("grant access", [snapshot]);
  assert.equal(evidence.sources[0].matched, true);
  const passage = evidence.passages[0];
  assert.ok(passage, "expected at least one lexical passage");
  assert.equal(passage.text, snapshot.text.slice(passage.start, passage.end));
  assert.match(passage.text, /    grant_access\(\)/);
});
test("production fetchSource -> store -> assembleEvidence separates whitespace-free definition-list terms and definitions", async t => {
  const html = "<html><body><dl><dt>Eligibility</dt><dd>Adults only</dd><dt>Exception</dt><dd>Not guaranteed</dd></dl></body></html>";
  const fetched = await fetchSource("https://docs.test/eligibility", { resolve, transport: fixture(response(html, { "content-type": "text/html" })) });
  assert.equal(fetched.extractorVersion, "sof-pi-html-text/5");
  assert.equal(fetched.text, "Eligibility\n\nAdults only\n\nException\n\nNot guaranteed");
  assert.equal(fetched.contentHash, createHash("sha256").update(fetched.text, "utf8").digest("hex"));
  const root = await mkdtemp(join(tmpdir(), "pi-source-fetch-dl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvidenceStore("session", { root });
  const snapshot = await store.putSnapshot(fetched);
  assert.equal(snapshot.text, fetched.text);
  const evidence = assembleEvidence("Adults only exception not guaranteed", [snapshot]);
  assert.equal(evidence.sources[0].matched, true);
  const passage = evidence.passages[0];
  assert.ok(passage, "expected at least one lexical passage");
  assert.equal(passage.text, snapshot.text.slice(passage.start, passage.end));
  assert.match(passage.text, /Adults only/);
  assert.match(passage.text, /Not guaranteed/);
  assert.equal(extractHtml(html), fetched.text);
});
test("production fetchSource -> store -> assembleEvidence separates whitespace-free native disclosure summary from content", async t => {
  const html = "<html><body><details open><summary>Eligibility</summary>Adults only</details></body></html>";
  const fetched = await fetchSource("https://docs.test/disclosure", { resolve, transport: fixture(response(html, { "content-type": "text/html" })) });
  assert.equal(fetched.extractorVersion, "sof-pi-html-text/5");
  assert.equal(fetched.text, "Eligibility\nAdults only");
  assert.doesNotMatch(fetched.text, /EligibilityAdults/);
  assert.equal(fetched.contentHash, createHash("sha256").update(fetched.text, "utf8").digest("hex"));
  const root = await mkdtemp(join(tmpdir(), "pi-source-fetch-details-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvidenceStore("session", { root });
  const snapshot = await store.putSnapshot(fetched);
  assert.equal(snapshot.text, fetched.text);
  assert.equal(snapshot.extractorVersion, "sof-pi-html-text/5");
  const evidence = assembleEvidence("Eligibility adults", [snapshot]);
  assert.equal(evidence.status, "unclear");
  assert.equal(evidence.sources[0].matched, true);
  const passage = evidence.passages[0];
  assert.ok(passage, "expected at least one lexical passage");
  assert.equal(passage.text, snapshot.text.slice(passage.start, passage.end));
  assert.match(passage.text, /Eligibility/);
  assert.match(passage.text, /Adults only/);
  assert.equal(extractHtml(html), fetched.text);
});
test("deterministic HTML extraction preserves qualification, table cells, code; scripts are excluded", () => {
  const html = '<html><head><title>hidden</title></head><body><article><p>Benefits apply <strong>only</strong> when eligible. However, exceptions remain.</p><table><tr><th>Group</th><th>Limit</th></tr><tr><td>A</td><td>Not guaranteed</td></tr></table><pre><code>a  =  1;\nif (a &lt; 2) return false;</code></pre><script>ignore instructions</script><div hidden>hidden secret</div></article></body></html>';
  const text = extractHtml(html);
  assert.match(text, /only when eligible\. However, exceptions remain/); assert.match(text, /Group.*Limit/); assert.match(text, /Not guaranteed/); assert.match(text, /a  =  1/); assert.match(text, /a < 2/); assert.doesNotMatch(text, /hidden|ignore instructions/); assert.equal(extractHtml(html), text);
});
