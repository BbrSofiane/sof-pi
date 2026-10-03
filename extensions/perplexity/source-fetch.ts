import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { Transform, Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldExtraction } from "node:timers/promises";
import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";
import { EvidenceError, LIMITS, cancelled } from "./contracts.ts";
import type { SourceSnapshot } from "./contracts.ts";

export interface Address { address: string; family: number }
export interface TransportResponse { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; close(): void }
export type PinnedTransport = (url: URL, address: Address, signal: AbortSignal) => Promise<TransportResponse>;
export interface FetchOptions { signal?: AbortSignal; resolve?: (hostname: string) => Promise<Address[]>; transport?: PinnedTransport; deadlineMs?: number; maxBytes?: number; maxRedirects?: number; now?: () => Date }
export type FetchedSource = Omit<SourceSnapshot, "id" | "scopeId" | "schemaVersion">;
export function isPublicAddress(input: string): boolean {
  try {
    if (!isIP(input) || input.includes("%")) return false;
    const address = ipaddr.parse(input);
    // IPv4-mapped IPv6 and translation/tunnel ranges are deliberately denied,
    // even when the embedded IPv4 would be public.
    if (address.kind() === "ipv6" && (address as any).isIPv4MappedAddress()) return false;
    if (address.range() !== "unicast") return false;
    if (address.kind() === "ipv6" && !address.match(ipaddr.parse("2000::"), 3)) return false;
    return true;
  } catch { return false; }
}
export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new EvidenceError("unsafe-url", "Invalid public URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new EvidenceError("unsafe-url", "Only public HTTP(S) URLs without credentials on standard ports are supported.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname.includes("%") || (isIP(hostname) && !isPublicAddress(hostname))) throw new EvidenceError("unsafe-address", "Private or reserved destinations are blocked.");
  url.hash = "";
  return url;
}
export function pinnedLookup(address: Address) {
  return (_host: string, options: any, callback: any) => {
    // No second DNS lookup; return only an already-vetted address. Node can
    // request all addresses for autoSelectFamily, which is disabled below.
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}
export const nodePinnedTransport: PinnedTransport = async (url, address, signal) => new Promise((resolve, reject) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const client = url.protocol === "https:" ? https : http;
  const requestOptions: https.RequestOptions & { autoSelectFamily: boolean } = {
    method: "GET", agent: false, signal, lookup: pinnedLookup(address), family: address.family, autoSelectFamily: false,
    // URL hostname remains the TLS verification identity; never use the pinned
    // IP as the certificate name and never disable certificate verification.
    ...(url.protocol === "https:" ? { rejectUnauthorized: true, checkServerIdentity, ...(!isIP(hostname) ? { servername: hostname } : {}) } : {}),
    headers: { "User-Agent": "sof-pi-evidence/1", Accept: "text/plain, text/markdown, text/html", "Accept-Encoding": "gzip, deflate, br" },
    maxHeaderSize: 16 * 1024,
  };
  const req = client.request(url, requestOptions, res => {
    resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, close: () => { res.destroy(); req.destroy(); } });
  });
  req.on("error", reject);
  req.end();
});
function waitAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function header(response: TransportResponse, name: string): string {
  const val = response.headers[name];
  return typeof val === "string" ? val : "";
}
export const HTML_LIMITS = Object.freeze({ nesting: 256, tokens: 100_000, chunkChars: 8192 });
export interface ExtractionOptions { signal?: AbortSignal; deadlineAt?: number }
function htmlExtractor(options: ExtractionOptions) {
  let output = "", hiddenDepth = 0, preDepth = 0, tokens = 0;
  // Byte ranges of preformatted text inside `output`. Final whitespace
  // normalization must skip them: code indentation, tabs, and significant
  // blank lines are part of the stored snapshot and quoted passages.
  const preSpans: Array<{ start: number; end: number }> = [];
  let preSpanStart: number | null = null;
  const check = () => {
    cancelled(options.signal);
    if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt) throw new EvidenceError("deadline", "Source extraction deadline exceeded.");
  };
  const token = () => { check(); if (++tokens > HTML_LIMITS.tokens) throw new EvidenceError("html-structure-limit", "HTML structural token budget exceeded."); };
  const stack: Array<{ tag: string; hidden: boolean }> = [];
  // dl/dt/dd are block boundaries: whitespace-free definition-list markup must
  // not fuse terms, definitions, and qualifying labels into single words.
  // details/summary are native disclosure boundaries: whitespace-free static
  // disclosure markup must not fuse the summary label with the folded content.
  const blocks = new Set(["p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "tr", "table", "pre", "hr", "dl", "dt", "dd", "details", "summary"]);
  const parser = new Parser({
    // htmlparser2 inserts into its own stack before onopentagname. Throw here
    // at depth 257: every insertion/indexOf/implicit-close remains bounded,
    // instead of allowing quadratic unshift work on the entire response.
    onopentagname() {
      token();
      if (stack.length >= HTML_LIMITS.nesting) throw new EvidenceError("html-structure-limit", "HTML nesting budget exceeded.");
    },
    onattribute() { token(); }, oncomment() { token(); }, onprocessinginstruction() { token(); },
    onopentag(tag, attrs) {
      const hidden = hiddenDepth > 0 || ["script", "style", "noscript", "template", "head", "svg"].includes(tag) || "hidden" in attrs || attrs["aria-hidden"] === "true";
      stack.push({ tag, hidden }); if (hidden) hiddenDepth++;
      if (hidden) return;
      if (blocks.has(tag) || tag === "br") output += "\n";
      if (tag === "td" || tag === "th") output += " | ";
      if (tag === "li") output += "- ";
      if (tag === "pre") { output += "```\n"; if (!preDepth) preSpanStart = output.length; preDepth++; }
    },
    ontext(text) { token(); if (!hiddenDepth) output += preDepth ? text : text.replace(/\s+/g, " "); },
    onclosetag(tag) {
      token();
      const entry = stack.pop();
      if (entry?.hidden) { hiddenDepth--; return; }
      if (tag === "pre") {
        preDepth = Math.max(0, preDepth - 1);
        if (!preDepth && preSpanStart !== null) { preSpans.push({ start: preSpanStart, end: output.length }); preSpanStart = null; }
        output += "\n```";
      }
      if (blocks.has(tag)) output += "\n";
    },
  }, { decodeEntities: true });
  return { parser, check, finish() {
    check(); parser.end(); check();
    if (preSpanStart !== null) { preSpans.push({ start: preSpanStart, end: output.length }); preSpanStart = null; }
    const prose = (segment: string) => segment.replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
    let text = "", cursor = 0;
    for (const span of preSpans) {
      text += prose(output.slice(cursor, span.start)) + output.slice(span.start, span.end);
      cursor = span.end;
    }
    text += prose(output.slice(cursor));
    check(); return text.trim();
  } };
}
export function extractHtml(html: string, options: ExtractionOptions = {}): string {
  const extractor = htmlExtractor(options);
  for (let start = 0; start < html.length; start += HTML_LIMITS.chunkChars) {
    extractor.check(); extractor.parser.write(html.slice(start, start + HTML_LIMITS.chunkChars));
  }
  return extractor.finish();
}
async function extractHtmlInterruptibly(html: string, options: ExtractionOptions): Promise<string> {
  const extractor = htmlExtractor(options);
  for (let start = 0; start < html.length; start += HTML_LIMITS.chunkChars) {
    extractor.check(); extractor.parser.write(html.slice(start, start + HTML_LIMITS.chunkChars));
    // Let caller/shutdown abort and deadline timers execute between bounded
    // chunks, without replacing deterministic parsing with a browser/worker.
    await yieldExtraction(); extractor.check();
  }
  return extractor.finish();
}
async function readBody(response: TransportResponse, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = header(response, "content-encoding").toLowerCase().trim();
  if (encoding && !["identity", "gzip", "deflate", "br"].includes(encoding)) throw new EvidenceError("unsupported-encoding", "Unsupported content encoding.");
  let downloaded = 0;
  const source = Readable.from(response.body);
  const count = new Transform({ transform(chunk, _enc, cb) {
    downloaded += chunk.length;
    cb(downloaded > maxBytes ? new EvidenceError("download-limit", "Downloaded response exceeds the byte budget.") : null, chunk);
  } });
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
  const streams = decoder ? [source, count, decoder] : [source, count];
  // Forward errors across each pipe; async iteration does not do this itself.
  const stop = (error: Error) => { for (const stream of streams) if (!stream.destroyed) stream.destroy(error); };
  for (const stream of streams) stream.on("error", stop);
  const abort = () => stop(signal.reason instanceof Error ? signal.reason : new DOMException("Cancelled", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  let stream: Readable = source.pipe(count);
  if (decoder) stream = stream.pipe(decoder);
  const chunks: Buffer[] = []; let decoded = 0;
  try {
    cancelled(signal);
    for await (const chunk of stream) {
      cancelled(signal); decoded += chunk.length;
      if (decoded > maxBytes) throw new EvidenceError("decompression-limit", "Decompressed response exceeds the byte budget.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    for (const s of streams) s.destroy();
  }
}
export async function fetchSource(value: string, options: FetchOptions = {}): Promise<FetchedSource> {
  cancelled(options.signal);
  const requested = publicUrl(value).href;
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
  options.signal?.addEventListener("abort", relay, { once: true });
  const deadlineMs = options.deadlineMs ?? LIMITS.deadlineMs;
  const deadlineAt = performance.now() + deadlineMs;
  const timer = setTimeout(() => controller.abort(new EvidenceError("deadline", "Source fetch deadline exceeded.")), deadlineMs);
  const signal = controller.signal;
  const resolver = options.resolve ?? (async hostname => lookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? nodePinnedTransport;
  const maxBytes = options.maxBytes ?? LIMITS.bodyBytes;
  let url = new URL(requested);
  try {
    for (let redirects = 0; ; redirects++) {
      cancelled(signal);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await waitAbort(resolver(hostname), signal);
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || a.family !== isIP(a.address))) throw new EvidenceError("unsafe-address", "DNS returned a private, reserved, or invalid destination.");
      const pending = transport(url, addresses[0], signal);
      // An injected or delayed transport must not leak a late response on abort.
      pending.then(response => { if (signal.aborted) response.close(); }, () => {});
      const response = await waitAbort(pending, signal);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects >= (options.maxRedirects ?? LIMITS.redirects)) throw new EvidenceError("redirect-limit", "Source redirect budget exceeded.");
          const location = header(response, "location");
          if (!location) throw new EvidenceError("invalid-redirect", "Redirect has no location.");
          url = publicUrl(new URL(location, url).href);
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new EvidenceError("http-error", `Source returned HTTP ${response.status}; no synthesis fallback.`);
        const contentType = header(response, "content-type");
        const mime = contentType.split(";")[0].trim().toLowerCase();
        if (!["text/plain", "text/markdown", "text/x-markdown", "text/html"].includes(mime)) throw new EvidenceError("unsupported-mime", "Only plain text, Markdown, and HTML are supported (no PDF/browser/auth).");
        const length = header(response, "content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new EvidenceError("download-limit", "Response content length exceeds the byte budget.");
        const bytes = await readBody(response, maxBytes, signal);
        cancelled(signal);
        const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
        let raw: string;
        try { raw = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { throw new EvidenceError("unsupported-text", "Unsupported charset or invalid encoded source text."); }
        cancelled(signal);
        if (performance.now() >= deadlineAt) throw new EvidenceError("deadline", "Source extraction deadline exceeded.");
        const text = mime === "text/html" ? await extractHtmlInterruptibly(raw, { signal, deadlineAt }) : raw;
        cancelled(signal);
        if (performance.now() >= deadlineAt) throw new EvidenceError("deadline", "Source extraction deadline exceeded.");
        if (!text.trim()) throw new EvidenceError("empty-source", "Source has no inspectable text.");
        if (Buffer.byteLength(text, "utf8") > maxBytes) throw new EvidenceError("extraction-limit", "Extracted text exceeds the byte budget.");
        const fetched: FetchedSource = { requestedUrl: requested, finalUrl: url.href, fetchedAt: (options.now?.() ?? new Date()).toISOString(), representation: mime === "text/html" ? "readable-html" : mime === "text/plain" ? "text" : "markdown", extractorVersion: "sof-pi-html-text/5", text, contentHash: createHash("sha256").update(text, "utf8").digest("hex") };
        cancelled(signal);
        if (performance.now() >= deadlineAt) throw new EvidenceError("deadline", "Source extraction deadline exceeded.");
        return fetched;
      } finally { response.close(); }
    }
  } catch (error) {
    cancelled(options.signal);
    if (signal.aborted) throw signal.reason;
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("fetch-failed", "Source transport or decoding failed; no fallback was attempted.");
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", relay); }
}
