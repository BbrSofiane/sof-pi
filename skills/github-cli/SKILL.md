---
name: github-cli
description: Use this skill when the user wants to interact with GitHub via the `gh` CLI — cloning repositories, inspecting dependencies or third-party projects, checking GitHub Actions pipeline logs or statuses, viewing workflow runs, and ad-hoc GitHub API calls. Triggers on tasks like "clone this repo", "check the pipeline", "view CI logs", "what's the status of the workflow", "find a dependency repo", or "inspect a GitHub project".
compatibility: Requires the `gh` CLI installed, on PATH, and authenticated. Verify with `gh auth status`; run `gh auth login` if not logged in.
---

# GitHub CLI (`gh`) Skill

Use this skill to interact with GitHub from the terminal using the `gh` CLI. Covers cloning repos for inspection/learning, checking GitHub Actions pipeline logs and statuses, and ad-hoc GitHub API/GraphQL calls.

## Setup

Ensure `gh` is installed and authenticated before running any commands.

```bash
gh --version         # current gh version
gh auth status       # show logged-in account, active status, token scopes
gh auth login        # interactive login flow (browser/device code)
gh auth refresh      # refresh token / request additional scopes
```

Auth state is stored in the OS keyring. `gh` also configures `git` to use the authenticated account for HTTPS pushes (`gh auth setup-git`).

## Global conventions

These flags apply to most commands and make `gh` scriptable/agent-safe:

| Flag | Purpose |
|---|---|
| `-R, --repo [HOST/]OWNER/REPO` | Run a command against a different repo than the cwd. Use instead of `cd`-ing into a clone. |
| `--json fields` | Output JSON with the specified fields (best for parsing). |
| `-q, --jq expression` | Filter JSON output with a jq expression. |
| `-t, --template string` | Format JSON output with a Go template (see `gh help formatting`). |
| `--web` / `-w` | Open the relevant page in the browser instead of printing. |
| `--help` | Show help for a command. |

**Automation pattern:** prefer `--json` (optionally with `-q`) for parsing, plain output for grepping. When targeting a repo you don't have checked out locally, use `-R owner/repo` instead of cloning just to inspect.

**Discovery:** every command supports `--help`. For a full reference run `gh help` or `gh help reference`.

## Cloning repositories (inspecting dependencies / learning)

`gh repo clone` resolves `OWNER/REPO` (or a full URL, or a bare repo name = your own account), uses your configured git protocol, and automatically wires up an `upstream` remote when the repo is a fork.

```bash
# Clone a dependency / third-party project to inspect
gh repo clone cli/cli                       # OWNER/REPO -> ./cli
gh repo clone cli/cli workspace/cli         # clone into a specific directory
gh repo clone https://github.com/cli/cli    # explicit URL (overrides git_protocol config)
gh repo clone git@github.com:cli/cli.git    # SSH URL

# Shallow / partial clones (faster for read-only inspection) — pass git flags after --
gh repo clone cli/cli -- --depth=1
gh repo clone cli/cli -- --depth=1 --filter=blob:none   # blobless clone

# When the repo is a fork, the parent is added as `upstream` (configurable)
gh repo clone octocat/Hello-World --upstream-remote-name=octocat
```

When you only want to *read* a repo without cloning, prefer `gh repo view` / `gh repo view --web` / `gh api` instead of cloning.

```bash
gh repo view cli/cli                    # README + metadata, no clone
gh repo view cli/cli --web             # open in browser
gh repo view cli/cli --json name,description,defaultBranchRef
```

## Finding repositories to inspect

```bash
# Search across GitHub (repos, code, issues, prs, commits)
gh search repos "cli github" --language go --sort stars --limit 20
gh search repos --owner cli            # repos owned by a user/org
gh search code "fn main" --repo cli/cli
gh search issues "panic on nil" --repo cli/cli --state open

# List repos you own / an org owns
gh repo list                           # your repos
gh repo list cli --limit 50           # an org's repos
gh repo list --fork --source          # filter forks/sources
```

## GitHub Actions: pipeline statuses and logs

Two command groups: `gh run` (individual workflow runs) and `gh workflow` (workflow definitions).

### Listing and viewing runs

