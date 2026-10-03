# Perplexity: evidence-first v1

A deliberately narrow local evidence contract plus explicit provider synthesis.
This is **not** a full `pi-web-access` replacement. Do not load two owners of the
same tool names. The preserved [review proposal](./REVIEW-AND-IMPLEMENTATION-PLAN.md)
is a historical design/review record; its recommended narrow v1 is now implemented.
Its original proposal-only status is intentionally not rewritten.

## Setup and data disclosure

Requires Pi 1.0.0's `outputSchema`/`structuredContent` and model-registry APIs.
The package manifest loads `extensions/perplexity/index.ts`; install/load sof-pi
as a Pi package. **Before `/reload`, install the declared runtime dependencies**
using the normal package workflow: Pi installs them for managed npm/git packages;
for this local checkout, run `pnpm install --ignore-scripts --frozen-lockfile` from
its package root. Local Pi packages are not installed automatically. The new
runtime dependencies are currently absent from this checkout's node_modules;
temporary test links are removed after validation, so this is not a claim of
runtime readiness before normal installation. Reload after installation/changes.
Search and synthesis require a
`PERPLEXITY_API_KEY` supplied by the operator and appropriate Perplexity API billing
access. No consumer subscription-plan requirement is asserted. Local stored reads
and direct source fetching require no provider key. Nothing contacts a provider or
reads credentials at extension load/session resume.

Queries and filters go to first-party `POST https://api.perplexity.ai/search`.
Explicit synthesis and panel input/replayed prior turns go to
`POST https://api.perplexity.ai/v1/agent`. Requests use `store:false` with no
previous-response continuation; that is a request policy, **not a guarantee about
all upstream logging/retention**. Direct fetches disclose requested paths to source
hosts. Recap creation sends panel text/sources to the selected current Pi model.
Do not send private data unless those recipients are approved.

External provider usage is preserved when supplied (search `queries[].usage`, source-check `discovery.queries[].usage` with per-query `usageStatus`, synthesis `externalUsage`, panel external-usage display), separately from Pi-model usage. Missing/null or failed-query usage is `unknown`, not zero cost. Newly persisted search artifacts also store an optional `attempts` list enumerating every attempted discovery query with its original index, successful or failed; reuse traces enumerate all stored attempts, and failed attempts surface with `usageStatus:"unknown"` (old artifacts without `attempts` keep successful-only traces). Source-check `discovery.responseId` is an accessible scoped stored-search handle; `activity` distinguishes discovery performed for the check from historical discovery reused without network. The trace describes the originating operation, not the selected source subset or a new charge on reuse. If all discovery fails but explicit URLs succeed, usage stays unknown and no search handle is fabricated. Recap generation can incur current-Pi-model cost in addition to Perplexity cost. No hidden retry/provider fallback, background provider job, or higher-preset escalation exists.

## Breaking migration

- `web_search` now discovers candidates/snippets, not synthesized answers;
  `includeContent` defaults **false** and explicitly fetches pages when true.
- `fetch_content` now fetches actual source text, never a guessed summary. Old
  `prompt`/`maxTokens` arguments fail. No PDF/browser/auth support.
- `get_search_content` now reads stored content; old `query`/`queries`/`prompt`
  synthesis calls fail with a migration message. It never refetches on expiry.
- Use `perplexity_research` for explicit synthesis. Sonar, chat-completions,
  model/deep-research toggles and legacy fallback are removed.
- `source_check` assembles lexical evidence, not semantic fact-check verdicts.

All five tools declare `outputSchema`, validate actual `structuredContent`, and
return matching `details`. Unknown arguments/ambiguous modes fail loudly.
Per-operation failures are explicit; successful siblings survive in partial
results. All-failed retrieval throws. Valid empty discovery is a successful empty
search, not a malformed response. Cancellation remains cancellation.

## Exact tool inputs

