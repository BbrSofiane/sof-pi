# sof-pi

Personal pi package — workflows, extensions, skills, prompt templates, and themes primarily for Sofiane.

## Structure

```
sof-pi/
├── extensions/   # .ts / .js extensions
├── agents/       # pi-subagents agent overrides
├── skills/       # SKILL.md folders / top-level .md skills
├── prompts/      # .md prompt templates
├── themes/       # .json themes
└── package.json  # pi manifest
```

## Skills

| Skill | Triggers |
| --- | --- |
| **[weekly-planning](./skills/weekly-planning)** | Sofiane's Monday weekly planning or Friday weekly retro. Reads Notion Projects, Tasks, and Daily Work, uses a calendar screenshot for planning, sets 3 project-anchored objectives, writes Notion Daily Work plans/reviews, maintains the local Tolaria weekly plan/retro note, and includes a Wheel of Life reflection in retros. |
| **[notion-cli](./skills/notion)** | Interact with Notion via the `ntn` CLI — reading/writing pages, querying databases, managing blocks, automating Notion workflows from the terminal. |
| **[google-workspace](./skills/google-workspace)** | Interact with Google Workspace via the `gog` CLI — Gmail, Calendar, Drive, Tasks, Sheets, Docs, Slides, Chat, Contacts, People, Keep, Forms, Meet, Apps Script, and more. |
| **[mise](./skills/mise)** | Manage dev tools, runtime versions, and environment variables with `mise`, and run mise tasks (make-like commands). |
| **[github-cli](./skills/github-cli)** | Interact with GitHub via the `gh` CLI — cloning repos for inspecting dependencies/third-party projects, checking GitHub Actions pipeline logs and statuses, viewing workflow runs, and ad-hoc GitHub API calls. |
| **[stripe-projects](./skills/stripe-projects)** | Use Stripe Projects via the `stripe projects` CLI plugin — initializing projects, browsing the live provider/service catalog, provisioning third-party services, managing environments and credentials, syncing them to `.env`, and inspecting project status. |
| **[fly-io](./skills/fly-io)** | Interact with Fly.io via `flyctl` — making deliberate deploy, targeting, authentication, scaling, storage, networking, and Managed Postgres (MPG) decisions, including resources provisioned through Stripe Projects. |
| **[exe-dev](./skills/exe-dev)** | Deploy and operate persistent exe.dev Linux VMs over SSH — distinguishing the restricted lobby from direct VM access, choosing image/setup strategies, exposing HTTPS safely, sharing access, managing integrations, and automating with the HTTPS API. |
| **[database-query](./skills/database-query)** | Run SQL queries against a relational database from the terminal via the `usql` CLI — Postgres, MySQL/MariaDB, SQLite, SQL Server, Oracle, and other Go `database/sql`-backed databases. Non-interactive/scriptable patterns for embedding database access in automated workflows: run a query and exit (`-c`), execute a query file (`-f`), pipe SQL via stdin, export results as JSON (`-J`) or CSV (`-C`), introspect the schema (`\dt`, `\d`). |
| **[browser](./skills/browser)** | Drive a real headless browser from the terminal with [`rodney`](https://github.com/simonw/rodney) (Go CLI over a persistent headless Chrome via CDP/rod) to check what's on a web page after JS renders — inspect title/text/HTML/attributes, run JS, assert conditions (`exists`/`visible`/`assert`), audit accessibility, and capture screenshots/PDFs. Triggers on "check what's on this page", "screenshot this URL", "open this in a browser and look at it", "is this element on the page", "does the page show X", or "audit accessibility on this page". |
| **[whatsapp](./skills/whatsapp)** | Send a WhatsApp message (text or media) or inspect a [ruwa](https://github.com/oqva-digital/ruwa) WhatsApp instance from the terminal — list chats, list messages, show the pairing QR, pair via phone code, or list sessions. A `uv` inline-script CLI (`httpx`) wraps the ruwa HTTP API so the agent doesn't hand-roll `curl` + bearer headers + session IDs. Config from env (`RUWA_API_ENDPOINT`, `RUWA_API_TOKEN`, optional `RUWA_SESSION`) or CLI flags. Triggers on "send a whatsapp message", "whatsapp", "message someone on whatsapp", "send a photo on whatsapp", "show my whatsapp chats", or "pair a whatsapp number". |
| **[tldraw-offline](./skills/tldraw-offline)** | Operate the user's tldraw offline canvas app, including open `.tldraw` or `.tldr` files. Use whenever a task involves inspecting, editing, arranging, connecting, linting, or scripting a tldraw Desktop canvas. |
| **[background-terminals](./skills/background-terminals)** | Run and manage long-lived shell commands in background terminals. Use for dev servers, watchers, streaming builds, and other commands that should keep running while the agent continues working. |

## Extensions

### Perplexity (`extensions/perplexity/`)

Web search and interactive research via the [Perplexity API](https://docs.perplexity.ai/), designed to keep raw search traffic out of the main pi context window. Two pieces:

1. **Web tools (`web_search`, `fetch_content`, `get_search_content`)** — Perplexity-backed stand-ins for the `pi-web-access` tools that pi-subagents' `researcher` and `context-builder` agents list in their `tools:` frontmatter. Without them, subagent runs that reference `web_search` fail with an "unavailable tool" error. They synthesize answers with cited sources rather than returning raw result snippets.
2. **`/research` command** — an interactive, full-screen research panel for back-and-forth Perplexity sessions (queries + streamed answers + sources). Build a recap you can shape in an editor and inject into your main thread; intermediate search content stays in the panel and is discarded unless you build a recap.

See [`extensions/perplexity/README.md`](./extensions/perplexity/README.md) for details.

### Background Terminals (`extensions/background-terminals/`)

Four LLM tools (`bg_start`, `bg_status`, `bg_list`, `bg_kill`) for long-running background shell processes — dev servers, watchers, streaming builds. Processes are fire-and-forget with stdin ignored (immediate EOF); the model gets exactly one completion notification when a process exits. A `/ps` overlay command opens a two-stage full-screen inspector (dashboard → read-only detail with stdout/stderr toggle) to inspect live output and kill terminals interactively. While ≥1 terminal runs, a one-line widget appears above the editor. Output is captured to bounded in-memory buffers plus on-disk spill files; tool and completion output shows a concise tail. Terminals are session-scoped and stopped during shutdown or reload. Bundled in this package — no separate install needed.

### Learning (`extensions/learning/`)

Project-based learning mode built around ramps to knowledge rather than syllabi. `/learn <concept>` asks for the learner's starting point and timebox, proposes a few tiny projects where the concept becomes necessary, and coaches through short need → attempt → friction → minimum lesson → application → proof cycles. `/learn-status` shows the active ramp and `/learn-stop` exits it. State is persisted on the current pi session branch, and an active ramp appears in the footer. See [`extensions/learning/README.md`](./extensions/learning/README.md) for behavior and examples.

## Agents

### `reviewer` override (`agents/reviewer.md`)

Shadows the builtin pi-subagents `reviewer` for every project where sof-pi is installed (package agents load above builtins). It keeps the builtin review structure and appends the sof-pi **Review Rubric**: flagging discipline, untrusted-input checks, fail-fast error handling, `[P0]–[P3]` priority tags, and the required non-blocking **Human Reviewer Callouts** section. Every `subagent({ agent: "reviewer" })`, `/parallel-review`, and `/review-loop` run therefore applies the same rubric automatically. A project can still override locally by dropping its own `reviewer.md` into the project agents directory.

## Installed Packages

Beyond the extensions bundled in this package, I rely on a couple of npm-installed pi packages that add their own extensions/skills.

### [`@robhowley/pi-openrouter`](https://github.com/robhowley/pi-userland)

Live OpenRouter visibility and environment sync for pi: usage/account TUI overlays, automatic `session_id` tagging, full or free-only model catalog sync, API key management, and local model field overrides. Exposes a set of `/openrouter` commands:

- `/openrouter usage` — spend/usage overlay
- `/openrouter account` — credits, key limits, account health, key toggle UI
- `/openrouter session` — current OpenRouter session_id
- `/openrouter api-key-create` — create an API key (management key required)
- `/openrouter models-sync` / `--free` — sync user-scoped (or free-only) models into pi
- `/openrouter models-status` / `--free` / `--skipped` — show model sync/cache status
- `/openrouter model-override-set|list|clear` — local model field overrides

Install: `pi install npm:@robhowley/pi-openrouter`

### [`pi-subagents`](https://github.com/nicobailon/pi-subagents)

Lets pi delegate work to focused child agents — for code review, scouting, implementation, parallel audits, saved workflows, and background jobs. Supports single-agent delegation, sequential chains, parallel fan-out, async/background runs, forked-context review, and a `/research`-style TUI clarification flow. Plain-language delegation works out of the box (no config or slash commands needed), with builtin agents like `reviewer`, `scout`, and `oracle` ready to go.

Install: `pi install npm:pi-subagents`

## exe.dev workspace

This package includes a version-controlled `mise` control plane for one private, persistent exe.dev VM: `sof-pi-workspace` (`sof-pi-workspace.exe.xyz`), tagged `sof-pi`. It clones only `https://sof-pi.int.exe.xyz/BbrSofiane/sof-pi.git`; the pre-attached tag-scoped `sof-pi` GitHub integration must provide that access.

**Prerequisites:** local `mise`, `ssh` with an identity registered at exe.dev, Python 3, `jq`, `git`, and the pre-attached GitHub integration. First inspect, then explicitly provision:

```bash
mise run workspace:status
mise run workspace:provision
```

`provision` creates the fixed name only when it is absent, polls the control plane until the exact host/tag and explicit private state are verified, then waits for direct SSH and bootstraps. Repeating `create`, `bootstrap`, or `sync` is intended to converge; an unexpected VM tag/host, dirty checkout, or wrong Git origin stops rather than repairing or deleting data. No task exposes a port, makes the VM public, or attaches/detaches integrations.

Only reviewed scalar-string tool versions from the local mise global config's `[tools]` and the explicitly allowlisted `[settings].experimental` boolean are projected to the VM (`workspace:sync`). The mirror is exact on each successful sync: locally removed tools/settings disappear remotely. Tables, lists, URLs, paths, whitespace-bearing specs, credentials/options/hooks, unknown tools, and non-boolean settings are rejected rather than copied. `[env]` is never read into output or copied. SSH keys/config, Pi auth/settings, GitHub/cloud credentials, and API keys are never copied. Every mutable or direct operation verifies an explicit `sharing.public_proxy = false` state and stops on public, missing, or malformed privacy state; `workspace:status` may report such an unsafe VM without connecting to it.

```bash
mise run workspace:sync
mise run workspace:update
mise run workspace:ssh                         # interactive direct SSH
mise run workspace:ssh -- uptime
mise run workspace:pi                          # tmux session: sof-pi-interactive
mise run workspace:job:start -- --id docs-01 --prompt-file ./prompt.md
mise run workspace:job:status -- --id docs-01
mise run workspace:job:logs -- --id docs-01
mise run workspace:job:attach -- --id docs-01
mise run workspace:job:stop -- --id docs-01
```

Jobs have an isolated `pi/<id>` branch and VM-local worktree; they never edit `main` concurrently. Each job branches from the verified canonical checkout's current `HEAD`; run `mise run workspace:update` first when a job needs the latest remote `main`. Bootstrap installs the checked-in VM job helper from that verified checkout, and every job action invokes that installed copy as the sole runtime implementation—the laptop sends only the prompt over stdin. Prompts, logs, and status are private at rest on the VM with restrictive permissions; logs and status stream only to the authenticated invoking SSH client when explicitly requested. Package installation is automated and pins `npm:@robhowley/pi-openrouter@0.13.0` and `npm:pi-subagents@0.35.1`, but Pi provider access needs a separately approved VM-native authentication/integration route; neither interactive nor unattended jobs receive copied credentials.

Deletion is intentionally opt-in and permanently removes the VM disk and all VM-local state. It is never part of another task:

```bash
CONFIRM_DESTROY=sof-pi-workspace mise run workspace:destroy
```

Run offline controller/sanitizer tests with `mise run workspace:test`. The first live bootstrap requires this workflow to be committed and available on the integration clone's `main` branch, because the checked-in job helper is installed only from that verified checkout; after publishing it, rerun `mise run workspace:bootstrap` (or `workspace:update`).

## Design

### Impeccable

[Impeccable](https://github.com/pbakaus/impeccable) ([impeccable.style](https://impeccable.style/docs/)) is the design skill used across projects — a frontend design language with design commands (shape, craft, audit, polish, critique, etc.) and deterministic anti-pattern detection. It's installed as a standalone pi skill (not bundled into this package) so it updates independently via its own CLI.

Install globally so it's available in every project:

```bash
npx impeccable skills install -y --providers=pi --scope=user
```

This writes to `~/.pi/skills/impeccable/`. Reload pi, then run `/impeccable init` in a project to generate its `PRODUCT.md` / `DESIGN.md` context. Update later with `npx impeccable skills update`.

## License

[Apache License 2.0](./LICENSE)
