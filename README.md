# sof-pi

Personal pi package — workflows, extensions, skills, prompt templates, and themes primarily for Sofiane.

## Structure

```
sof-pi/
├── extensions/   # .ts / .js extensions
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
| **[stripe-projects](./skills/stripe-projects)** | Use Stripe Projects via the `stripe projects` CLI plugin — initializing a project, browsing the provider/service catalog, provisioning third-party services (databases, auth, hosting, analytics, AI, storage, observability, etc.) into an app stack, managing environments/credentials and syncing them to .env, and inspecting project status. Also covers the classic `stripe` CLI (webhook listen/trigger, resources, logs) as a secondary reference. |
| **[fly-io](./skills/fly-io)** | Interact with Fly.io via the `flyctl` CLI — deploying apps, launching new apps from source, inspecting app/machine status and logs, scaling resources, and managing Machines, volumes, secrets, IPs, certificates, and Managed Postgres (MPG). Also covers Fly.io provisioned through Stripe Projects (macaroon-token auth, lifecycle handoff). |
| **[exe-dev](./skills/exe-dev)** | Deploy and manage small services on [exe.dev](https://exe.dev) via SSH — creating persistent Linux VMs with instant `https://<vm>.exe.xyz/` HTTPS, customizing with Docker images or setup scripts, exposing ports publicly or privately, sharing access, custom domains, resizing resources, attaching integrations (LLM gateway, HTTP-proxy headers, GitHub), and automating lifecycle from scripts/CI over the HTTPS API. Triggers on "deploy to exe.dev", "create an exe VM", "make my exe VM public", "ssh into my exe vm", or "use the exe.dev HTTPS API". |
| **[database-query](./skills/database-query)** | Run SQL queries against a relational database from the terminal via the `usql` CLI — Postgres, MySQL/MariaDB, SQLite, SQL Server, Oracle, and other Go `database/sql`-backed databases. Non-interactive/scriptable patterns for embedding database access in automated workflows: run a query and exit (`-c`), execute a query file (`-f`), pipe SQL via stdin, export results as JSON (`-J`) or CSV (`-C`), introspect the schema (`\dt`, `\d`). |
| **[browser](./skills/browser)** | Drive a real headless browser from the terminal with [`rodney`](https://github.com/simonw/rodney) (Go CLI over a persistent headless Chrome via CDP/rod) to check what's on a web page after JS renders — inspect title/text/HTML/attributes, run JS, assert conditions (`exists`/`visible`/`assert`), audit accessibility, and capture screenshots/PDFs. Triggers on "check what's on this page", "screenshot this URL", "open this in a browser and look at it", "is this element on the page", "does the page show X", or "audit accessibility on this page". |
| **[whatsapp](./skills/whatsapp)** | Send a WhatsApp message (text or media) or inspect a [ruwa](https://github.com/oqva-digital/ruwa) WhatsApp instance from the terminal — list chats, list messages, show the pairing QR, pair via phone code, or list sessions. A `uv` inline-script CLI (`httpx`) wraps the ruwa HTTP API so the agent doesn't hand-roll `curl` + bearer headers + session IDs. Config from env (`RUWA_API_ENDPOINT`, `RUWA_API_TOKEN`, optional `RUWA_SESSION`) or CLI flags. Triggers on "send a whatsapp message", "whatsapp", "message someone on whatsapp", "send a photo on whatsapp", "show my whatsapp chats", or "pair a whatsapp number". |

## Extensions

### Code Review (`extensions/review.ts`)

Adds a `/review` command that prompts the agent to review code changes. Supports several modes:

- `/review` — interactive selector
- `/review pr 123` — review GitHub PR #123 (checks it out locally)
- `/review pr https://github.com/owner/repo/pull/123` — review a PR from URL
- `/review uncommitted` — review uncommitted changes directly
- `/review branch main` — review against a base branch (PR-style diff)
- `/review commit abc123` — review a specific commit
- `/review folder src docs` — snapshot review of specific folders/files (not a diff)
- `/review --extra "focus on performance regressions"` — add extra review instructions (works with any mode)

Supports shared custom review instructions (added/removed via the selector) and project-specific guidelines from a `REVIEW_GUIDELINES.md` next to `.pi`. PR review requires a clean working tree.

### Perplexity (`extensions/perplexity/`)

Web search and interactive research via the [Perplexity API](https://docs.perplexity.ai/), designed to keep raw search traffic out of the main pi context window. Two pieces:

1. **`perplexity_search` tool** — single-shot LLM-callable web search. Returns the answer plus numbered sources. Good for quick inline lookups.
2. **`/research` command** — an interactive, full-screen research panel for back-and-forth Perplexity sessions (queries + streamed answers + sources). Build a recap you can shape in an editor and inject into your main thread; intermediate search content stays in the panel and is discarded unless you build a recap.

See [`extensions/perplexity/README.md`](./extensions/perplexity/README.md) for details.

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
