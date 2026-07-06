---
name: fly-io
description: Use this skill when the user wants to interact with Fly.io via the `flyctl` CLI — deploying apps, launching new apps from source, inspecting app/machine status and logs, scaling resources, and managing Machines, volumes, secrets, IPs, certificates, and Managed Postgres (MPG). Also covers Fly.io provisioned through Stripe Projects (macaroon-token auth, lifecycle handoff). Triggers on tasks like "deploy to fly", "launch a fly app", "check fly app status", "view fly logs", "scale my fly app", "set a fly secret", "manage my fly machines", or "set up a managed postgres cluster".
compatibility: "Requires the `flyctl` CLI installed (via mise: `flyctl`) and on PATH, and authenticated. Verify with `flyctl auth whoami`; run `flyctl auth login` if not logged in, or set `FLY_API_TOKEN` (or a Stripe Projects macaroon token) for headless/CI use."
---

# Fly.io CLI (`flyctl`) Skill

Use this skill to interact with Fly.io from the terminal using the `flyctl` CLI. Covers the core deploy loop (launch → deploy → status → logs), scaling, Machines, volumes, secrets, IPs, certificates, Managed Postgres (MPG), regions, and `fly.toml`. Includes the **Stripe Projects** integration (macaroon-token auth + lifecycle handoff) since Fly.io (`flyio` provider) is commonly provisioned through Stripe Projects.

> **Use `flyctl`, not `fly`.** `flyctl` is the mise-installed binary; `fly` is only available as an alias in some setups. Always use `flyctl` for portability.

## Setup

```bash
flyctl version          # current flyctl version
flyctl auth whoami    # show logged-in account
flyctl auth login     # interactive browser login flow
flyctl auth logout    # sign out
flyctl auth token     # print a reusable API token (for CI)
```

Auth tokens can be passed to any command via `-t, --access-token <token>` or the `FLY_API_TOKEN` env var — the standard pattern for CI/headless deploys. **Treat tokens as secrets; never commit them.**

### Authentication via Stripe Projects (macaroon tokens)

When a Fly.io app or MPG cluster is provisioned through **Stripe Projects**, you do **not** run `flyctl auth login`. Fly.io issues **macaroon tokens** (`fm2_XXXX` strings) scoped to the provisioned resource; multiple tokens can be combined comma-separated. See the `stripe-projects` skill for provisioning details.

Set `FLY_API_TOKEN` and verify (the `whoami` result `HASH@tokens.fly.io` is expected and correct for macaroon auth):

```sh
export FLY_API_TOKEN="FlyV1 fm2_XXXX,fm2_YYYY"
flyctl auth whoami    # returns HASH@tokens.fly.io
```

Token types by Stripe Projects resource:

| Resource | Token in `access_configuration` | Scope | Use for |
|---|---|---|---|
| `app` | `deploy_token` | App-scoped | `flyctl` commands targeting that app (`-a <name>`) — **requires the `FlyV1 ` prefix** |
| `mpg` | `org_token` | Org-scoped | `flyctl mpg` commands and any app command for apps in the same org — **no `FlyV1` prefix** |

```sh
# App token (FlyV1 prefix required)
export FLY_API_TOKEN="FlyV1 <deploy_token>"
flyctl status -a my-app
flyctl secrets set KEY=value -a my-app

# MPG org token (no prefix; org-scoped, covers all apps in the org)
export FLY_API_TOKEN="<org_token>"
flyctl mpg status <cluster_id>
flyctl mpg attach <cluster_id> --app my-app
```

Rotate credentials (issues fresh tokens, revokes the old ones):

```sh
stripe projects rotate <resource-name>     # then update FLY_API_TOKEN with the new token
```

## Global conventions

`flyctl [command] [flags]`. Global flags (apply to most commands):

| Flag | Purpose |
|---|---|
| `-a, --app <name>` | Target a specific app instead of the cwd's `fly.toml`. **Always pass this explicitly** in agentic/CI runs — don't rely on a config file being present. |
| `-o, --org <org>` | Target a specific organization. |
| `-c, --config <path>` | Point to a non-default `fly.toml`. |
| `-t, --access-token <token>` | Use a specific API token (or `FLY_API_TOKEN`). |
| `--json` / `--yaml` | Machine-readable output (best for parsing). |
| `--debug` / `--verbose` | Additional logs/traces. |
| `-h, --help` | Help for a command. |

**Discovery:** `flyctl --help` lists all command groups; `flyctl <command> --help` shows subcommands and flags; `flyctl help` is a full reference. Output is grouped by area (Deploying, Configuration & scaling, Monitoring, etc.).

