---
name: exe-dev
description: Use this skill when the user wants to interact with exe.dev via SSH — creating and managing persistent Linux VMs, deploying small services/apps to them, exposing them over HTTPS, customizing with Docker images or setup scripts, sharing access, scaling resources, and automating lifecycle from scripts/CI. exe.dev gives every VM instant `https://<vm>.exe.xyz/` with automatic TLS. Triggers on tasks like "deploy to exe.dev", "create an exe VM", "put this app on exe.dev", "make my exe VM public", "ssh into my exe vm", "list my exe VMs", "resize an exe VM", "add a custom domain to exe.dev", "set up an exe.dev integration", or "use the exe.dev HTTPS API".
compatibility: "Requires an SSH key registered with exe.dev and the `ssh` client on PATH. Verify with `ssh exe.dev whoami`; if it prompts you to register, complete the onboarding at https://exe.dev first. For the HTTPS API/CI, generate a bearer token with `ssh exe.dev ssh-key generate-api-key --exp=30d`. No dedicated CLI binary — exe.dev is driven entirely over SSH (`ssh exe.dev <command>`)."
---

# exe.dev Skill

Use this skill to deploy and manage small services on [exe.dev](https://exe.dev) — persistent Linux VMs with instant HTTPS, all driven over SSH. Covers the deploy loop (create → customize → expose → share → scale → tear down), custom images and setup scripts, HTTP proxies, custom domains, integrations (LLM gateway, HTTP-proxy header injection, GitHub), and the HTTPS API for CI/automation.

> **exe.dev is SSH-native.** There is no `flyctl`-style CLI binary. Everything is `ssh exe.dev <command>`. Treat `ssh exe.dev` like a REPL/lobby for VM lifecycle, and `ssh <vm>.exe.xyz` like a normal SSH host for working inside a VM.

## What exe.dev is

exe.dev is a subscription service giving you Linux VMs with **persistent disks**, fast, with sensible secure defaults. Every VM gets `https://<vm>.exe.xyz/` with automatic TLS termination handled by exe.dev. VMs share underlying CPU/RAM (you pay for resources, not per VM), so it's cheap to spin up many small services. Think: a computer, of the Linux sort, already on the internet.

- Docs index: https://exe.dev/docs.md (structured for progressive discovery — start here, follow links as needed)
- All docs in one page: https://exe.dev/docs/all.md
- `llms.txt`: https://exe.dev/llms.txt

## A tale of two SSH destinations

This is the single most important distinction:

| Destination | What it is | Supports |
|---|---|---|
| `ssh exe.dev <command>` | The **exe.dev lobby** — a REPL for VM lifecycle, sharing, integrations, configuration | Lifecycle commands only. **No** shell, scp, sftp, or arbitrary commands. |
| `ssh <vm>.exe.xyz` | A **direct connection to a VM** — a normal Linux box | Full SSH: interactive shell, scp, sftp, port forwarding, rsync, everything. |

```sh
ssh exe.dev ls --json              # lobby: list VMs
ssh bloggy.exe.xyz                # direct: shell into the "bloggy" VM
scp app.tar.gz bloggy.exe.xyz:~/  # direct: copy files
rsync -avz ./src/ bloggy.exe.xyz:~/src/
```

## Setup & authentication

exe.dev authenticates you by your **SSH key** (no passwords, no separate login).

```sh
ssh exe.dev whoami                 # confirm you're registered (email, keys)
ssh exe.dev help                   # show all lobby commands
ssh exe.dev help <command>        # flags + examples for one command (JSON via --help)
```

If `ssh exe.dev whoami` prompts you to register, complete onboarding at https://exe.dev (the first SSH connection ties your key to an account).

### Host key & non-interactive gotchas

Coding agents and CI run SSH non-interactively. The main gotcha is **host-key prompts blocking forever with no output**. Accept the host key on first connect:

```sh
ssh -o StrictHostKeyChecking=accept-new exe.dev whoami
ssh -o StrictHostKeyChecking=accept-new bloggy.exe.xyz true
```

### SSH config (recommended)

Pin the key for both destinations so the right identity is always used:

```sshconfig
Host exe.dev *.exe.xyz
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519
```

### Regions

Each account is pinned to **one region** (all that account's VMs live there). The lobby (`exe.dev` main server) is in the US for everyone.

| Code | Location | Code | Location |
|---|---|---|---|
| `pdx` | Oregon, USA (closed to new accounts) | `fra` | Frankfurt, DE |
| `lax` | Los Angeles, USA (nearest to pdx) | `tyo` | Tokyo, JP |
| `nyc` | New York, USA | `syd` | Sydney, AU |
| `dal` | Dallas, USA | `sgp` | Singapore |
| | | `lon` | London, UK |

```sh
ssh exe.dev set-region lon         # set preferred region for new VMs
```

## The deploy loop: `new` → customize → `share` → access

This is the canonical workflow for putting a small service on the internet with exe.dev.

### 1. Create a VM — `ssh exe.dev new`

```sh
ssh exe.dev new                                  # just give me a computer
ssh exe.dev new --name=bloggy --json            # named VM, machine-readable output
ssh exe.dev new --image=ubuntu:22.04 --name=b   # custom OCI image
ssh exe.dev new --cpu=4 --memory=16GB --disk=50GB
ssh exe.dev new --env FOO=bar --env BAZ=qux      # env vars (KEY=VALUE, repeatable)
ssh exe.dev new --tag=prod,web                   # tag at creation
ssh exe.dev new --integration=myproxy            # attach an integration at creation
```

Key flags:

| Flag | Purpose |
|---|---|
| `--name <name>` | VM name (auto-generated if omitted) → becomes `<name>.exe.xyz` |
| `--image <image>` | OCI container image to boot |
| `--cpu`, `--memory`, `--disk` | Resources (e.g. `4`, `4GB`, `8G`, `20GB`) |
| `--env KEY=VALUE` | Env var; repeatable |
| `--tag <t>` | Tag at creation; repeatable or comma-separated |
| `--integration <name>` | Attach integration at creation; repeatable/comma-separated |
| `--setup-script <path>` | First-boot script (≤10KiB); use `/dev/stdin` to pipe |
| `--prompt <text>` | Initial prompt to Shelley after creation (exeuntu image); `/dev/stdin` to pipe |
| `--registry-auth USER:PASS` | Private registry creds for `--image` |
| `--comment <text>` | Short note (≤200 bytes) |
| `--json` | JSON output (always prefer this for scripting) |

`new --json` returns the VM's `vm_name`, `https_url`, `ssh_dest`, `region`, `status`:

```sh
ssh exe.dev new --name=bloggy --json | jq '.vms[0]'   # see shape below
# {
#   "https_url": "https://bloggy.exe.xyz",
#   "region": "lon", "region_display": "London, UK",
#   "ssh_dest": "bloggy.exe.xyz",
#   "status": "running", "vm_name": "bloggy"
# }
```

### 2. Customize the VM

Three approaches, in order of simplicity:

**a. Just SSH in and build it** — the most common path. Clone a repo (optionally via the GitHub integration), run your build/server.

```sh
ssh bloggy.exe.xyz
  # inside the VM:
  git clone https://github.com/me/myapp && cd myapp
  pip install -r requirements.txt
  python -m myapp --port 8080
```

**b. Custom Docker image** — publish an image, boot VMs from it. Use the open-source [exeuntu](https://github.com/boldsoftware/exeuntu) Dockerfile as a base. Supports OCI labels:

```dockerfile
LABEL exe.dev/install-shelley=true   # auto-install Shelley on creation
LABEL exe.dev/login-user=...          # user SSH connections arrive as
```

```sh
ssh exe.dev new --image=myorg/my-app:latest
```

Private registries: `--registry-auth octocat:ghp_xxx`.

**c. Setup script** — runs once at first boot (`/exe.dev/setup` on the exeuntu image). Pipe from stdin for multi-line scripts:

```sh
cat setup.sh | ssh exe.dev new --setup-script /dev/stdin
# inline (no shebang):
ssh exe.dev new --name=api --setup-script '"apt-get update && apt-get install -y nginx"'
# default for ALL future VMs:
(echo '#!/bin/bash'; echo 'apt-get update') | ssh exe.dev defaults write dev.exe new.setup-script
ssh exe.dev defaults delete dev.exe new.setup-script   # clear it
```

### 3. Expose it over HTTPS — `share port` / `share set-public`

By default exe.dev auto-picks the proxied port from the image's `EXPOSE` directives (preferring 80, else smallest exposed port ≥1024). Point the proxy at a different port, then make it public:

```sh
ssh exe.dev share port bloggy 8080       # set proxied port (keeps current visibility)
ssh exe.dev share set-public bloggy      # anyone can access https://bloggy.exe.xyz/ (no login)
ssh exe.dev share set-private bloggy     # back to authenticated-only (default)
ssh exe.dev share show bloggy             # current shares + port + visibility
ssh exe.dev share show bloggy --qr       # + QR code
```

**Alternate ports** (3000–9999) are transparently forwarded: serving on port `3456` in the VM → `https://bloggy.exe.xyz:3456/`. Only the single `share port`-selected port can be made *public*; alternate ports are authenticated-only.

**Reverse-proxy headers** are included on every request: `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`.

> **Dev-server gotcha (Next.js/Vite/etc.):** JS dev servers reject requests from the `*.exe.xyz` host by default. Configure `allowedDevOrigins` (Next.js) or `server.allowedHosts` (Vite) to accept your exe.dev hostname. See https://exe.dev/docs/faq/nextjs-and-friends.

### 4. Access & verify

```sh
ssh exe.dev ls -l                      # list your VMs (detailed)
ssh exe.dev stat bloggy --range=24h    # CPU/mem/disk/IO metrics
curl -sI https://bloggy.exe.xyz/       # the deployed service
```

### 5. Tear down

```sh
ssh exe.dev rm bloggy                  # delete (accepts multiple names)
```

## Core lifecycle commands

| Command | Purpose |
|---|---|
| `new` | Create a VM (see flags above) |
| `ls [-l] [--group=tag\|region] [pattern]` | List VMs; `--json` for scripting |
| `ssh [-l user] [user@]<vm> [cmd...]` | Connect to a VM (lobby form — usually just `ssh <vm>.exe.xyz`) |
| `restart <vm>` | Restart a VM |
| `rm <vm> [<vm>...]` | Delete VM(s) |
| `resize <vm> --memory=4GB --cpu=2 --disk=25GB` | Resize resources (disk only grows) |
| `cp <src> [new-name] [--cpu=] [--memory=] [--disk=]` | Clone a VM |
| `rename <vm> <new-name>` | Rename |
| `tag [-d] <vm> <tag> [tag...]` | Add (`-d` to remove) tags |
| `comment <vm> <text>` | Set/clear a short note (`""` to clear) |
| `stat <vm> [--range=24h\|7d\|30d]` | Resource metrics |
| `set-region <code>` | Preferred region for new VMs |
| `whoami` | Your account info |

All accept `--json`. Use `--help` on any command to introspect flags as JSON with no side effects (great for agents): `ssh exe.dev new --help`.

## Sharing access

Three mechanisms (your email is visible to sharees):

```sh
ssh exe.dev share set-public bloggy                       # anyone, no login
ssh exe.dev share add bloggy friend@example.com --message='Check this out'   # email invite
ssh exe.dev share add bloggy team                         # share with a team
ssh exe.dev share add-link bloggy                         # shareable link (must register+login)
ssh exe.dev share remove bloggy friend@example.com       # revoke a user
ssh exe.dev share remove-link bloggy <token>             # revoke a link (doesn't revoke existing access)
```

Team access control:

```sh
ssh exe.dev share access allow bloggy     # team can SSH/use Shelley/web proxy
ssh exe.dev share access disallow bloggy  # restrict team access
```

## Custom domains — `domain`

Bring your own domain (CNAME must already point at the VM):

```sh
ssh exe.dev domain add bloggy app.example.com            # register an existing CNAME
ssh exe.dev domain add --wildcard bloggy app.example.com # + *.example.com cert via DNS-01
ssh exe.dev domain ls bloggy                             # domains on one VM
ssh exe.dev domain ls -a                                 # across all your VMs
ssh exe.dev domain rm bloggy app.example.com
```

## Integrations — `integrations` (`int`)

Integrations attach external capabilities to VMs. The default `llm` integration is attached to `auto:all`, so **every VM can use the LLM gateway out of the box** — no API keys stored on the VM.

```sh
ssh exe.dev integrations list                 # all your integrations
ssh exe.dev int add http-proxy --name=myproxy --target=http://upstream:8080 --header="X-Auth:secret"
ssh exe.dev int add http-proxy --name=public  --target=http://api:3000 --no-auth
ssh exe.dev int attach myproxy vm:bloggy      # attach to a VM
ssh exe.dev int attach myproxy tag:prod       # ...or a tag
ssh exe.dev int attach myproxy auto:all        # ...or all current+future VMs (personal)
ssh exe.dev int detach myproxy vm:bloggy
ssh exe.dev int edit myproxy --header="X-Token:new"
ssh exe.dev int rename myproxy myproxy2
ssh exe.dev int remove myproxy
```

Attach specs:

| Spec | Scope | Notes |
|---|---|---|
| `vm:<name>` | one specific VM | personal only |
| `tag:<name>` | every VM with that tag | works for team integrations too |
| `auto:all` | all current + future VMs | personal only |

Integration types: `http-proxy` (inject headers / bearer / no-auth), `github` (private repo access), `llm` (managed model providers), plus `chatgpt` setup. Use `integrations setup github` / `integrations setup chatgpt` for the OAuth flows, then attach.

### LLM gateway (managed model access)

New accounts get a default `llm` integration attached to `auto:all`, so code in any VM can call Anthropic/OpenAI/Fireworks with **no keys on the VM** (auth is the VM itself; uses your exe.dev monthly token allocation):

```text
# high-level integration endpoint (inside the VM)
https://llm.int.exe.xyz/v1/models

# low-level direct provider routing (inside the VM)
http://169.254.169.254/gateway/llm/<provider>   # anthropic | openai | fireworks
```

For your own API keys or a ChatGPT subscription, configure those as alternative sources on an LLM integration (keys are hidden from the VM). Default `llm` = exe.dev-managed gateway.

## HTTPS API (CI / automation)

The exe.dev HTTPS API is **the SSH API shoved into a POST body** — same commands, JSON always on. Endpoint: `POST https://exe.dev/exec`, body = the ssh command, `Authorization: Bearer <token>`.

```sh
# Generate a token (signed by your SSH key; always set exp)
ssh exe.dev ssh-key generate-api-key --exp=30d

# Use it
curl -X POST https://exe.dev/exec \
  -H "Authorization: Bearer exe1.AAA" \
  -d 'new --name=ci-runner --json'
```

Token permissions are signed JSON (plaintext in the token — **never put secrets in it**). Fields:

- `exp` / `nbf`: integer UTC unix timestamps (always set `exp`).
- `cmds`: allowed commands as an array; subcommands must be explicit (`"ssh-key list"`, not just `"ssh-key"`). Default: `["help","ls","new","whoami","ssh-key list","share show","exe0-to-exe1","team","team members"]`.
- `ctx`: arbitrary JSON passed through to your VM server (e.g. for HTTPS VM tokens).

**Limits:** no stdin, no pty, 30s timeout (504 on timeout), 64KB body (413), 64KB token (8KB), POST only (405). Use separate SSH keys for independent workloads (rate limits are per-key → 429). Compact JSON with `jq -c`; no whitespace/newlines/null bytes/duplicate keys.

For tokens **scoped to a VM's HTTPS endpoints** (not the lobby), see [HTTPS Tokens for VMs](https://exe.dev/docs/https-tokens-for-vms.md). To sign tokens locally with your SSH key, see [HTTPS API Local Key Creation](https://exe.dev/docs/https-api-local-key.md).

## Deploying a small service — operational checklist

Follow this decision tree for agentic/CI deploys:

1. **Already have a VM?** `ssh exe.dev ls --json | jq '.vms[] | {vm_name, status, https_url}'`. If a suitable VM exists, skip to step 3.
2. **Create a VM** sized for the service:
   ```sh
   ssh exe.dev new --name=api --cpu=2 --memory=4GB --disk=20GB --json
   ```
   Use `--image` if you have a prebuilt image, else boot exeuntu and build inside.
3. **Get code onto the VM** — fastest paths:
   ```sh
   git clone <repo>            # inside the VM (set up the GitHub integration for private repos), or
   rsync -avz ./src/ api.exe.xyz:~/src/   # from your machine
   ```
   For a reproducible image: publish it and `new --image=...`, or pipe a `--setup-script`.
4. **Run the service** — start it (consider a process manager / systemd unit / `tmux` for persistence across SSH sessions). Note the port it listens on.
5. **Expose over HTTPS:**
   ```sh
   ssh exe.dev share port api <port>
   ssh exe.dev share set-public api      # if it should be public
   curl -sI https://api.exe.xyz/
   ```
6. **Custom domain?** `ssh exe.dev domain add api app.example.com` (after pointing the CNAME).
7. **Need LLMs in the service?** Nothing to do — the default `llm` integration is on every VM. Call `https://llm.int.exe.xyz/...` or `http://169.254.169.254/gateway/llm/<provider>` from your code.
8. **Scale if needed:** `ssh exe.dev resize api --memory=8GB` (disk only grows).
9. **Observe:** `ssh exe.dev stat api --range=24h`.
10. **Tear down:** `ssh exe.dev rm api`.

## Cross-cutting tips

- **Always use `--json`** when scripting (`ls`, `new`, `stat`, `share show`, `domain ls` all support it); parse with `jq`.
- **Always pass `StrictHostKeyChecking=accept-new`** on first connect to a new VM/destination in non-interactive shells.
- **Two destinations, don't mix them:** `ssh exe.dev <cmd>` for lifecycle (no scp/sftp/shell); `ssh <vm>.exe.xyz` for everything inside a VM. scp/sftp failures almost always mean you targeted `exe.dev` instead of `<vm>.exe.xyz`.
- **Disk only grows:** `resize --disk` must be larger than the current size.
- **One region per account:** all your VMs live in your account's region; change with `set-region` (affects new VMs).
- **Introspect without side effects:** `<command> --help` returns flags/examples as JSON — ideal for an agent to discover options safely.
- **Cost model:** VMs share underlying CPU/RAM; you pay for resources, not per VM. Make a bunch of small services.
- **It's just a computer:** standard Linux tooling (systemd, nginx, caddy, docker, tmux) all work inside a VM.

## Reference

- Built-in help: `ssh exe.dev help`, `ssh exe.dev help <command>`, `<command> --help` (JSON).
- Docs index: https://exe.dev/docs.md
- All docs: https://exe.dev/docs/all.md
- HTTP proxies: https://exe.dev/docs/proxy.md
- Customizing VMs: https://exe.dev/docs/customization.md
- Sharing: https://exe.dev/docs/sharing.md
- HTTPS API: https://exe.dev/docs/https-api.md
- API (SSH): https://exe.dev/docs/api.md
- Regions: https://exe.dev/docs/regions.md
- LLM Gateway: https://exe.dev/docs/shelley/llm-gateway.md
- Integrations: https://exe.dev/docs/integrations.md
- Agent skill (official): https://exe.dev/docs/agent-skill.md
- CLI reference: https://exe.dev/docs#10-cli-reference
- Community/Discord: https://exe.dev/docs/community.md
