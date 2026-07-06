---
name: database-query
description: Use this skill when the user wants to run SQL queries against a relational database from the terminal via the `usql` CLI — Postgres, MySQL/MariaDB, SQLite, SQL Server, Oracle, and other Go `database/sql`-backed databases. Triggers on tasks like "query the database", "run this SQL", "export query results as JSON", "inspect tables in my db", "connect to postgres and run a query", "dump a CSV from a SQL query", or "list databases/schemas". Covers the non-interactive/scriptable patterns needed for embedding database access in automated workflows.
compatibility: "Requires the `usql` CLI installed and on PATH. Verify with `usql -V`. A database connection string (DSN) is required for every command — pass it as the first positional argument, or via the `DATABASE_URL` env var for Postgres-style DSNs."
---

# Database query (`usql`) Skill

Use this skill to run SQL against a relational database from the terminal using **`usql`** — a single-binary, cross-platform universal SQL CLI written in Go and modelled on `psql`. It speaks PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, and many other backends through Go `database/sql` drivers, all from one binary.

**`usql` is the right tool for this package's workflows** because it is explicitly designed to be non-interactive and scriptable: run a single query and exit (`-c`), execute a query file (`-f`), read SQL from stdin for pipelines, interpolate variables, and export results as JSON or CSV. That makes it suitable for embedding in automated workflows — shell out with a DSN + query, capture stdout, parse the structured output.

## Setup

```bash
usql -V                  # current usql version (verify install)
usql -?                  # full flag reference
```