## Setting up an app — operational checklist

Follow this decision tree before working with a Fly.io app, especially in agentic/CI environments.

1. **Look for a `fly.toml`** (or variant like `fly.production.toml`). If found, read the `app` field and run `flyctl status -c fly.toml` (or `-a <name>`):
   - **Success + `Image` is `-`** → app exists (e.g. pre-created via Stripe Projects) but was *never deployed*. First deploy with:
     ```sh
     flyctl launch --name <app-name> --force-name --no-create   # scaffold Dockerfile + deploy, reuse existing app
     ```
   - **Success + `Image` has a value** → live app; use `flyctl deploy -c fly.toml` for subsequent deploys.
   - **401 / not found** → wrong token or app doesn't exist. Disambiguate with `stripe projects status`: a matching resource but 401 = wrong token; no matching resource = app not created yet.
2. **No config file** → run `flyctl launch` to generate `fly.toml`, `Dockerfile`, and perform the first deploy. **Do not hand-write these files** — let the wizard scaffold them; only intervene if the build/deploy fails.
3. **Config file exists but app is missing on Fly.io** → register the app without deploying:
   ```sh
   flyctl launch --copy-config -c fly.toml --no-deploy
   ```
   Review any generated `Dockerfile` before deploying.
4. **Provisioning app + MPG together — follow this order:**
   1. Create the app first (via `stripe projects add` or `flyctl launch --no-deploy`).
   2. Create the MPG cluster (`flyctl mpg create` or via Stripe Projects).
   3. Attach: `flyctl mpg attach <cluster-id> --app <app-name>` (injects `DATABASE_URL` automatically).
   4. Set remaining secrets: `flyctl secrets set KEY=value --app <app-name>`.
   5. Deploy: `flyctl deploy -c fly.toml`.

   **Never `flyctl secrets set` on an app that doesn't exist yet** — it 404s.

## The deploy loop: `launch` → `deploy` → `status` → `logs`

### `flyctl launch` — create & configure a new app

Scaffolds a new app from source (or a Docker image), generates `fly.toml` + `Dockerfile`, and optionally deploys. Interactive by default.

```sh
flyctl launch                      # from a project dir — generates fly.toml, prompts for region/org/name
flyctl launch --no-deploy          # generate config without deploying
flyctl launch --image myimg:latest # from an existing Docker image instead of building source
flyctl launch --dockerfile Dockerfile.prod          # custom Dockerfile
flyctl launch --copy-config        # reuse an existing fly.toml (assigns new app name/ownership) — for cloning a repo
flyctl launch --name <app> --force-name --no-create  # first deploy when app already exists (Image == -)
```

### `flyctl deploy` — deploy an app

```sh
flyctl deploy -c fly.toml          # deploy the cwd app (recommended when a config exists)
flyctl deploy -a my-app            # deploy a specific app without a config file
flyctl deploy --image myimg:latest  # deploy a pre-built image (skip build)
flyctl deploy --remote-only         # build remotely on Fly.io builders
flyctl deploy --build-arg ENV=prod  # pass build args to the Docker build
flyctl deploy --build-secret KEY=val # pass build secrets (not retained in image)
flyctl deploy --strategy rolling    # rollout strategy (rolling, bluegreen, canary)
flyctl deploy --ha=false            # skip creating redundant Machines
```

### `flyctl status` — inspect app state

```sh
flyctl status -a my-app             # deployment, Machines, allocation
flyctl status --all                 # include stopped/deleted Machines
flyctl status --json                # machine-readable
flyctl releases -a my-app           # list recent releases
```

### `flyctl logs` — view logs

```sh
flyctl logs -a my-app               # tail logs
flyctl logs --instance <machine-id> # logs for a specific Machine
flyctl logs -a my-app --json | jq   # parse structured output
```

## Scaling: `flyctl scale`

```sh
flyctl scale show                   # current resource/VM config
flyctl scale vm shared-cpu-1x --memory 512   # set VM type and memory
flyctl scale count 3                # run 3 Machines
flyctl scale count 2 --region sjc,kyy --max-per-region 1   # multi-region, balanced
flyctl scale memory 1024            # adjust memory only
```

## Machines: `flyctl machine` (`flyctl m`)

Fly Machines are the underlying VMs. App-level `deploy` is the common path; `machine` gives granular control.

```sh
flyctl machine list                              # all Machines for the app
flyctl machine status <machine-id>
flyctl machine start / stop / restart <machine-id>
flyctl machine clone <machine-id>
flyctl machine destroy <machine-id>             # --force to skip confirm
flyctl machine ssh <machine-id>
flyctl machine exec -a <app> -- <cmd>           # run a command in a Machine
flyctl machine update <machine-id>
flyctl machine run <image>                      # standalone Machine from an image (no app)
```

