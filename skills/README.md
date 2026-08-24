# Writing good skills

Skills are compact capsules of durable knowledge for the agent. They should prevent
repeated mistakes without turning every task into a fixed script. Write them for
maintainers: clear enough to use, small enough to stay current, and explicit about
where judgment and safety matter.

## Package layout and metadata

The package manifest (`package.json`) registers `./skills` as the package's skills
root. In this repository, each packaged skill is a directory containing
`SKILL.md`; the directory name is the skill's package path. A top-level
`skills/*.md` form is not declared by this manifest, so do not treat a README or
other standalone Markdown file as a packaged skill unless the package tooling
explicitly documents and enables that form.

Directory skills need YAML frontmatter with `name` and `description`. `compatibility`
and `metadata` are optional fields used by some skills in this repository; add
them when they provide useful installation or maintenance context, not by default.
Keep the frontmatter description aligned with the root README skills table.

## Core principles

### 1. Start from observed failures

Let the agent attempt the task before formalising a skill. Record recurring failure
modes, wasted effort, unsafe assumptions, and context maintainers repeatedly have
to explain. Fix those problems rather than documenting hypothetical edge cases.

A skill should have a reason to exist: frequent, costly, or otherwise important
work where a reusable rule improves outcomes. If the process is rare, unstable, or
already enforced by code, tests, tooling, or existing documentation, improve that
source instead of adding a skill.

### 2. Encode outcomes and judgment

Describe:

- **Goal:** what the task should achieve and what “done” means.
- **Constraints:** safety, privacy, approval, compatibility, and operational limits.
- **Non-obvious context:** facts the agent cannot infer from the repository or the
  current request, such as ownership boundaries, historical pitfalls, or personal
  preferences.

Leave routine implementation choices to the agent. A skill should guide decisions,
not prescribe an exhaustive sequence for every possible situation.

### 3. Keep the always-loaded file short and durable

`SKILL.md` is the entry point. Keep its trigger, purpose, core model, highest-value
constraints, and links to references near the top. Prefer principles that survive
changes to APIs, CLIs, file paths, and team processes. Avoid large command catalogs,
version-specific flags, and repeated explanations unless they encode a real safety
or correctness constraint. There is no arbitrary line limit: size is a prompt-cost
and maintenance tradeoff, not a target. Keep detail when removing it would weaken
correctness or safety.

### 4. Use progressive disclosure

Move detail into focused `references/` files and tell the agent when to read each
one. Good candidates include workflow variants, schemas, heuristics, examples, and
volatile tool syntax. The core skill should make the correct next reference
obvious without loading every detail for every task.

The `weekly-planning` skill is the package's model: its compact entry point keeps
the planning model and approval gates, while Monday planning, Friday retro, Notion
schema, and calendar rules live in separate references. `write-like-me` similarly
separates durable voice rules from message patterns, editing guidance, and language
choices.

### 5. Preserve safety, approval, and verification gates

Shorter does not mean less careful. Keep gates wherever an action can expose data,
spend money, change infrastructure, publish content, or destroy state:

- inspect the target before mutating it;
- ask for explicit approval when intent or impact requires it;
- use least privilege and safe defaults;
- verify the resulting state or user-visible outcome;
- report what changed and any uncertainty.

`tldraw-offline` demonstrates this well with non-destructive editing boundaries,
recipe discovery, and a verification step. `database-query` keeps DSN secrecy,
read-only defaults, explicit confirmation for destructive SQL, and structured output
for reliable automation.

### 6. Separate principles from volatile commands

Explain what a command or option is for only when that knowledge affects a decision.
For current syntax, point to the tool's help or authoritative documentation. Keep
examples minimal and representative; do not make the skill a second CLI manual.

The `exe-dev`, `fly-io`, and `stripe-projects` refactors apply this boundary: they
retain targeting, authentication, deployment, credential, lifecycle, and safety
knowledge while removing long command-level catalogs. The Stripe skill is scoped to
Stripe Projects rather than carrying unrelated classic Stripe CLI material.

This is not a blanket ban on precise procedures. Retain exact, ordered steps when
they are safety-critical, approval-sensitive, or otherwise necessary for reliable
execution; do not remove a needed safeguard merely to shorten a skill.

## Helper scripts and support assets

A skill-local `scripts/` directory contains support assets, not a second skill. Paths
such as `./scripts/create_daily.py` resolve from the skill directory, so invoke or
link them relative to that directory rather than assuming the repository root.
Document each helper's dependencies, configuration, invocation, and important output
or safety behavior in its skill. Prefer a maintained helper over duplicating the
same parsing, API, authentication, or payload logic in prose or ad hoc commands
when the helper is appropriate for the task.

This repository has two examples: `notion/scripts/create_daily.py` is a `uv`
PEP 723 script that builds a validated Daily Work payload and calls `ntn`; it is
documented by the `notion-cli` skill. `whatsapp/scripts/whatsapp.py` is a `uv`
PEP 723 script with an `httpx` dependency that wraps the ruwa HTTP API; its skill
documents its environment variables and command invocation.

## Cross-skill ownership

When mechanics are shared, choose one canonical skill to own them. Link to it and
delegate or defer to its instructions instead of copying competing command syntax,
authentication rules, or schemas. For example, workflow skills should defer Notion
CLI mechanics to [`notion-cli`](./notion/SKILL.md), while keeping only their own
workflow-specific queries and decisions. If two skills need different behavior,
state the boundary explicitly so their instructions cannot conflict.

## Root README synchronization

The package-root [`README.md`](../README.md) is the canonical package overview.
Whenever a skill is added, removed, or meaningfully changed, update its Skills
table in the same change set. Keep the table's trigger description aligned with the
skill's frontmatter `description`, following the repository's `AGENTS.md` guidance.
Do not let a refactor silently leave stale scope or trigger claims in the root
README.

## Make skills living documentation

A skill should include an update loop, either in the core file or an appropriate
reference:

1. Observe a failure, repeated correction, new constraint, or changed preference.
2. Decide whether the lesson is durable and belongs in this skill.
3. Add the smallest clear rule to the correct reference, not a one-off workaround.
4. Remove or revise stale guidance. If the skill already has a `metadata.version`,
   increment it when durable behavior changes; do not require a version field for
   skills that do not use one unless the package adopts an explicit convention.
5. Re-run the skill's review checklist and relevant validation.

Do not encode a single unusual request as a general rule. Prefer evidence from
actual use. For example, `weekly-planning` preserves Monday snapshots and Friday
retrospectives as feedback loops, while `write-like-me` updates voice guidance only
when edits or preferences recur.

## Maintainer review checklist

Before merging a new or changed skill, check:

- **Purpose:** Is the trigger and intended outcome clear? Is this skill needed?
- **Evidence:** Which observed failure or recurring knowledge justifies it?
- **Core file:** Is `SKILL.md` concise, focused, and durable?
- **Judgment:** Does it state goals, constraints, and non-obvious context without
  micromanaging execution?
- **Disclosure:** Are workflow details, examples, schemas, and volatile commands in
  focused references with working links?
- **Safety:** Are secrets, permissions, approval gates, destructive actions, and
  sensible defaults handled explicitly where relevant?
- **Verification:** Does the workflow check the result rather than merely run a
  command?
- **Maintenance:** Is there a clear signal for when to update the skill? Are stale
  or duplicated instructions removed?
- **Package hygiene:** Is `README.md` updated when the skill's trigger or scope
  meaningfully changes? Do Markdown links and frontmatter remain valid?

A strong skill is not the longest one. It is the smallest reusable statement of the
knowledge the agent cannot reliably derive for itself.