```bash
gh run list                            # recent runs in the cwd repo
gh run list --limit 20                 # more runs
gh run list -R owner/repo              # runs in a different repo (no clone needed)
gh run list --workflow build.yml       # filter by workflow file
gh run list --branch main --status failure
gh run list --json databaseId,status,conclusion,headBranch,workflowName --limit 10

gh run view                            # interactively pick a run to view
gh run view 12345                      # view a specific run (summary + jobs)
gh run view 12345 -v                   # verbose: show job steps
gh run view 12345 -R owner/repo        # view a run in another repo
```

### Reading logs

```bash
gh run view 12345 --log                # full log for the run (all jobs)
gh run view 12345 --log-failed         # only failed steps (best for debugging CI)
gh run view --job 67890 --log          # log for a specific job
gh run view 12345 --web                # open the run in the browser
```

### Watching, rerunning, cancelling, downloading artifacts

```bash
gh run watch                          # interactively watch the latest run until it finishes
gh run watch 12345                    # watch a specific run (exit non-zero if it fails with --exit-status)
gh run watch 12345 --exit-status

gh run rerun 12345                    # rerun all failed jobs (or --failed)
gh run rerun 12345 --failed
gh run cancel 12345
gh run delete 12345
gh run download 12345                 # download artifacts to ./ by default
gh run download 12345 -D ./artifacts --name build-output
```

### Workflows

```bash
gh run list --workflow build.yml
gh workflow list                      # workflows defined in the repo
gh workflow view build.yml
gh workflow view build.yml --web
gh workflow run build.yml             # trigger a workflow_dispatch
gh workflow run build.yml --ref main -f environment=staging
gh workflow enable / disable build.yml
```

`gh run list` / `gh run view` accept `-R owner/repo`, so you can check pipeline status of a dependency or upstream repo **without cloning it** — useful for "is upstream CI green?" checks.

## Cross-cutting tips

- **No-clone inspection:** for read-only checks (status, README, releases, CI state), use `-R owner/repo` with `gh run list` / `gh repo view` / `gh release list` rather than cloning.
- **JSON + jq:** `--json` + `-q '.[] | .name'` is the most reliable way to extract specific fields.
- **Pipeline debugging flow:** `gh run list --status failure` → pick run id → `gh run view <id> --log-failed` to jump straight to failing step logs.
- **Branch context:** most `gh run` commands support `--branch`, `--event`, `--status`, `--workflow` filters.
- **Default repo:** `gh repo set-default` marks a repo as default for the cwd, so `gh pr` / `gh issue` / `gh run` resolve without `-R`. Useful when working inside a clone.

## Other commonly used commands (summary)

- **`gh pr`** — list/view/checkout/diff/merge/review PRs (`gh pr checkout 123`, `gh pr view --web`, `gh pr diff`, `gh pr checks`).
- **`gh issue`** — list/view/create/close issues.
- **`gh release`** — list/view/create/download releases (`gh release download`).
- **`gh gist`** — create/list/view gists (paste snippets).
- **`gh browse`** — open the current repo / a PR / an issue / a file in the browser.
- **`gh status`** — overview of relevant issues/PRs/notifications across your repos.
- **`gh api`** — make an authenticated REST v3 or GraphQL v4 request directly (escape hatch for anything not exposed by a subcommand).
- **`gh search`** — search repos, code, issues, PRs, commits across all of GitHub.

### `gh api` escape hatch

```bash
gh api repos/cli/cli                       # GET a REST endpoint
gh api repos/cli/cli/releases/latest --jq .tag_name
gh api graphql -f query='query { viewer { login } }'
gh api repos/cli/cli/contents/README.md    # fetch a file's metadata/content
gh api -X POST repos/cli/cli/labels -f name=foo -f color=ff0000
```

Placeholders `{owner}`, `{repo}`, `{branch}` are filled from the cwd repo (or `GH_REPO`). Prefer the dedicated subcommands when they exist; reach for `gh api` only for endpoints `gh` doesn't wrap.

## Reference

- Built-in help: `gh --help`, `gh <command> --help`, or `gh help <command>` for prose.
- Full reference: `gh help reference`.
- Formatting/JSON: `gh help formatting`.
- Exit codes: `gh help exit-codes`.
- Manual: https://cli.github.com/manual