## Volumes: `flyctl volumes`

Persistent storage attached to Machines (one volume per Machine per region).

```sh
flyctl volumes list
flyctl volumes create data --size 1             # 1GB volume named "data"
flyctl volumes create data --region sjc
flyctl volumes show <volume-id>
flyctl volumes delete <volume-id>
flyctl volumes snapshots <volume-id>
```

## Secrets: `flyctl secrets`

Encrypted env vars stored on the platform (never in `fly.toml`). Setting/unsetting triggers a new release (Machines restart) unless `--stage` is used.

```sh
flyctl secrets list                              # list secret keys (values hidden)
flyctl secrets set DATABASE_URL=postgres://... API_KEY=xxx --app my-app
flyctl secrets set -a my-app --stage            # stage without deploying (apply on next deploy)
flyctl secrets unset API_KEY --app my-app
flyctl secrets import < .env                     # bulk import KEY=VALUE lines
```

## Networking: IPs, certs, services

```sh
flyctl ips list --app my-app
flyctl ips allocate-v4 --app my-app
flyctl ips allocate-v6 --app my-app
flyctl ips release <ip>

flyctl certs list --app my-app
flyctl certs add myapp.example.com --app my-app
flyctl certs show myapp.example.com --app my-app   # status + DNS instructions
flyctl certs check myapp.example.com --app my-app
flyctl certs remove myapp.example.com

flyctl services list -a my-app
flyctl proxy <machine-port>:<local-port> -a my-app   # tunnel a Machine port to localhost
flyctl console -a my-app                              # open a console in a new/existing Machine
flyctl ssh console -a my-app                          # SSH console into a Machine
flyctl ssh console -s -a my-app                       # select a specific Machine
```

## Managed Postgres (MPG) — `flyctl mpg`

> **Gotcha:** `flyctl postgres` manages **unmanaged** (self-hosted) Postgres apps on Fly Machines — not the managed service, and is not supported by Fly.io Support. **Always use `flyctl mpg`** for Fly's fully-managed Postgres. (Running `flyctl postgres --help` itself prints this warning.)

Managed Postgres clusters are fully managed (Fly handles provisioning, failover, backups, upgrades). The `<cluster_id>` (a hashid) is **required for every `flyctl mpg` command**.

```sh
flyctl mpg list -o <org>
flyctl mpg create --region <code>           # create a cluster
flyctl mpg status <cluster_id>
flyctl mpg attach <cluster_id> --app my-app  # injects DATABASE_URL secret on the app
flyctl mpg detach <cluster_id> --app my-app
flyctl mpg connect <cluster_id>              # interactive psql shell
flyctl mpg proxy <cluster_id>                # local tunnel to the cluster
flyctl mpg destroy <cluster_id>
flyctl mpg databases list / create <cluster_id>
flyctl mpg users list / create <cluster_id> --username <u> --role <role>
flyctl mpg backup list / create <cluster_id> ; mpg restore <cluster_id>
```

### MPG via Stripe Projects

When an MPG cluster is provisioned through Stripe Projects, prefer the Stripe Projects CLI for **lifecycle** operations (so billing/state stay in sync) and `flyctl mpg` for day-to-day operations:

| Operation | Tool |
|---|---|
| Create cluster | `stripe projects add` (Fly.io MPG service) |
| Change plan | `stripe projects upgrade` / `downgrade` |
| Rotate credentials | `stripe projects rotate <resource-name>` |
| Destroy cluster | `stripe projects remove <resource-name> --yes` (NOT `flyctl mpg destroy`) |
| Connect, databases, users, status, backups, proxy | `flyctl mpg <cluster_id> ...` |

The Stripe Projects `access_configuration` returns `connection_url` (via PgBouncer), `cluster_id`, and an **org-scoped `org_token`** (no `FlyV1` prefix). Store both `cluster_id` and `org_token`; rotate via `stripe projects rotate` revokes the old token and issues a new one — update `FLY_API_TOKEN` afterward.

### App + MPG ordering (recurring gotcha)

Create the **app first**, then the cluster, then `mpg attach`, then remaining `secrets set`, then `deploy`. `flyctl secrets set` on a non-existent app 404s.

## Regions

Fly.io regions are **IATA airport codes** (`iad` = Dulles/N. Virginia, `lhr` = London/Heathrow, `nrt` = Tokyo). List all of them:

```sh
flyctl platform regions             # full names + codes
flyctl platform regions --json      # includes latitude/longitude for proximity calc
```

