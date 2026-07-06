# Perplexity Extension

Web search and interactive research via the [Perplexity API](https://docs.perplexity.ai/),
designed to keep raw search traffic **out of your main pi context window**.

Two pieces:

1. **`perplexity_search` tool** — single-shot LLM-callable web search. Returns the
   answer plus numbered sources. Good for quick lookups the model can do inline.
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

## The `perplexity_search` tool

Called by the LLM like any other tool.

| Parameter    | Type     | Notes                                            |
|--------------|----------|--------------------------------------------------|
| `query`      | string   | The web search query.                            |
| `model`      | enum     | `sonar`, `sonar-pro` (default), `sonar-reasoning`, `sonar-reasoning-pro`. |
| `max_tokens` | number?  | Optional cap on answer length.                   |

Output is truncated to 50 KB (built-in pi limit). Sources are appended as a
numbered list; collapsed view shows the first line + source count, expand
(Ctrl+O) renders the full answer as markdown.

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
- `index.ts` — registers the `perplexity_search` tool and the `/research`
  command, plus the recap synthesis prompt.
