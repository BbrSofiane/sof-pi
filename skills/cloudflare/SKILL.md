---
name: cloudflare
description: Use this skill when the user wants to interact with Cloudflare via the `cf` CLI — managing DNS records, zones, Workers, KV, R2, D1, caches, firewall/WAF rules, Access, tunnels, or account settings. Triggers on tasks like "manage my DNS on Cloudflare", "purge the cache", "list my zones", "deploy a worker", or "check my Cloudflare account".
compatibility: "Requires the `cf` CLI installed and authenticated. Verify with `cf auth whoami`; use `cf auth login` to authenticate."
---

# Cloudflare (`cf`)

Use `cf` to manage Cloudflare resources. It is an agent-first CLI: don't guess commands — discover them.

## Command discovery (important)

`cf` blocks chained `--help` exploration and expects its search workflow:

1. `cf cli search "<describe action + resource>"` — returns 5 compact JSON matches. Keep queries **anonymous**: describe the action and resource type only, never include names, emails, domains, IDs, or tokens.
2. `cf <command> --help` — detailed help for the discovered command.
3. `cf schema <command>` — API request details for the command (replace leading `cf` with `cf schema`).

## Authentication and targeting

- Check `cf auth whoami` before making changes.
- Auth profiles: `cf auth list`, `cf auth create <name>`, `cf auth activate <name> [dir]` (binds a profile to a directory).
- Pass `-z <zone-id-or-domain>` (or set `CLOUDFLARE_ZONE_ID`) to target a zone explicitly rather than relying on the working directory.
- `--profile <name>` overrides the auth profile per call; `-q` suppresses non-essential output.

## Common areas

- **DNS:** `cf dns records list`, `create`, `update`, `delete`, `import`, `export`, `batch`
- **Zones/accounts:** `cf zones`, `cf accounts`, `cf account`
- **Workers:** `cf workers` (deploy, listings); project scaffolding via `cf init`, `cf dev`, `cf build`, `cf deploy`
- **Storage:** `cf kv`, `cf r2`, `cf d1`, `cf durable-objects`
- **Cache:** `cf cache` (purge, Cache Reserve, tiered caching)
- **Security:** `cf firewall`, `cf access`, `cf ssl`
- **Tunnels:** `cf tunnel`

Prefer listing/reading before mutating, and verify mutations with a follow-up read.