Pass `--region <code>` when creating resources. When the user asks for a specific country/city, use `--json` and pick by coordinates.

### MPG region subset

MPG clusters are only available in a subset of regions — **always pick from this list** when provisioning MPG:

| Code | Location |
|---|---|
| `ams` | Amsterdam, NL · `fra` Frankfurt, DE · `gru` São Paulo, BR |
| `iad` | Ashburn, VA (US) · `lax` Los Angeles, US · `ord` Chicago, US |
| `lhr` | London, UK · `nrt` Tokyo, JP · `sin` Singapore |
| `sjc` | San Jose, US · `syd` Sydney, AU · `yyz` Toronto, CA |

When provisioning MPG alongside an app, prefer the **same region as the app's `primary_region`** if it's in the list above (minimises DB latency); otherwise pick the geographically closest.

## `fly.toml` — app configuration

Defines app name, build, services, VM, volumes, env, deploy strategies. `flyctl launch` generates it; edit and redeploy, or inspect/validate:

```toml
app = "my-app-name"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

```sh
flyctl config validate -c fly.toml         # check for errors
flyctl config show -a my-app               # current live (resolved) config
flyctl config save -a my-app               # download live config to fly.toml
```

### `primary_region` — let Fly choose on first deploy

**Do not set `primary_region` before the first `flyctl launch`/deploy.** When absent, Fly.io auto-selects the region closest to the user triggering the deploy (best latency out of the box). Only add `primary_region` explicitly *after* the first deploy if you have a specific reason (data residency, co-location with another resource).

## Sprites (managed browser sandbox)

Fly.io also offers **Sprites** — managed browser sandboxes (the `flyio/sprite` service in Stripe Projects). Managed via the separate `sprite` CLI.

```sh
# macOS / Linux
curl https://sprites.dev/install.sh | bash
```

Export `SPRITE_TOKEN` with the token from the `flyio/sprite` Stripe Projects resource (auto-logs-in, no `sprite login` needed):

```sh
export SPRITE_TOKEN="<token-from-flyio-sprite-resource>"
sprite org list                                # confirm logged in
sprite create SPRITE_NAME                       # first run drops into the console
sprite exec -s SPRITE_NAME ls -la              # run a command in a sprite
sprite console -s SPRITE_NAME                   # connect to a sprite's console
```

**Always pass `-s SPRITE_NAME`** with the sprite name the user asked for. Docs: https://docs.sprites.dev/ · API: https://sprites.dev/api

## Stripe Projects lifecycle handoff (summary)

For Fly.io resources provisioned through Stripe Projects, keep Stripe state consistent:

- **Delete an app provisioned via Projects** → use `stripe projects remove <resource-name> --yes`, **not** `flyctl apps destroy` (which would leave Stripe state stale). Use `stripe projects status` to find the resource name.
- **Rotate Fly tokens** → `stripe projects rotate <resource-name>`, then update `FLY_API_TOKEN`.
- See the `stripe-projects` skill for the full `stripe projects` command set (catalog, add, env --pull, etc.).

## Cross-cutting tips

- **Always pass `-a <app>` explicitly** in agentic/CI runs rather than relying on cwd `fly.toml` — unambiguous and works without `cd`.
- **CI deploys:** set `FLY_API_TOKEN` (from `flyctl auth token` or a Stripe Projects macaroon) and run `flyctl deploy -a <app> --image <img>` (or build remotely). No `auth login` needed.
- **Debugging a deploy:** `flyctl status` → pick a Machine → `flyctl machine status <id>` → `flyctl logs --instance <id>`. Use `--debug`/`--verbose` on the failing command for traces.
- **First-deploy signal:** `flyctl status` with `Image == -` means the app exists but was never deployed — use `flyctl launch --name <app> --force-name --no-create`.
- **MPG vs postgres:** always `flyctl mpg` for managed Postgres; `flyctl postgres` is unmanaged and unsupported.
- **Parsing:** prefer `--json` + `jq` for any scripted output.

## Reference

- Built-in help: `flyctl --help`, `flyctl <command> --help`, `flyctl help`.
- flyctl docs: https://fly.io/docs/flyctl/
- fly.toml reference: https://fly.io/docs/reference/configuration/
- Machines guide: https://fly.io/docs/machines/guides-examples/machines-app-using-flyctl/
- MPG overview: https://fly.io/docs/mpg/overview/
- Machines API: https://api.machines.dev/
- Community: https://community.fly.io/
- GitHub: https://github.com/superfly/flyctl
- Provider LLM context (source of Projects guidance): https://fly.io/provisioning/llm_context.md