| Tool | Inputs and behavior |
| --- | --- |
| `web_search` | Exactly `query` OR `queries` (1–5); optional `numResults` (1–10, default 5), `recencyFilter` (`hour/day/week/month/year`), `domainFilter` (max 20 plain domains, allowlist OR all `-` exclusions), `includeContent` (default false). Native Search controls, no prose filter hints. At most five explicit page fetches across the call. |
| `fetch_content` | Exactly `url` OR `urls` (1–5). Direct public text/Markdown/HTML fetching, exact stored text + snapshot metadata/preview. |
| `get_search_content` | Required opaque `responseId`; optional `sourceId` OR `queryIndex` (zero-based original successful query index); optional `offset`/`limit` (1–12000, default 4000) OR `findText` (case-sensitive literal). No match: `found:false`, empty text. No network/model activity. |
| `source_check` | Required `claim`; existing `responseId` with optional `sourceIds` OR explicit `queries`/`urls` for new retrieval. Modes cannot mix. No implicit network. At most five fetched URLs per explicit retrieval. |
| `perplexity_research` | Required `query`; optional `maxTokens` (1–8192, default 1200). One fast-only Agent API synthesis request. No `model`, `preset`, filters, or batch inputs. |

Example inspection:

```text
web_search({queries:["official API limits", "API limits qualifications"]})
fetch_content({url:"https://example.com/docs"})
source_check({claim:"The API supports this limit", responseId:"<fetch responseId>"})
get_search_content({responseId:"<fetch responseId>", sourceId:"<snapshot id>", offset:4000, limit:4000})
```

Search `sources[].id` selects the **provider snippet**, even if that candidate has
`snapshotId`. To read page text choose `snapshotId`, a fetch/evidence snapshot ID,
or read a snapshot directly as `responseId` with no selector. `source_check`
accepts search candidate IDs only when backed by snapshots; snippets never get
fabricated page hashes or offsets. Search preview snippets are 400 characters;
full bounded snippets remain stored. Page previews are 4000 characters with
`nextOffset`. Model text is bounded to 16000 characters plus a continuation notice.
Failure/limitation information precedes truncated payloads.

Source-check selectors are deduplicated before snapshot loading, coverage and passage assembly. Whole-artifact reuse retains applicable stored retrieval diagnostics and explicit uninspected/budget-skipped source gaps; selecting successful sources does not attach unrelated failures. Diagnostics may include `stage`, local `sourceId`/`snapshotId`, and origin cache `responseId`. `coverage.inspected` counts distinct inspected snapshots; `coverage.failed` counts diagnostic entries, including discovery failures and uninspected/budget-skipped gaps, not just failed HTTP requests. Optional `discovery` metadata is returned and persisted with evidence artifacts and is available through stored paging/find reads; the nested search handle and usage-status summary also precede truncated model text. Selected search candidates still require existing snapshots.

Evidence handles are opaque UUIDs scoped to the current Pi session. The synthesis
`responseId` is an **upstream provider ID**, not a cache handle, and cannot be used
with the stored-content getter. Synthesis machine output retains the bounded full
answer even if its model-facing text truncates; it is not persisted as evidence.

## Provenance and judgments

Fetched snapshots retain requested/final URL, fetchedAt, representation,
extractorVersion, SHA-256 of the exact stored UTF-8 text, and content length.
Passages satisfy `snapshot.text.slice(start,end) === passage.text`; offsets are
JavaScript UTF-16 positions, **not HTML byte offsets**.

Only `unclear` and `missing-evidence` are automated statuses. Lexical overlap
selects at most 10 passages, at most 3 per snapshot, ranking the first 5000 hits.
After the global cap, a source may be reported `matched:true` without any of its
passages being emitted; `coverage.matched` counts lexically matching distinct
sources, not emitted passages. This is not calibrated confidence, support,
contradiction, or authority. No match
does not mean false. Bounded context may miss distant qualifications; inspect
stored context before judging. A hash identifies content, not truth. All retrieved
text is untrusted data, not instructions. Static extraction is not consent/error
page detection, browser rendering, or readability benchmarking.

## Public-fetch and resource policy

- Public HTTP(S), standard ports 80/443; no URL credentials, auth/cookie forwarding,
  proxy routing, local files, browser, PDF/OCR, video, or repo cloning.
- Every DNS answer must be public; the actual request uses a pinned vetted address
  with no second lookup/no pooled agent. HTTPS verifies certificates using the
  original hostname. Every redirect URL and DNS answer is revalidated. Private,
  reserved, mapped IPv6 and special/transition/translation ranges are blocked.
