---
name: mise
description: Use this skill when managing dev tools, runtime versions, or environment variables with `mise`, or when running mise tasks (make-like commands). Triggers on tasks like "install a tool", "pin node version", "set an env var", "add a CLI to my machine", "run a mise task", "what tools do I have installed", or "update my dev environment".
compatibility: Requires the `mise` CLI installed and on PATH. Global config lives at `~/.config/mise/config.toml`.
---

# Mise Skill

Use this skill to manage dev tools, runtime versions, and environment variables with `mise`. Sofiane's global mise config is the single source of truth for what's installed machine-wide.

## Config layout

The global config is **`~/.config/mise/config.toml`**. It has two sections:

- `[env]` — environment variables exported into every shell session. Holds secrets and workspace IDs (AWS, Notion, OpenRouter, Perplexity, Whoop, etc.). **Treat these as sensitive.** Never echo raw values into transcripts/logs; reference by name.
- `[tools]` — pinned tool versions installed machine-wide (e.g. `python = "3.12"`, `node = "24.4.1"`, `pi = "0.80.2"`, `"npm:ntn" = "0.15.1"`, `"github:openclaw/gogcli" = "0.31.1"`).

Prefer editing this file directly for global changes (via the `edit` tool), then run `mise install` to materialize new versions. Use `mise use -g` as a shortcut that writes the file for you.

When working inside a project, mise also reads `mise.toml` / `.mise.toml` / `mise.local.toml` in the cwd and ancestors. Project-local configs override the global one.

## Inspecting state

```bash
mise --version              # current mise version
mise config ls              # list config files + tools per file
mise ls                     # installed tool versions
mise ls --installed         # only installed
mise current                # active resolved versions for cwd
mise where <tool>           # install path of active version
mise which <tool>           # shim/path mise would invoke
mise info <tool>            # tool metadata (plugin, versions)
mise plugins ls             # installed backends (user does not use custom plugins)
```

## Managing tools (devtools / runtimes)

```bash
# Install a version without activating it
mise install node@20          # also accepts bare versions from config

# Install AND activate by writing to a config file
mise use -g node@24.4.1       # -g writes ~/.config/mise/config.toml (global)
mise use node@20              # writes ./mise.toml (project-local) — usually not what we want
mise use -g python@3.12

# Upgrade a pinned tool: edit the version in config.toml, then
mise install                  # installs everything missing/new in config

# Remove a tool version
mise uninstall node@20
mise rm node@20               # remove from config + uninstall

# Bump mise itself
mise upgrade mise             # or `mise use -g mise@latest`
```

Tool spec syntax in `[tools]`:
- Plain backend: `python = "3.12"`, `node = "24.4.1"`
- Namespaced (vfox/asdf-style): `"pipx:aws-sso-util" = "latest"`, `"npm:ntn" = "0.15.1"`, `"github:openclaw/gogcli" = "0.31.1"`
- `latest` resolves to the newest release.

**When the user asks to "install X" or "add X to my machine":** add a line under `[tools]` in `~/.config/mise/config.toml` (or use `mise use -g <spec>`), then run `mise install` to materialize it, then verify with `mise current | grep <tool>` or `mise which <tool>`.

## Environment variables

`[env]` in `~/.config/mise/config.toml` exports vars into every shell.

```bash
# Read a resolved value (does not leak into transcript if you grep by name)
mise env | grep '^VAR_NAME='

# Set via CLI (writes config file). -g targets global config.
mise set -g FOO=bar
mise set -g FOO=bar GREETING=hello

# Unset
mise unset -g FOO
```

Prefer editing `~/.config/mise/config.toml` directly with the `edit` tool for multi-line or secret changes — it's clearer and keeps diffs reviewable. After editing, the new vars are picked up in new shells; run `mise env` to confirm.

Mise supports dynamic/env-specific config files (`mise.<env>.toml`) and `MISE_ENV` for environment tiers; Sofiane primarily uses the single global file, so reach for these only when explicitly asked.

### Secrets safety

`[env]` contains live credentials (AWS keys, API tokens). Rules:
- Never print raw secret values into the transcript or commit them anywhere.
- When showing config, summarize or redact: `AWS_SECRET_ACCESS_KEY = "<redacted>"`.
- Reference secrets by variable name in scripts/commands so the shell resolves them, e.g. `curl -H "Authorization: Bearer $OPENROUTER_API_KEY" ...`.

## Tasks (make-like commands)

Mise tasks are defined in `mise.toml` under `[tasks]` or in a `.mise/tasks/` directory (one file per task, executable). They run like `make` targets with dependencies, sources/outputs, and per-task env.

```bash
mise tasks ls                 # list available tasks (global + project)
mise tasks ls -g              # only global tasks
mise tasks ls --extended      # all columns (alias, source, deps, description)
mise tasks info <name>        # details: script, deps, env, sources/outputs
mise tasks deps               # dependency tree
mise tasks validate           # lint for common task mistakes
mise tasks edit <name>        # open task source in $EDITOR
mise tasks add <name>         # scaffold a new task

# Run a task (aliases: mise run, mise r)
mise run <task>                # run a task
mise run <task> -- <args>      # pass args to the task
mise r <task>                  # shorthand
mise <task>                    # also works if name doesn't clash with a subcommand
```

Task definition examples (in `mise.toml`):

```toml
[tasks.build]
description = "Build the project"
depends = ["install"]
run = "pnpm build"
env = { NODE_ENV = "production" }
sources = ["src/**/*"]
outputs = ["dist/**"]

[tasks.test]
run = "pnpm test"

[tasks.default]
depends = ["build"]
```

Or as an executable file in `.mise/tasks/build`:

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm build
```

**When the user asks to "run the build", "run tests", or names a target:** check `mise tasks ls` first to discover what's available, then `mise run <task>`. Don't assume a task exists — list first.

## Bootstrap (informational only)

Mise has a `mise bootstrap` flow for one-time environment setup (e.g. fresh machine provisioning). Sofiane has not used it yet; don't reach for it unless explicitly asked. If asked, check `mise bootstrap --help` for current flags before doing anything.

## Plugins (not used)

Sofiane does not use custom mise plugins (only the built-in/backed registries). Don't suggest installing `mise plugins add ...` unless the user explicitly asks.

## Conventions

- **Global vs project:** default to the global config (`~/.config/mise/config.toml` / `-g`) for machine-wide tools and env vars. Use project-local `mise.toml` only when the version/var is project-specific.
- **Pin versions:** prefer explicit versions (`node = "24.4.1"`) over `latest` for reproducibility, except for CLIs that should track releases (`"npm:ntn" = "latest"`).
- **Verify after change:** after installing/updating, run `mise current` or `mise which <tool>` to confirm the active resolution.
- **Discover first:** before running tasks or assuming tool names, run `mise tasks ls` / `mise ls` / `mise info <tool>`.

## Reference

- Docs: https://mise.jdx.dev/
- Dev tools: https://mise.jdx.dev/dev-tools/
- Configuration: https://mise.jdx.dev/configuration.html
- Tasks: https://mise.jdx.dev/tasks/
- Environment variables: https://mise.jdx.dev/environments/
- Help: `mise --help`, `mise <command> --help`