`usql` is distributed as a single binary; supported drivers are compiled in (no separate driver installs). For niche backends, [usqlgen](https://github.com/sclgo/usqlgen) can produce a custom `usql` build with extra drivers without forking; reach for it only if a needed driver is missing from the stock build.

### Connection strings (DSNs)

`usql` takes a URL-style DSN as its first positional argument. The scheme selects the driver:

| Database | DSN scheme / example |
| --- | --- |
| PostgreSQL | `postgres://user:pass@host:5432/dbname` (alias `pg://`) |
| MySQL / MariaDB | `mysql://user:pass@host:3306/dbname` |
| SQLite | `sqlite:///path/to/file.db` · `sqlite:///:memory:` |
| SQL Server | `sqlserver://user:pass@host:1433/dbname` (alias `mssql://`) |
| Oracle | `oracle://user:pass@host:1521/service` |

> **DSN is a secret.** Connection strings embed credentials. Treat them as sensitive: pass via an env var (e.g. `DATABASE_URL`) or read from a gitignored `.env` / secrets store — never paste raw DSNs into transcripts, logs, or commits. See *Secrets & safety* below.

```sh
# Postgres-style DSNs can be supplied via DATABASE_URL (common convention)
usql "$DATABASE_URL" -c "SELECT 1;" -q

# Or pass explicitly (the user's DSN resolves in the shell, not in the transcript)
usql "$MY_DB_DSN" -c "SELECT count(*) FROM users;" -J -q
```

## Global conventions

`usql [DSN] [options]`. Flags most relevant to scripting/agents:

| Flag | Purpose |
| --- | --- |
| `-c, --command=SQL` | Run a single SQL (or `\` meta) command and exit. **Core non-interactive flag.** |
| `-f, --file=PATH` | Execute SQL from a file and exit. Use for multi-statement scripts. |
| (stdin) | Pipe SQL on stdin: `echo "SELECT 1;" \| usql DSN` / `cat q.sql \| usql DSN`. |
| `-q, --quiet` | Suppress informational messages — show only query output. **Always use for parsing.** |
| `-J, --json` | Emit results as JSON. **Use for programmatic result handling.** |
| `-C, --csv` | Emit results as CSV. |
| `-A, --no-align` | Unaligned output (delimited, no table padding) — pipe/parse friendly. |
| `-F, --field-separator=SEP` | Field separator for unaligned/CSV (default `,` for CSV, `|` for unaligned). |
| `-R, --record-separator=SEP` | Record separator (default newline). |
| `-P VAR=ARG` | Set a `\pset` printing option (e.g. `-P format=json`). Equivalent to interactive `\pset`. |
| `-1` | Wrap the input in a single transaction; rollback the whole batch if any statement fails. |
| `-v NAME=VALUE` | Set a variable (interpolated as `:NAME` in SQL). |
| `-t, --tuples-only` | Rows only — no headers/footers. Good for single-value extraction. |
| `--config=PATH` | Use a specific config file (default reads `.usqlrc`). |
| `-V, --version` | Print version and exit. |
| `-?, --help` | Show help. |

**Agent/scripting pattern:** `usql DSN -c "SELECT ..." -q -J` (JSON) or `-q -C` (CSV) — quiet + structured output is the reliable combination for parsing stdout in a workflow.

## Running queries non-interactively (the core workflow)

### One-off query → JSON (best for parsing)

```sh
usql "$DATABASE_URL" -c "SELECT id, name, email FROM users LIMIT 10;" -J -q
```

Output is a JSON array of row objects — pipe to `jq` for field extraction:

```sh
usql "$DATABASE_URL" -c "SELECT id, name FROM users WHERE active;" -J -q | jq '.[].name'
```

### One-off query → CSV (best for export / spreadsheet handoff)

```sh
usql "$DATABASE_URL" -c "SELECT * FROM orders WHERE created_at > '2026-01-01';" -C -q > orders.csv
```

### Query from a file (`-f`)

For multi-statement scripts or large queries, write the SQL to a file and execute it. Keeps the SQL out of the shell's quoting/escaping and off the command line.

```sh
usql "$DATABASE_URL" -f migrate.sql -q
usql "$DATABASE_URL" -f report.sql -C -q > report.csv
```

### Pipe SQL via stdin (composable pipelines)

```sh
echo "SELECT count(*) FROM users;" | usql "$DATABASE_URL" -q -t          # bare count value
cat generated_query.sql | usql "$DATABASE_URL" -J -q | jq 'length'      # row count via jq
```

`-t` (tuples-only) + `-q` yields just the value(s), ideal for capturing a scalar into a shell variable:

```sh
COUNT=$(usql "$DATABASE_URL" -c "SELECT count(*) FROM users;" -q -t | tr -d '[:space:]')
echo "user count: $COUNT"
```

### Single-transaction batches (`-1`)

Wrap a multi-statement run in one transaction — if any statement fails, the whole batch rolls back (no partial state). Useful for migrations/data-fix scripts.

```sh
usql "$DATABASE_URL" -1 -f apply_fix.sql -q
```

## Variables & interpolation

`usql` supports `psql`-style variable interpolation: `:var` in SQL is replaced by a variable's value. Set them with `-v` on the command line or `\set` in a session/file.

```sh
usql "$DATABASE_URL" -v LIMIT=50 -c "SELECT * FROM users LIMIT :LIMIT;" -J -q
```

This keeps dynamic values out of string-concatenated SQL (safer than naive interpolation — but note `usql` variables are textual substitution, **not** parameterized queries; never interpolate untrusted user input this way).

## Inspecting the schema (meta-commands)

`usql` supports `psql`-style backslash meta-commands, and they work with `-c` too, so you can introspect non-interactively:

```sh
usql "$DATABASE_URL" -c "\dt" -q        # list tables
usql "$DATABASE_URL" -c "\d users" -q   # describe the users table (columns, types, indexes)
usql "$DATABASE_URL" -c "\dn" -q         # list schemas/namespaces
usql "$DATABASE_URL" -c "\df" -q         # list functions
usql "$DATABASE_URL" -c "\dx" -q         # list extensions
```

> **Meta-command availability is driver-dependent.** `\dt` and `\d <table>` are widely supported across drivers (verified on SQLite, Postgres, MySQL). Some commands are backend-specific and will error on drivers that lack the concept — notably `\l` (list databases) and `\dn` (list schemas) are **not supported by the SQLite driver** (SQLite is a single-file DB with no database/schema hierarchy). If a meta-command errors with `not supported by <driver> driver`, fall back to a SQL query against the backend's information schema (e.g. `SELECT name FROM sqlite_master WHERE type='table';` for SQLite, `SELECT schema_name FROM information_schema.schemata;` for Postgres).

To page results or run ad-hoc queries interactively, drop into a session with `\?` listing all meta-commands:

```sh
usql "$DATABASE_URL"          # drop into an interactive psql-style session
```

## Integrating with provisioned databases

Databases provisioned through this package's other skills usually expose a connection string as an env var. Resolve the DSN from the right source rather than asking the user to paste it:

- **Stripe Projects** (`stripe-projects` skill) — run `stripe projects env --pull` to sync credentials to `.env`, then reference the provider's `DATABASE_URL` (or `POSTGRES_URL`, etc.) from the shell. Use `stripe projects status` to find which service owns which var.
- **Fly.io Managed Postgres (MPG)** (`fly-io` skill) — `flyctl mpg attach <cluster_id> --app <app>` injects `DATABASE_URL` as a Fly secret; for local access use `flyctl mpg proxy <cluster_id>` to tunnel, then connect to the proxied DSN.

```sh
# Example: query a Stripe-Projects-provisioned Postgres
source .env 2>/dev/null || true
usql "$DATABASE_URL" -c "SELECT current_database(), current_user;" -q -t
```

## Secrets & safety

Connection strings and query results frequently contain credentials or sensitive data. Rules:

- **Never echo raw DSNs** into transcripts, logs, or commits. Reference them by env-var name (`$DATABASE_URL`) so the shell resolves the value; the transcript shows the variable name, not the secret.
- **Load credentials from a secrets source** — a gitignored `.env`, a secrets manager, or the Stripe Projects vault — not from literal strings in commands.
- **Be deliberate about what you SELECT.** Avoid `SELECT *` over tables with PII / secrets unless the user asked for it; prefer specific columns. Don't dump full user/credential tables into transcripts — limit rows (`LIMIT n`) or project non-sensitive columns.
- **Read-only where possible.** For inspection workflows, prefer a DB role with read-only privileges. Destructive statements (`DROP`, `DELETE`, `TRUNCATE`, schema migrations) should require explicit user confirmation before running.
- **Prefer `--config`/`.usqlrc` for persistent `\pset` defaults** (e.g. a project-local `.usqlrc` setting `format=json`) rather than repeating long flag strings — but keep any DSN out of `.usqlrc`.

## Cross-cutting tips

- **Quiet + structured = parseable.** `-q -J` (JSON) or `-q -C` (CSV) is the reliable combination for capturing and parsing stdout. Plain table output has padding and headers that break naive parsing.
- **Scalars: `-q -t`.** For a single value, `-t` (tuples-only) strips headers/footers; trim whitespace with `tr -d '[:space:]'`.
- **Multi-statement scripts: `-f`, not `-c`.** `-c` is for one command; use `-f file.sql` (or stdin) for batches, and add `-1` to wrap them in a transaction.
- **Driver coverage:** stock `usql` ships with the common drivers compiled in. If a backend (e.g. a less-common DB) isn't supported, check `usql -?` / the [supported databases list](https://github.com/xo/usql#databases) and consider a custom build via [usqlgen](https://github.com/sclgo/usqlgen). Some backslash meta-commands are also driver-dependent (see *Inspecting the schema*).
- **DSN first arg:** the DSN is always the first positional argument before flags — `usql DSN -c "..."`, not `usql -c "..." DSN`.
- **Quoting:** prefer `-f file.sql` or stdin over `-c "..."` for anything beyond trivial SQL, to avoid shell-quoting pitfalls with quotes/semicolons/newlines.
- **Discover help:** `usql -?` for the full flag reference; in an interactive session, `\?` lists all backslash meta-commands.

## Reference

- Built-in help: `usql -?` (flags), `\?` (meta-commands in a session).
- usql repo: https://github.com/xo/usql
- Supported databases & DSN schemes: https://github.com/xo/usql#databases (via [dburl](https://github.com/xo/dburl))
- Variable interpolation: https://github.com/xo/usql#variables
- Custom builds: https://github.com/sclgo/usqlgen