- 30-second total fetch deadline (DNS/headers/body/redirects), five redirects,
  16 KiB headers, 2 MiB downloaded/decompressed/extracted UTF-8 text limits.
  Supported encodings: identity/gzip/deflate/br. Unsupported MIME/charset/encoding
  fails explicitly. HTML extraction additionally rejects more than 256 nested elements or 100000 structural callback tokens (`html-structure-limit`), before parser stack growth can become quadratic. Parsing yields between 8192-character chunks and checks caller/shutdown abort plus a monotonic deadline around bounded extraction work. It preserves static text/tables/nearby wording and preformatted code verbatim (indentation, tabs, and blank lines inside `<pre>` survive normalization; only surrounding prose whitespace collapses), excludes scripts/styles/explicitly hidden elements; plain text and Markdown retain decoded strings exactly. It does not evaluate CSS or JavaScript. Definition-list tags (`dl`, `dt`, `dd`) are block boundaries like headings and list items, so whitespace-free definition-list HTML yields separated term/definition words instead of fused tokens. Native disclosure tags (`details`, `summary`) are also block boundaries, so whitespace-free disclosure markup yields separated summary/content words instead of fused tokens (static content only — no CSS or collapsed-visibility semantics). Snapshots fetched by the current extractor label themselves `sof-pi-html-text/5` (bumped from `/4` for the added disclosure boundaries); historical text/hashes are not rewritten, and a mixed cache can contain both versions — `extractorVersion` is descriptive, never a schema or validity gate.
- Three active operations shared across evidence tools and synthesis tool per
  extension registration. Independent child registrations/panels have separate
  budgets; this is not a host-wide provider concurrency quota.
- Provider deadlines: Search 30s; research 90s, including body consumption.
  The research deadline is one absolute monotonic clock shared by the timeout
  timer and the body-consumption loop, checked before every read and before any
  success return — a consume that finishes after the deadline can never report
  success, and caller abort still delivers `AbortError` first.
  Encoded requests 256 KiB; decoded JSON/SSE frame 2 MiB; total SSE 8 MiB.
  Readers cancel/release on success/error/abort; provider redirects fail.
- Typed SSE preview deltas are not authoritative. A complete completed typed
  envelope supplies final text/sources/usage. EOF/DONE without completion and
  failed/incomplete/malformed states fail, not successful partial synthesis.
- Streaming frames the response over RAW received bytes, not decoded text, and
  ends dispatch at the FIRST valid authoritative `response.completed`, with
  identical behavior across chunk framings (single chunk, separate chunks,
  byte-split, delimiters straddling chunk edges): trailing duplicate-terminal/
  failure/unknown/malformed frames after the terminal are never parsed, the
  reader is cancelled and released, and no further chunks are consumed, so a
  never-closing upstream cannot hang a completed stream. The total-SSE budget
  and fatal UTF-8 decoding apply to the byte prefix processed through the first
  authoritative completion; unread trailing bytes after it — including invalid
  UTF-8 sequences or a tail larger than the whole 8 MiB budget — are never
  scanned, decoded, or charged, regardless of how they arrive in chunks.
  Buffering is amortized linear: chunks are scanned in place and only the
  undelimited in-progress frame is retained, with periodic event-loop yields
  during immediately-ready fragment reads so deadline/abort timers keep firing
  (a valid 2 MiB stream in 16-byte fragments completes in bounded time, not
  quadratic). The pending-frame cap excludes only an actual trailing partial
  blank-line delimiter prefix (≤ 3 bytes), so a legal max-size frame succeeds
  no matter where delimiters split across chunks, while any true oversize
  frame still fails — the exact frame cap is enforced at every frame dispatch
  and at the final flush; every pre-terminal byte is charged to the total
  budget exactly once.
  Accepted limitation: post-terminal bytes remaining in the final received chunk
  (including any pending partial frame) are neither parsed nor frame-limit
  evaluated. Pre-terminal invalid UTF-8 and pre-terminal body-limit excess fail
  in every chunk layout; pre-completion frame/body limits, malformed-JSON,
  failure-event, and abort/deadline behavior are unchanged.
- Panel-submitted queries are preflight-validated with the exact shared transport
  validation (`preflightResearchRequest`) before any commit: an over-limit or
  malformed query is rejected locally with no fetch, no key access, and no
  billable work; the typed error `code` (`request-size-limit`, `message-limit`,
  `invalid-request`) is surfaced with the actionable message.
