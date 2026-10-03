import { Type } from "typebox";
import { Value } from "typebox/value";

export const LIMITS = Object.freeze({ batch: 5, results: 10, concurrency: 3, deadlineMs: 30_000, redirects: 5, bodyBytes: 2 * 1024 * 1024, previewChars: 4000, pageChars: 12000 });
export const opaqueId = () => crypto.randomUUID();
export const IdSchema = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" });
const str = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const list = (item: any, maxItems: number = LIMITS.batch) => Type.Array(item, { minItems: 1, maxItems });
const strict = (properties: any) => Type.Object(properties, { additionalProperties: false });
export const SearchParams = strict({ query: Type.Optional(str()), queries: Type.Optional(list(str())), numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.results })), recencyFilter: Type.Optional(Type.Union(["hour", "day", "week", "month", "year"].map(x => Type.Literal(x)))), domainFilter: Type.Optional(list(Type.String({ pattern: "^-?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$", maxLength: 253 }), 20)), includeContent: Type.Optional(Type.Boolean()) });
export const FetchParams = strict({ url: Type.Optional(str(8192)), urls: Type.Optional(list(str(8192))) });
export const ReadParams = strict({ responseId: IdSchema, sourceId: Type.Optional(IdSchema), queryIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.pageChars })), findText: Type.Optional(str(200)) });
export const CheckParams = strict({ claim: str(), responseId: Type.Optional(IdSchema), sourceIds: Type.Optional(list(IdSchema, 50)), queries: Type.Optional(list(str())), urls: Type.Optional(list(str(8192))) });
export interface DiscoveryResult { requestId?: string; results: Array<{ id: string; title: string; url: string; snippet: string; date?: string; lastUpdated?: string }>; usage?: unknown }
export type Discover = (query: string, options: { signal?: AbortSignal; numResults?: number; recencyFilter?: string; domainFilter?: string[] }) => Promise<DiscoveryResult>;
export interface SourceSnapshot { schemaVersion: 1; id: string; scopeId: string; requestedUrl: string; finalUrl: string; fetchedAt: string; representation: "text" | "markdown" | "readable-html"; extractorVersion: string; text: string; contentHash: string }
export interface Candidate { id: string; providerId: string; queryIndex: number; title: string; url: string; snippet: string; provenance: "provider-snippet"; date?: string; lastUpdated?: string; snapshotId?: string; fetchError?: string }
export interface Diagnostic { index: number; code: string; message: string; stage?: "discovery" | "fetch" | "snapshot"; sourceId?: string; snapshotId?: string; responseId?: string }
export interface DiscoveryTrace { activity: "performed" | "reused"; responseId?: string; queries: Array<{ query: string; index: number; requestId?: string; usageStatus: "reported" | "unknown"; usage?: unknown }> }
export interface SearchArtifact { kind: "search"; queries: Array<{ query: string; index: number; requestId?: string; usage?: unknown }>; attempts?: Array<{ query: string; index: number }>; sources: Candidate[]; errors: Diagnostic[] }
export interface FetchArtifact { kind: "fetch"; snapshotIds: string[]; errors: Diagnostic[] }
export interface EvidencePassage { id: string; snapshotId: string; start: number; end: number; text: string }
export interface EvidenceArtifact { kind: "evidence"; claim: string; status: "unclear" | "missing-evidence"; snapshotIds: string[]; sources: Array<{ snapshotId: string; url: string; contentHash: string; fetchedAt: string; matched: boolean }>; passages: EvidencePassage[]; coverage: { inspected: number; matched: number; failed: number }; errors: Diagnostic[]; limitations: string[]; discovery?: DiscoveryTrace }
export type Artifact = SearchArtifact | FetchArtifact | EvidenceArtifact;
export class EvidenceError extends Error { code: string; constructor(code: string, message: string) { super(message); this.name = "EvidenceError"; this.code = code; } }
export function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError"); }
export function validateParams(schema: any, value: unknown, tool: string): any {
  if (!Value.Check(schema, value)) throw new EvidenceError("invalid-parameters", `${tool}: invalid or unsupported v1 parameters. Legacy synthesis parameters are not accepted; use perplexity_research for synthesis and get_search_content({responseId}) for stored reads.`);
  return value;
}
export function diagnostic(error: unknown, index: number): Diagnostic {
  // Never echo transport/provider error bodies, URLs (query secrets), or credentials.
  return { index, code: error instanceof EvidenceError ? error.code : "operation-failed", message: error instanceof EvidenceError ? error.message.slice(0, 240) : "Operation failed; no fallback was attempted." };
}
const diagnosticSchema = strict({ index: Type.Integer(), code: Type.String(), message: Type.String(), stage: Type.Optional(Type.Union([Type.Literal("discovery"), Type.Literal("fetch"), Type.Literal("snapshot")])), sourceId: Type.Optional(IdSchema), snapshotId: Type.Optional(IdSchema), responseId: Type.Optional(IdSchema) });
const discoveryTraceSchema = strict({ activity: Type.Union([Type.Literal("performed"), Type.Literal("reused")]), responseId: Type.Optional(IdSchema), queries: Type.Array(strict({ query: Type.String(), index: Type.Integer(), requestId: Type.Optional(Type.String()), usageStatus: Type.Union([Type.Literal("reported"), Type.Literal("unknown")]), usage: Type.Optional(Type.Unknown()) })) });
const candidateSchema = strict({ id: IdSchema, providerId: Type.String(), queryIndex: Type.Integer(), title: Type.String(), url: Type.String(), snippet: Type.String(), provenance: Type.Literal("provider-snippet"), date: Type.Optional(Type.String()), lastUpdated: Type.Optional(Type.String()), snapshotId: Type.Optional(IdSchema), fetchError: Type.Optional(Type.String()) });
const snapshotMetadata = strict({ id: IdSchema, requestedUrl: Type.String(), finalUrl: Type.String(), fetchedAt: Type.String(), representation: Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("readable-html")]), extractorVersion: Type.String(), contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }), textLength: Type.Integer({ minimum: 0 }), preview: Type.String(), nextOffset: Type.Optional(Type.Integer()) });
// Every originally attempted discovery query with its original index, including
// attempts that failed; successful-query validation stays on `queries`.
const attemptedQuerySchema = strict({ query: Type.String(), index: Type.Integer() });
export const SearchOutput = strict({ schemaVersion: Type.Literal(1), responseId: IdSchema, status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]), queries: Type.Array(strict({ query: Type.String(), index: Type.Integer(), requestId: Type.Optional(Type.String()), usage: Type.Optional(Type.Unknown()) })), attempts: Type.Optional(Type.Array(attemptedQuerySchema)), sources: Type.Array(candidateSchema), snapshots: Type.Array(snapshotMetadata), errors: Type.Array(diagnosticSchema), limitations: Type.Array(Type.String()) });
export const FetchOutput = strict({ schemaVersion: Type.Literal(1), responseId: IdSchema, status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]), snapshots: Type.Array(snapshotMetadata), errors: Type.Array(diagnosticSchema), limitations: Type.Array(Type.String()) });
export const ReadOutput = strict({ schemaVersion: Type.Literal(1), responseId: IdSchema, kind: Type.String(), sourceId: Type.Optional(IdSchema), text: Type.String(), offset: Type.Integer(), end: Type.Integer(), totalLength: Type.Integer(), nextOffset: Type.Optional(Type.Integer()), found: Type.Optional(Type.Boolean()), contentHash: Type.Optional(Type.String()), provenance: Type.String() });
export const CheckOutput = strict({ schemaVersion: Type.Literal(1), responseId: IdSchema, kind: Type.Literal("evidence"), claim: Type.String(), status: Type.Union([Type.Literal("unclear"), Type.Literal("missing-evidence")]), snapshotIds: Type.Array(IdSchema), sources: Type.Array(strict({ snapshotId: IdSchema, url: Type.String(), contentHash: Type.String(), fetchedAt: Type.String(), matched: Type.Boolean() })), passages: Type.Array(strict({ id: IdSchema, snapshotId: IdSchema, start: Type.Integer(), end: Type.Integer(), text: Type.String() })), coverage: strict({ inspected: Type.Integer(), matched: Type.Integer(), failed: Type.Integer() }), errors: Type.Array(diagnosticSchema), limitations: Type.Array(Type.String()), discovery: Type.Optional(discoveryTraceSchema) });
const { schemaVersion: _version, responseId: _response, ...evidenceProperties } = CheckOutput.properties;
export const ArtifactSchema = Type.Union([
  strict({ kind: Type.Literal("search"), queries: SearchOutput.properties.queries, attempts: Type.Optional(Type.Array(attemptedQuerySchema)), sources: SearchOutput.properties.sources, errors: SearchOutput.properties.errors }),
  strict({ kind: Type.Literal("fetch"), snapshotIds: Type.Array(IdSchema), errors: FetchOutput.properties.errors }),
  strict(evidenceProperties),
]);
export function toolResult(schema: any, data: any, summary?: string) {
  if (!Value.Check(schema, data)) throw new EvidenceError("invalid-output", "Internal evidence output did not satisfy its declared schema.");
  const output = data as Record<string, any>;
  const preface = [`Evidence v1 responseId=${output.responseId}; ${output.status ?? output.kind ?? "stored-content"}.`,
    ...(Array.isArray(output.errors) && output.errors.length ? [`Partial retrieval diagnostics: ${output.errors.map((error: Diagnostic) => `${error.index}:${error.code}`).join(", ")}`] : []),
    ...(output.discovery ? [`Discovery ${output.discovery.activity}; stored search responseId=${output.discovery.responseId ?? "unavailable (discovery failed)"}; external usage ${output.discovery.queries.map((query: DiscoveryTrace["queries"][number]) => `${query.index}:${query.usageStatus}`).join(", ")}. Supplied usage is retained in discovery.queries; unknown does not mean zero cost.`] : []),
    ...(Array.isArray(output.limitations) ? output.limitations : []),
  ].join("\n");
  const text = summary ?? `${preface}\n\n${JSON.stringify(output)}`;
  return { content: [{ type: "text" as const, text: text.slice(0, 16000) + (text.length > 16000 ? `\n[Truncated. Read stored responseId ${output.responseId} with get_search_content.]` : "") }], structuredContent: output, details: output };
}
