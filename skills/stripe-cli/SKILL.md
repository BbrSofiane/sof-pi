---
name: stripe-cli
description: Use this skill when the user wants to interact with Stripe via the `stripe` CLI — forwarding webhooks locally, triggering test events, inspecting API request logs, and creating/listing/updating Stripe resources (customers, products, prices, payment intents, charges, etc.) from the terminal. Triggers on tasks like "listen for stripe webhooks", "trigger a stripe event", "create a stripe customer/product/price", "list my stripe products", "check stripe logs", or "test my stripe integration".
compatibility: Requires the `stripe` CLI installed (via mise: `stripe-cli`) and on PATH, and authenticated. Verify with `stripe whoami`; run `stripe login` if not logged in.
---

# Stripe CLI (`stripe`) Skill

Use this skill to interact with Stripe from the terminal using the `stripe` CLI. Covers local webhook forwarding (the most common dev workflow), triggering test events, tailing API request logs, and running CRUD operations on Stripe resources without hand-curling the REST API.

## Setup

The CLI is installed machine-wide via mise as `stripe-cli` (binary name `stripe`). Authenticate once with a browser flow.

```bash
stripe --version      # current CLI version
stripe whoami        # show current auth state (account, mode, project)
stripe login         # browser-based login flow (also --api-key for headless)
stripe logout        # remove stored credentials (-a to logout all projects)
```

Config lives at `~/.config/stripe/config.toml`. Multiple Stripe accounts are modeled as **projects**; switch with `-p, --project-name <name>` (default project is `default`). Use `stripe config` to manage project entries.

- For CI/headless use, prefer `--api-key <sk_...>` (or `STRIPE_API_KEY` env var) over `stripe login`.
- For Connect platforms, target a connected account with `--stripe-account <acct_...>`.
- Pin an API version with `--stripe-version 2025-01-01` or `--latest` for the newest.

## Global conventions

`stripe {command} <args> [flags]`. Global flags (apply to most commands):

| Flag | Purpose |
|---|---|
| `--api-key <key>` | Use a secret key instead of the logged-in device session. |
| `--stripe-account <acct_...>` | Act on a connected account (`Stripe-Account` header). |
| `--stripe-version <ver>` / `--latest` | Use a specific (or latest) API version for the request. |
| `-p, --project-name <name>` | Select a named project config (multi-account). |
| `--config <path>` | Use a non-default config file (default `~/.config/stripe/config.toml`). |
| `--device-name <name>` | Run on behalf of another registered device. |
| `--log-level <debug\|info\|warn\|error>` | Logging verbosity. |
| `--color <on\|off\|auto>` | Color output. |
| `--map [tree\|compact\|paths\|json]` | Print the command tree (handy for discovery). |
| `-h, --help` | Help for a command. |

**Discovery:** every command supports `--help`. For a full map run `stripe --help` or `stripe --map`. Run `stripe resources help` to list every resource command, and `stripe v2 help` for v2-only resources.

## Webhooks: `listen` (local forwarding) and `trigger` (test events)

This is the core local-development workflow: start `stripe listen` to forward real webhook events to your local server, then fire test events with `stripe trigger`.

### `stripe listen` — webhook forwarding (long-running)

Watches events on your account and forwards them to a local (or remote) endpoint. Runs as a foreground, daemon-like process; **`Ctrl-C` to stop.**

```bash
stripe listen                                          # stream all events to stdout
stripe listen --forward-to localhost:4242/webhook      # forward to your local handler
stripe listen --events charge.captured,charge.updated \
  --forward-to localhost:3000/events                    # filter to specific event types
stripe listen --forward-to localhost:3000/events \
  --forward-connect-to localhost:3000/connect           # separate Connect endpoint
```

Key flags:
- `-f, --forward-to <url>` — destination for forwarded webhooks (e.g. `localhost:4242/webhook`).
- `-e, --events <type1,type2,...>` — comma-separated event types to listen for (default `[*]` = all). See https://stripe.com/docs/api/events/types.
- `--forward-connect-to <url>` — separate URL for Connect events (defaults to the normal endpoint).
- `--forward-thin-to` / `--forward-thin-connect-to` — endpoints for thin events.
- `-H, --headers "Key1:Value1, Key2:Value2"` — custom headers to forward.
- `--connect-headers` — same, but for Connect.
- `--format JSON` — output events in JSON.
- `--skip-verify` (global-style) — skip TLS verification for `https://localhost` in dev.

