---
name: fly-io
description: Use this skill when the user wants to interact with Fly.io via the `flyctl` (`fly`) CLI — deploying apps, launching new apps from source, inspecting app/machine status and logs, scaling resources, managing Machines, volumes, secrets, IPs, and certificates. Triggers on tasks like "deploy to fly", "launch a fly app", "check fly app status", "view fly logs", "scale my fly app", "set a fly secret", or "manage my fly machines".
compatibility: Requires the `flyctl` CLI installed (via mise: `flyctl`) and on PATH, and authenticated. Verify with `flyctl auth whoami`; run `flyctl auth login` if not logged in.
---

# Fly.io CLI (`flyctl` / `fly`) Skill

Use this skill to interact with Fly.io from the terminal using the `flyctl` CLI (also invoked as `fly`). Covers the core deploy loop (launch → deploy → status → logs), scaling, and managing Machines, volumes, secrets, IPs, and certificates.

## Setup

The CLI is installed machine-wide via mise as `flyctl`. `fly` is a common alias for `flyctl`; both work interchangeably in commands below.

```bash
flyctl version          # current flyctl version
flyctl auth whoami     # show logged-in account
flyctl auth login      # interactive browser login flow
flyctl auth logout     # sign out
flyctl auth token      # print a reusable API token (for CI)
```

Auth tokens can be passed to any command via `-t, --access-token <token>` or the `FLY_API_TOKEN` env var — the standard pattern for CI/headless deploys. **Treat tokens as secrets; never commit them.**

Organizations are the top-level scope for apps. List/switch with:

```bash
flyctl orgs list                    # organizations you belong to
flyctl orgs show <org>             # details about an org
```

Many commands accept `-o, --org <org>` to target an org explicitly.

## Global conventions

`flyctl [command] [flags]`. Global flags (apply to most commands):

| Flag | Purpose |
|---|---|
| `-a, --app <name>` | Target a specific app instead of the cwd's `fly.toml`. Use this instead of `cd`-ing into a project. |
| `-o, --org <org>` | Target a specific organization. |
| `-c, --config <path>` | Point to a non-default `fly.toml`. |
| `-t, --access-token <token>` | Use a specific API token (or `FLY_API_TOKEN`). |
| `--json` / `--yaml` | Machine-readable output (best for parsing). |
| `--debug` / `--verbose` | Additional logs/traces. |
| `-h, --help` | Help for a command. |

**App context:** most app-level commands resolve the target app from `fly.toml` in the cwd. When operating on a different app (or no `fly.toml` present), always pass `-a <app>`. Prefer `--json` + `jq` when scripting.

**Discovery:** `flyctl --help` lists all command groups; `flyctl <command> --help` shows subcommands and flags; `flyctl help` is a full reference.

## The deploy loop: `launch` → `deploy` → `status` → `logs`

### `flyctl launch` — create & configure a new app

Scaffolds a new app from source (or a Docker image), generates `fly.toml`, and optionally deploys. Interactive by default.

```bash
flyctl launch                      # from a project dir — generates fly.toml, prompts for region/org/name
flyctl launch --no-deploy          # generate config without deploying
flyctl launch --image myimg:latest # from an existing Docker image instead of building source
flyctl launch --dockerfile Dockerfile.prod   # custom Dockerfile
```

### `flyctl deploy` — deploy an app

Builds (if needed) and rolls out a new release of an app.

```bash
flyctl deploy                       # deploy the cwd app (uses fly.toml)
flyctl deploy -a my-app             # deploy a specific app
flyctl deploy -c fly.prod.toml      # use a specific config
flyctl deploy --image myimg:latest  # deploy a pre-built image (skip build)
flyctl deploy --build-arg ENV=prod  # pass build args to the Docker build
flyctl deploy --build-secret KEY=val # pass build secrets (not retained in image)
flyctl deploy --strategy rolling    # rollout strategy (e.g. rolling, bluegreen, canary)
flyctl deploy --ha=false            # skip creating redundant Machines
```

### `flyctl status` — inspect app state

```bash
flyctl status                       # app overview: deployment, Machines, allocation
flyctl status -a my-app
flyctl status --all                 # include stopped/deleted Machines
flyctl status --json                # machine-readable
flyctl releases                     # list recent releases
flyctl releases -a my-app
```

### `flyctl logs` — view logs

```bash
flyctl logs                         # tail logs for the cwd app
flyctl logs -a my-app
flyctl logs --instance <machine-id> # logs for a specific Machine
flyctl logs -a my-app | jq .        # parse structured JSON output
```

## Scaling: `flyctl scale`

Right-size an app's Machines (VM size, count, autoscaling regions).

```bash
flyctl scale show                   # current resource/VM config
flyctl scale vm shared-cpu-1x --memory 512   # set VM type and memory
flyctl scale count 3                # run 3 Machines (spread across regions)
flyctl scale count 2 --region sjc,kyy --max-per-region 1   # multi-region, balanced
flyctl scale memory 1024            # adjust memory only
flyctl machine list                 # see the actual Machines (see below)
```

