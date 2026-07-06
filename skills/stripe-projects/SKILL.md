---
name: stripe-projects
description: Use this skill when the user wants to use Stripe Projects via the `stripe projects` CLI plugin — initializing a project, browsing the provider/service catalog, provisioning third-party services (databases, auth, hosting, analytics, AI, storage, observability, etc.) into an app stack, managing environments/credentials and syncing them to .env, and inspecting project status. Triggers on tasks like "provision a database", "add supabase to my project", "list stripe projects", "pull a stripe project", "browse the stripe catalog", "sync stripe project env vars", or "what providers does stripe projects support". Also covers the classic `stripe` CLI (webhook listen/trigger, resources, logs) as a secondary reference.
compatibility: "Requires the `stripe` CLI installed (via mise: `stripe-cli`), the `projects` plugin installed (`stripe plugin install projects`), and the Stripe CLI authenticated. Verify with `stripe whoami` and `stripe projects status`; run `stripe login` if not logged in, `stripe plugin install projects` if the subcommand is missing."
---

# Stripe Projects (`stripe projects`) Skill

Stripe **Projects** is a CLI plugin that lets you build and manage an app's entire third-party stack — databases, auth, hosting, analytics, AI, storage, observability, queues, caching, etc. — from one command group. A *Stripe project* represents a single app/codebase and tracks the providers, services, resources, credentials, and environments behind it. Billing for provisioned services is centralized through Stripe.

> **Primary focus of this skill:** the `stripe projects` plugin. The classic Stripe CLI (`listen`, `trigger`, resource CRUD, `logs`) is covered in a short reference section at the end.

## Concept model

- **Project** — one app/codebase. Holds providers, services, resources, credentials, and environments. Identified by a project ID (e.g. `proj_...`).
- **Provider** — a SaaS vendor (Supabase, Neon, Vercel, Cloudflare, Clerk, PostHog, Turso, Upstash, Railway, Render, …). 48 providers at time of writing — the catalog is the source of truth.
- **Service** — a product from a provider (e.g. `supabase/project`, `databaseco/postgres`).
- **Resource** — a concrete provisioned instance + its credentials/env vars.
- **Catalog** — Stripe's live registry of all providers and their services, browsable with `stripe projects catalog` / `search`.

State stored in the local repo:
- `.projects/state.json` — shared project state (safe to commit).
- `.projects/vault/vault.json` — encrypted credential cache (**do not commit**).
- `.env` — plaintext env vars for local dev (**do not commit**; `init` adds it to `.gitignore`).
- `AGENTS.md` / `.agents/`, `.claude/`, `.cursor/`, `CLAUDE.md` — AI agent context files (provider docs, env var names). Skip with `--skip-skills`.

## Setup

The base CLI is installed machine-wide via mise as `stripe-cli`. Install the Projects plugin once, then authenticate.

```bash
stripe --version                   # base CLI version
stripe whoami                      # current Stripe auth state (account, mode)
stripe login                       # browser login (or: stripe login --api-key sk_test_...)
stripe plugin install projects     # adds the `stripe projects` command group
stripe projects --version          # plugin version (e.g. v0.13.0)
stripe projects status             # show current project, providers, and services
```

Switch between Stripe accounts with `stripe projects switch-account`. There is **no separate "projects login"** — Projects reuses the base CLI's authenticated Stripe context.

## Global `projects` flags (apply to most subcommands)

| Flag | Purpose |
|---|---|
| `--json` | Structured JSON output, suppresses interactive prompts — **use this for scripting and agents**. |
| `-y, --yes` | Skip confirmation prompts (required for non-interactive/destructive commands). |
| `--no-interactive` | Disable interactive prompts entirely (scripting/CI). |
| `--interactive` | Allow interactive prompts (default in a TTY). |
| `--accept-tos` | Accept provider terms of service without prompting. |
| `--confirm-paid-service` | Confirm willingness to provision a paid service (required in non-interactive mode). |
| `--stream` | Enable streaming output animations. |
| `--debug` | Debug logging for Stripe API requests. |

**Agent/CI pattern:** `--json --yes --no-interactive [--accept-tos] [--confirm-paid-service]` for fully non-interactive runs.

## Get started: init, list, pull, status

### `stripe projects init [name]` — initialize a new project

Creates the local project workspace (`.projects/*`, `.env`, `AGENTS.md`) and adds credential paths to `.gitignore`.

```bash
stripe projects init                    # name defaults to the current directory name
stripe projects init my-app             # explicit name
stripe projects init --from <url>       # import a shared stack (URL from `stripe projects share`)
stripe projects init --skip-skills       # don't create AI agent skill files
stripe projects init --json             # non-interactive; structured output
```