`listen` prints a **webhook signing secret** (`whsec_...`) on startup — use it as `STRIPE_WEBHOOK_SECRET` in your local app to verify signatures. **Never commit this secret.**

### `stripe trigger` — fire test events

Generates the named event (and the underlying API calls) on your account so `listen` can forward it.

```bash
stripe trigger payment_intent.succeeded
stripe trigger checkout.session.completed
stripe trigger customer.created
stripe trigger charge.succeeded
stripe trigger --help        # list all supported event aliases + per-scenario flags
```

Event-specific parameters can be overridden with `--<param>=value` (see `stripe trigger <event> --help`). Common flow: run `stripe listen --forward-to ...` in one terminal, `stripe trigger <event>` in another, and watch your handler receive the event.

## Resources: customers, products, prices, payment_intents, charges, …

Resource commands map 1:1 to API methods (`create`, `retrieve`, `update`, `delete`, `list`, `search`, plus resource-specific ones like `capture`/`confirm`). Pass parameters as `--<field>=value`.

```bash
# Customers
stripe customers create --email="user@example.com" --name="Example User"
stripe customers list --limit=10
stripe customers retrieve cus_abc123
stripe customers search --query="email:'user@example.com'"

# Products + prices
stripe products create --name="My Product" --description="Test product"
stripe products list --limit=5 --expand=default_price
stripe prices create --unit-amount=3000 --currency=usd --product=prod_abc123
stripe prices list --product=prod_abc123 --limit=10

# Payment intents / charges
stripe payment_intents create --amount=2000 --currency=usd
stripe payment_intents retrieve pi_abc123
stripe charges list --limit=10
```

Common resource flags:
- `--limit <n>` — pagination when listing.
- `--expand <field>` — expand nested objects (`default_price`, `customer`, etc.).
- `--metadata[key]=value` — set metadata.
- All global flags (`--api-key`, `--stripe-version`, `--stripe-account`, `-p`) apply.

Run `stripe resources help` for the full list of resource commands; `stripe <resource> --help` for subcommands; `stripe <resource> <subcommand> --help` for exact fields.

## API escape hatch: `get` / `post` / `delete`

For endpoints not wrapped by a resource command, make raw authenticated requests:

```bash
stripe get /v1/customers/cus_abc123
stripe post /v1/customers -d email=user@example.com -d name="Example User"
stripe delete /v1/customers/cus_abc123
```

Use `-d key=value` (repeatable) for params. Prefer the resource commands when they exist; reach for these only for unwrapped endpoints.

## Logs: `stripe logs tail`

Stream real-time API request logs from your account.

```bash
stripe logs tail                       # stream all API requests
stripe logs tail --events request_type_a,request_type_b   # filter by category
```

Long-running; `Ctrl-C` to stop. Useful for "what API call did my app just make?" debugging.

## Fixtures: seed test data

Run a YAML file of sequenced API operations to populate an account with test data.

```bash
stripe fixtures path/to/fixtures.yml
stripe fixtures fixtures.yml --override plan:product.name="Override Name"   # runtime overrides
```

Useful for reproducible test setups (e.g. creating a product + price + customer in one shot).

## Cross-cutting tips

- **Local webhook loop:** `stripe listen --forward-to localhost:PORT/path` (terminal 1) → `stripe trigger <event>` (terminal 2) → observe your handler. Grab the `whsec_...` secret from the `listen` output for signature verification.
- **Multi-account:** define projects in config, then `-p my_test_account` on every command (or `stripe config` to set a default).
- **Headless/CI:** skip `stripe login` and use `--api-key` / `STRIPE_API_KEY` instead.
- **Reproducible API versions:** pin `--stripe-version` in scripts so behavior doesn't shift when Stripe bumps the default.
- **Discovery first:** before assuming a command/field, run `stripe --map`, `stripe resources help`, or `<command> --help`.

## Reference

- Built-in help: `stripe --help`, `stripe <command> --help`, `stripe resources help`, `stripe v2 help`.
- CLI reference: https://docs.stripe.com/cli
- Flags: https://docs.stripe.com/cli/flags
- Use the CLI: https://docs.stripe.com/stripe-cli/use-cli
- Webhooks + listen: https://docs.stripe.com/stripe-cli/webhooks
- Event types: https://stripe.com/docs/api/events/types
- Source: https://github.com/stripe/stripe-cli
