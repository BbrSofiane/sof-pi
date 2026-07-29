# Perplexity Extension

Web search and interactive research via the [Perplexity API](https://docs.perplexity.ai/),
designed to keep raw search traffic **out of your main pi context window**.

Two pieces:

1. **Web tools (`web_search`, `fetch_content`, `get_search_content`)** —
   Perplexity-backed stand-ins for the [`pi-web-access`](https://github.com/nicobailon/pi-web-access)
   tools that pi-subagents' `researcher` and `context-builder` agents list in
   their `tools:` frontmatter. Without them, subagent runs that reference
   `web_search` fail with an "unavailable tool" error. They keep raw search
   traffic out of your main context by synthesizing answers (with cited sources)
   instead of returning raw result snippets.
2. **`/research` command** — an interactive, full-screen research panel where you
   run a back-and-forth Perplexity session (queries + streamed answers + sources),
   then build a **recap** you can shape in an editor and inject into your main
   thread. All intermediate search content stays inside the panel and is discarded
   unless you build a recap.

## Setup

Requires a Perplexity Pro plan and an API key in your environment:

```sh
export PERPLEXITY_API_KEY=pplx-...
```

The extension is auto-discovered from `~/.pi/agent/extensions/perplexity/` (global).
Reload after changes with `/reload`.

## The web tools

Three Perplexity-backed tools that satisfy the `web_search` / `fetch_content` /
`get_search_content` contract pi-subagents expect from `pi-web-access`. The
parent agent can call them too. All use the `sonar-pro` model; output is
truncated to 50 KB (built-in pi limit), with sources appended as a numbered
list.

### `web_search`

Search the web and return answers with numbered sources. Accepts a single
`query` or a `queries` array (preferred for covering multiple angles in one
call — each query gets its own answer + sources).

| Parameter        | Type       | Notes                                                          |
|------------------|------------|----------------------------------------------------------------|
| `query`          | string?    | A single search query. Prefer `queries` for multiple angles.   |
| `queries`        | string[]?  | Batch of queries; each gets its own answer + sources.          |
| `numResults`     | number?    | Result-count hint (Perplexity controls citation count).        |
| `recencyFilter`  | enum?      | `day` \| `week` \| `month` \| `year` — bias toward recency.   |
| `domainFilter`   | string[]?  | Domains to include (prefix with `-` to exclude). Best-effort. |
| `includeContent` | boolean?   | `true` (default) returns synthesized answers; `false` returns only source lists. |

### `fetch_content`

Read a URL and return a synthesized summary of its content. Perplexity
(`sonar-pro`) fetches the page and answers an optional `prompt` about it.

| Parameter   | Type     | Notes                                                         |
|-------------|----------|---------------------------------------------------------------|
| `url`       | string   | URL to read (http/https/GitHub/PDF).                          |
| `prompt`    | string?  | Instruction for what to extract or answer about the page.     |
| `maxTokens` | number?  | Cap on returned content length.                               |

### `get_search_content`

Search the web and retrieve synthesized content in one step: runs the query,
reads the top result pages, and synthesizes a thorough answer drawing on their
content. Same param shape as `web_search`, plus an optional `prompt` and
`maxTokens`.

> These tools synthesize answers rather than returning raw result snippets.
> `fetch_content` does not clone repos or parse PDFs/YouTube like
> `pi-web-access` does — install that package alongside if you need full URL
> fetching. For most research tasks the Perplexity-backed synthesis is enough.

## The `/research` panel

```
┌ Perplexity Research · sonar-pro ─────────────────────────────────────────┐
│ ❯ your first query                                                       │
│                                                                          │
│ …streamed answer with markdown…                                         │
│ ─────────────────────────────────                                        │
│ [1] Source title https://…                                               │
│                                                                          │
│ …more turns…                                                             │
├────────────────────────────────────────────────────────── 1-12/12 ───────┤
│ ▸ your next query…                                                       │
└ ⏎ send · ctrl+p model · ctrl+t deep-research · ctrl+r recap · ↑↓ scroll · esc close ┘
```

### Keys

| Key            | Action                                                        |
|----------------|---------------------------------------------------------------|
| `Enter`        | Send the current query (answer streams into the transcript). |
| `Ctrl+P`       | Cycle the Perplexity model (sonar → sonar-pro → …).           |
| `Ctrl+T`       | Toggle deep-research mode (`sonar-deep-research`; slower, heavily-cited). |
| `Ctrl+R`       | Build a recap from the transcript (closes the panel).         |
| `Up` / `Down`  | Scroll the transcript (auto-scrolls to bottom while searching). |
| `PgUp` / `PgDn`| Scroll by a page.                                             |
| `Esc` / `Ctrl+C` | Cancel a running search; if idle, close the panel (discards everything). |

### Recap flow (the important part)

When you press `Ctrl+R`:

1. The transcript is sent to your **current pi model** (e.g. Claude) with a prompt
   that produces a structured recap:
   ```
   ## Topic
   ## Key Findings   (3-6 bullets, inline [n] citations)
   ## Sources        (only URLs actually referenced)
   ## Open Questions / Next Steps
   ```
2. The recap opens in a pi editor (`ctx.ui.editor`) for you to **shape** — cut,
   rewrite, add notes. Nothing has entered your context yet.
3. On submit, the recap is loaded into your main input editor via
   `ctx.ui.setEditorText()`. You press `Enter` to inject it — no surprise cost,
   no automatic context pollution.

Everything else (raw answers, intermediate queries, full citation lists) is
discarded. Only the recap you approve reaches your main thread.

## Why not a subprocess (like the subagent example)?

The isolation here is *logical*, not process-level: the research loop runs in a
custom TUI component and the only exit point is the shaped recap. That keeps the
implementation simple (one HTTP client, no child `pi` processes) while still
guaranteeing nothing leaks into your session until you say so. If you later want
the model itself to drive follow-up searches autonomously, the same
`streamPerplexity` client can be wrapped in a subagent-style child process.

## Files

- `perplexity.ts` — API client (OpenAI-compatible chat completions, streaming
  SSE parsing, citation/source merging).
- `research-panel.ts` — `ResearchPanel` custom TUI component (scrollable
  transcript, embedded `Input`, model/deep-research toggles, recap trigger).
- `index.ts` — registers the `web_search` / `fetch_content` / `get_search_content`
  tools and the `/research` command, plus the recap synthesis prompt.