### `stripe projects list` — list projects on your account

```bash
stripe projects list                    # each project's name, ID, creation date
stripe projects list --json             # scriptable
```

Use the returned project ID with `pull`.

### `stripe projects pull [projectId]` — set up an existing project locally

Connects to an *existing* project's provisioned services in a new directory — does **not** provision new resources.

```bash
mkdir new-dir && cd new-dir
stripe projects pull proj_123           # writes .projects/* and .env with that project's creds
```

### `stripe projects status` — view current project state

```bash
stripe projects status                  # linked providers, provisioned resources, plan tiers, service health
stripe projects status --json
```

`stripe projects services list` shows just the services in the current project.

## Discovering providers and services (the catalog)

The catalog is the **authoritative, live list** of available providers and services — do not hardcode provider names from memory; always browse/search first. Run from any directory (no project needed).

```bash
stripe projects catalog                       # browse all providers/services (interactive)
stripe projects catalog supabase               # filter to one provider
stripe projects catalog @database              # filter by category (e.g. @database, @auth, @ai)
stripe projects catalog --json                # full structured dump (parse with jq)
stripe projects search "postgres"             # search by name/description/category
stripe projects search "vector" --json
```

### Available providers (snapshot, 2026-07 — verify with `catalog`)

48 providers at time of writing. By category strength (services per provider): `ai`, `database`, `compute`, `auth`, `analytics`, `search`, `storage`, `observability`, `feature_flags`, `cache`, `queue`, `email`, `messaging`, `browser`, `sandbox`, `payments`, `domains`, `cdn`, `ecommerce`, `ci`.

Notable providers (non-exhaustive — **run `stripe projects catalog --json` for the current full list**):

- **Databases:** Supabase, Neon, PlanetScale, Turso, Prisma, ClickHouse, Chroma
- **Compute / hosting:** Vercel, Netlify, Cloudflare, Railway, Render, Flyio, Daytona, Laravel_Cloud, Wix, Squarespace, WordPress.com
- **Auth:** Clerk, Auth0, WorkOS, Privy
- **Analytics:** PostHog, Amplitude, Mixpanel, Metronome
- **AI / agents:** OpenRouter, HuggingFace, ElevenLabs, Blaxel, Firecrawl, Exa, E2B, Inngest, Runloop, KERNEL, Supermemory, Base44_Projects, HeyGen
- **Search:** Algolia
- **Storage / cache / queue:** Upstash
- **Observability:** Sentry
- **Browser / sandbox:** Browserbase, E2B, Daytona
- **Messaging / email / comms:** AgentMail, Sinch, PostalForm
- **Git:** GitLab

Each catalog entry exposes: `id` (`prvsvc_...`), `provider_name`, `service_id` (e.g. `conversation-messaging`), `categories`, `availability`, `pricing` (free / paid / freeform), a `configuration_schema` (required params like `region`), `kind` (`deployable` etc.), and `llm_context` (a URL with provider docs for AI agents).

## Provisioning services: `add`, `link`, `update`, `upgrade`, `downgrade`, `remove`, `rotate`

### `stripe projects add [service]` — add/provision a service

Provisions a new resource (or links an existing one) and stores its credentials in the vault + `.env`.

```bash
stripe projects add supabase/project       # provider/service form
stripe projects add databaseco/postgres
stripe projects add @database              # add by category (resolves to a provider)
stripe projects add supabase/project --name my-db   # logical name -> env var prefixes
stripe projects add supabase/project --config '{"region":"eu"}'    # service config as JSON
stripe projects add --existing             # link an existing resource instead of provisioning
stripe projects add supabase/project --json --yes --accept-tos     # non-interactive
```

Key flags:
- `--name` — logical resource name; used for local references and env-var prefixes.
- `--config '<json>'` — service configuration matching the catalog's `configuration_schema` (e.g. `{"region":"us"}`).
- `--provider-config '<json>'` — provider configuration for account linking.
- `--provider-info '<json>'` / `--resource-info '<json>'` — extra details the provider requests during linking/provisioning.
- `--resource-id` — existing provisioning resource ID, to resume a non-interactive workflow with `--resource-info`.
- `--existing` — link an existing resource instead of provisioning a new one.

The `service` positional accepts: `provider/service` (e.g. `supabase/project`), a bare provider (e.g. `supabase`), or a `@category` (e.g. `@database`).

### Link / unlink an existing provider account

```bash
stripe projects link <provider>            # link an existing provider account
stripe projects unlink <provider>          # unlink it
stripe projects open <provider>            # deep link to the provider dashboard (if supported)
```

### Update, upgrade, downgrade plan tiers