- Dynamic `fast` uses `max_steps:1`, `web_search.max_results:5`, `store:false`.
  **Perplexity manages and may change this preset.** Tools merge with defaults;
  requests cannot clear future extra defaults. The adapter rejects incompatible
  returned traces but cannot prevent upstream capability/cost changes before a
  response. Do not claim a frozen tool/cost guarantee.

## Private cache and isolation

Default root: `~/.cache/sof-pi/evidence-v1`. One-hour TTL per record, 128 records /
64 MiB per session scope; host cap **512 MiB / 2048 records**; serialized record cap
16 MiB. Oldest records evict first. Expired/missing/evicted reads never refetch.
Eviction can remove snapshots referenced by younger artifacts, producing explicit
missing-evidence/handle errors. Caps cover record data, not directory metadata.

Session IDs determine scope at each execution, not cwd or inherited parent entries.
Resume retains scope; new children/forks isolate. Full pages remain on disk, not
session entries; only scope metadata and bounded result handles enter session state.
No cross-scope export/import in v1: independent auditors refetch public URLs.

Quota planning uses a compact schema-versioned metadata index,
`<cache-root>/.evidence-quota-v1.json`, so inserts do not re-read or rehash other
records' payloads. The file is root-private (never inside a scope directory, so
scope listing semantics are unchanged), written atomically at 0600 under the same
cross-process writer lock, and bounded: at most 8192 entries / 2 MiB (~180 bytes
per entry; ≤ ~400 KiB at the host cap). Each entry records id, scope directory,
byte size, and creation/expiry timestamps. Eviction semantics are unchanged —
TTL/count/bytes oldest-first, same own-scope/host caps — but planning does
stat-level identity/size checks instead of payload scans, so concurrent writers no
longer contend for multi-second full-cache rescans. The first write after an
upgrade (missing metadata file) performs a one-time explicit rebuild: a full
read+validate of existing records, indexing only what is already on disk — no
refetch, no new IDs; measured 1.4–1.8s cold at a ~480 MiB cache). The 2 MiB bound is enforced
identically on load: an oversized metadata file is stat-rejected before any
content is read, parsed, or rewritten. Load-time validation also rejects
duplicate `(scope, id)` identities and entries whose `expiresAt` is not after
their `createdAt` before any eviction can act, so corrupt metadata cannot
silently delete valid records. Divergence is handled
explicitly: a metadata-listed file missing on disk is dropped as a stale entry; a
record on disk absent from the metadata triggers one rebuild; a size mismatch
between metadata and disk (records are immutable) fails loudly with
`invalid-cache-schema` rather than allowing a quota bypass; and corrupt or
foreign-version metadata fails loudly while reads stay available. The warm
planner applies a stat-only POSIX private-file permission gate (records and
metadata must be owner-only, checked via mode bits without reloading payload
text). Safe operator
recovery: stop all writers, then delete `.evidence-quota-v1.json` — the next write
rebuilds it. Old pre-metadata writers simply re-trigger rebuilds (correct but
slower) until they are gone.

Atomic schema-versioned writes/file syncing, POSIX 0700 directories and 0600 files
(including the quota metadata), no-follow opens. Windows permissions/no-follow are
best effort, not ACL guarantees. A cross-process directory lock serializes
writes/quota enforcement; a crashed lock fails closed with `cache-busy` after 10s.
Recovery: stop **all** writers before removing `<cache-root>/.write-lock`; next
write removes owned stale atomic-write temporary files — including root-level
`.tmp-quota-<uuid>` leftovers of a failed index write, collected under the
writer lock and unlinked after the cancellation commit boundary (only validated
UUID names; unknown or malformed names are never touched). Do not remove a live
writer lock.

Lock waits and read-only quota planning are abortable. A cancellation before record mutation cannot evict or write records. Once record mutation starts, bounded atomic write/temporary cleanup/lock release completes before cancellation is reported; a committed cache record may therefore remain after a late abort. No expired or cancelled handle is silently refetched.

## Research roles and child loading

Packaged `agents/researcher.md` and `agents/evidence-auditor.md` shadow builtin
roles wholesale using package-over-builtin precedence. User/project definitions
and settings overrides still win. Models remain inherited; researcher keeps read/
write brief output, auditor is read-only/high-thinking with `defaultContext:fresh`.
Explicit launch context/global defaultContext settings can override that default.
Neither role has `perplexity_research`: synthesis is not an evidence audit.