## Machines: `flyctl machine` (`flyctl m`)

Fly Machines are the underlying VMs. App-level `deploy` is the common path; `machine` commands give granular control.

```bash
flyctl machine list                       # all Machines for the app
flyctl machine status <machine-id>        # details for one Machine
flyctl machine start <machine-id>
flyctl machine stop <machine-id>
flyctl machine restart <machine-id>
flyctl machine clone <machine-id>         # clone a Machine
flyctl machine destroy <machine-id>       # remove a Machine (--force to skip confirm)
flyctl machine ssh <machine-id>           # SSH into a Machine (see ssh below)
flyctl machine exec -a <app> -- <cmd>     # run a command in a Machine
flyctl machine update <machine-id>        # update a Machine's config
flyctl m list --json | jq                 # scriptable
```

`flyctl machine run <image>` creates a standalone Machine from an image without an app.

## Volumes: `flyctl volumes`

Persistent storage attached to Machines (one volume per Machine per region).

```bash
flyctl volumes list                      # volumes for the app
flyctl volumes create data --size 1      # create a 1GB volume named "data"
flyctl volumes create data --region sjc  # in a specific region
flyctl volumes show <volume-id>
flyctl volumes delete <volume-id>
flyctl volumes snapshots <volume-id>     # list snapshots
```

Reference volumes by `process` group / name in `fly.toml` via the `[mounts]` block.

## Secrets: `flyctl secrets`

Encrypted env vars stored on the platform (never in `fly.toml`).

```bash
flyctl secrets list                     # list secret keys (values are not shown)
flyctl secrets set DATABASE_URL=postgres://... API_KEY=xxx   # set one or more
flyctl secrets set -a my-app --stage    # stage without deploying (apply on next deploy)
flyctl secrets unset API_KEY            # remove a secret
flyctl secrets import < .env            # bulk import from a file (KEY=VALUE lines)
```

Setting/unsetting secrets triggers a new release (Machines restart), unless `--stage` is used.

## Networking: IPs, certs, services

### `flyctl ips` — IP addresses

```bash
flyctl ips list                         # all IPs (v4/v6, shared/dedicated)
flyctl ips allocate-v4                  # allocate a dedicated IPv4
flyctl ips allocate-v6                  # allocate a dedicated IPv6
flyctl ips release <ip>                 # release an IP
```

### `flyctl certs` — TLS certificates

```bash
flyctl certs list                       # certificates for the app
flyctl certs add myapp.example.com      # add a cert for a custom domain
flyctl certs show myapp.example.com     # status + DNS instructions
flyctl certs remove myapp.example.com
flyctl certs check myapp.example.com    # verify DNS/propagation
```

### Services / proxying

```bash
flyctl services list                    # services exposed by the app
flyctl proxy <machine-port>:<local-port> -a my-app   # tunnel a Machine port to localhost
flyctl console -a my-app                # open a console in a new/existing Machine
flyctl ssh console -a my-app            # SSH console into a Machine
flyctl ssh issue --agent                # manage SSH certs
```

## Configuration, images, and health

```bash
flyctl config show -a my-app            # current live config (resolved fly.toml)
flyctl config validate -c fly.toml      # validate a config file
flyctl config save -a my-app            # download live config to fly.toml
flyctl image show -a my-app             # current deployed image details
flyctl checks list -a my-app            # health checks status
flyctl dashboard -a my-app              # open the Fly web UI for the app (or -w)
```

`fly.toml` is the app's config: app name, regions, VM size, services/ports, volumes, env, and deploy strategies. `flyctl launch` generates it; edit it and redeploy, or use `flyctl config` commands to inspect/validate.

## Cross-cutting tips

- **Deploy from anywhere:** use `-a <app>` to deploy/manage an app without being in its directory (no `cd` needed). This is the no-clone pattern — equivalent to `gh -R owner/repo`.
- **CI deploys:** set `FLY_API_TOKEN` (from `flyctl auth token`) and run `flyctl deploy -a <app> --image <img>` (or build remotely). No `auth login` needed.
- **Debugging a deploy:** `flyctl status` → pick a Machine → `flyctl machine status <id>` → `flyctl logs --instance <id>`. Use `--debug`/`--verbose` on the failing command for traces.
- **Multi-region:** `flyctl scale count N --region a,b --max-per-region M` keeps balanced allocations; volumes are per-region.
- **Discover first:** `flyctl --help` (groups), `flyctl <group> --help` (subcommands), `flyctl <group> <subcommand> --help` (flags). Output is grouped by area (Deploying, Configuration & scaling, Monitoring, etc.).
- **Parsing:** prefer `--json` + `jq` for any scripted output.

## Reference

- Built-in help: `flyctl --help`, `flyctl <command> --help`, `flyctl help`.
- flyctl docs: https://fly.io/docs/flyctl/
- fly.toml reference: https://fly.io/docs/reference/configuration/
- Machines guide: https://fly.io/docs/machines/guides-examples/machines-app-using-flyctl/
- GitHub: https://github.com/superfly/flyctl