```bash
stripe projects update <service_reference> [service]     # move resource to another service in same provider
stripe projects upgrade <service_reference> [service]     # upgrade to paid tier / add-ons
stripe projects downgrade <service_reference> [service]  # downgrade to a lower tier / free plan
stripe projects remove <resource>                         # remove a service resource
stripe projects rotate <resource>                         # rotate credentials for a resource
```

`<service_reference>` / `<resource>` is the logical name (from `--name`) or resource ID shown by `stripe projects status`.

## Environment variables & credentials: `env`

Credentials live in the encrypted vault; `env` syncs them to local files. **Don't hand-edit `.env`** — use Projects commands.

```bash
stripe projects env                       # list env vars (values redacted)
stripe projects env --service databaseco/postgres   # one service only
stripe projects env --provider supabase              # one provider only
stripe projects env --refresh            # refresh local cache from Stripe first
stripe projects env --pull               # write latest env vars to .env
stripe projects env --json               # structured output (names + values, redacted)
```

Typical flow after adding a service: run `stripe projects env --pull` to populate `.env`, then load it in your app.

## AI agent context: `llm-context`

```bash
stripe projects llm-context              # list provider guidance URLs for AI-assisted development
```

Each catalog service also exposes an `llm_context` URL with provider quickstart/docs. `init` (without `--skip-skills`) writes `AGENTS.md` plus `.agents/`, `.claude/`, `.cursor/`, `CLAUDE.md` context files summarizing the stack and env var meanings.

## Billing

```bash
stripe projects billing show             # current payment details
stripe projects billing add              # add/update a billing method
```

Provisioned paid services are billed through Stripe; `--confirm-paid-service` is required in non-interactive mode before a paid resource is created.

## Cross-cutting tips

- **Catalog is source of truth:** provider names and service IDs change over time — always `stripe projects catalog --json` / `search` before assuming an identifier. Don't hardcode from this skill's snapshot.
- **Agent/CI pattern:** append `--json --yes --no-interactive [--accept-tos] [--confirm-paid-service]` to any provisioning/destructive command for fully scripted runs. Preflight with `--json` and inspect `ok`/`data`.
- **Typical project bootstrap:** `init` → `catalog`/`search` → `add <provider>/<service>` → `env --pull` → build against `.env`.
- **Clone a team stack:** `stripe projects init --from <share-url>` (or `pull <projectID>` into a fresh dir) reproduces an existing project's services without reprovisioning.
- **Secrets safety:** the vault and `.env` hold live credentials. Never print raw values into transcripts; reference env var names. `init` gitignores them — keep it that way.
- **Discover help:** `stripe projects --help` (command groups), `stripe projects <cmd> --help` (flags + examples). Every subcommand shows realistic examples at the bottom of its help.

## Classic Stripe CLI (secondary reference)

When the user needs *payments* workflows (not third-party service provisioning), use the base `stripe` CLI. Installed as `stripe-cli`; authenticate with `stripe login` / verify with `stripe whoami`.

### Webhooks — `listen` (forward to localhost) and `trigger` (fire test events)

```bash
stripe listen --forward-to localhost:4242/webhook          # forward events to a local handler (prints whsec_...)
stripe listen --events charge.captured,charge.updated --forward-to localhost:3000/events
stripe trigger payment_intent.succeeded                   # fire a test event for listen to forward
stripe trigger checkout.session.completed
```

### Resource CRUD (maps 1:1 to the Stripe API)

```bash
stripe customers create --email="user@example.com" --name="Example User"
stripe customers list --limit=10
stripe products create --name="My Product" --description="Test product"
stripe prices create --unit-amount=3000 --currency=usd --product=prod_abc123
stripe payment_intents create --amount=2000 --currency=usd
stripe resources help                                      # list every resource command
```

### Logs, raw API, fixtures

```bash
stripe logs tail                       # stream real-time API request logs
stripe get /v1/customers/cus_abc123    # raw authenticated GET
stripe post /v1/customers -d email=user@example.com
stripe fixtures seed.yml               # run a YAML of sequenced API ops to seed test data
```

Global flags that also apply here: `--api-key`, `--stripe-account <acct_...>`, `--stripe-version`, `-p, --project-name`, `--config`.

## Reference

- Stripe Projects docs: https://docs.stripe.com/projects
- Available providers (live): `stripe projects catalog --json` (see also https://docs.stripe.com/projects.md#available-providers)
- Browse catalog: https://docs.stripe.com/cli/projects/catalog
- Projects site: https://projects.dev
- Classic CLI reference: https://docs.stripe.com/cli
- Webhooks + listen: https://docs.stripe.com/stripe-cli/webhooks
- Event types: https://stripe.com/docs/api/events/types
- Source: https://github.com/stripe/stripe-cli