Both specify empty `extensions:` (no ambient providers) and
`subagentOnlyExtensions: ../extensions/perplexity/index.ts`. pi-subagents resolves
that path relative to the profile file, **not cwd**. In this checkout the exact
resolved path is:
`/Users/sofianebebert/workspace/sof-pi/extensions/perplexity/index.ts`.
In another install it is `<sof-pi package root>/extensions/perplexity/index.ts`.
This explicit loading policy works for foreground and background native children;
an allowlisted tool name alone never loads its provider. Do not copy a profile to
a different directory without adjusting its relative extension path.

Offline tests use isolated settings, ExtensionAPI/host-UI fixtures, and registry
allowlist checks; they verify package selection, user/project shadows, schema
results, and resolved paths without a child model turn. The installed-discovery
smoke additionally checks a real installed pi-subagents source; it is opt-in via
`SOF_PI_SUBAGENTS_INTEGRATION=1` (location via `PI_SUBAGENTS_PATH`, or
`npm run test:perplexity:integration`) and is reported as skipped with a
prerequisite message by default — a skipped smoke is never counted as verified
child loading, and opting in without a compatible installation fails loudly. **Actual child execution/terminal rendering/live billing are not claimed
verified.** Reload and start a new run; verify effective profiles after overrides.

## `/research` human approval

Fast-only interactive panel: Enter sends a query; Up/Down scroll; Ctrl+R explicitly
builds a recap; Ctrl+N deliberately starts a new session; Esc/Ctrl+C cancels current
work or closes/discards when idle. Final typed response text wins over streamed
previews. Partial cancelled answers remain visibly labelled. Sources display
explicit provider IDs; unknown references warn. Prior turns replay with scoped IDs,
never guessed array-order numbering.

Rejected input never poisons the session: a query that fails the shared preflight
(oversized encoded request, message-count/shape limits, or invalid options) is
rejected locally before the user turn is committed — no fetch, no key lookup, no
billable work; the transcript, citation scopes, and scroll state are untouched, and
the submitted text stays editable in the input for correction. Error/status
transcript lines render wrapped (never truncated) to the panel's current render
width using the host's ANSI-aware wrapping, so oversized rejection guidance —
including long or multiline messages — stays fully visible and actionable at
narrow terminals instead of emitting an over-width line. When the accepted
history alone already exhausts the provider replay budget, the rejection says
`history replay budget exhausted` and explicitly offers Ctrl+R recap or Ctrl+N new
session instead of truncating or silently renumbering anything. Ctrl+N is reachable
only from idle/error — never during an active search or recap — and clears the
panel transcript/render/source state on that explicit action while keeping the
current input text. There is no automatic truncation, scope renumbering, or replay
dropping anywhere.

Recaps use the current Pi model with turn-scoped IDs (`[t2:8]`); generated unknown
or bare numeric references are marked unresolved and a validated registry is
appended. Then an editable preview opens. Only an approved nonempty edit is loaded
into the main input editor; the user must manually submit it. No sendUserMessage,
automatic context injection, or implementation side effect. Isolation is logical
in-process UI state, not a security/process boundary. Human edits are deliberate
and are not rewritten or revalidated afterward.

## Files, dependencies, validation

`index.ts` is thin registration/recap wiring; `perplexity.ts` owns Search/Agent
transport; `citations.ts` source-ID scoping; `research-panel.ts` UI;
`contracts.ts`, `source-fetch.ts`, `evidence-store.ts`, `source-check.ts`,
`web-tools.ts` implement the bounded evidence contract.

Runtime additions: `htmlparser2@10.0.0` (deterministic HTML parser),
`ipaddr.js@2.5.0` (updated special-address classification). `typebox:*` is a
host-supplied peer, not bundled. No pi-web-access dependency.

`npm test` retains factory tests and includes `tests/perplexity/*.test.ts`.
All Perplexity tests are offline injected fixtures (plus loopback transport);
`npm run test:perplexity:integration` additionally opts into the installed
discovery smoke described above.
Factory tests additionally require a usable installed pi-subagents source/dependency
tree (`PI_SUBAGENTS_PATH` override supported by their harness). No live provider
canary was run; public-doc quality/cost evaluation remains explicit operator opt-in.
