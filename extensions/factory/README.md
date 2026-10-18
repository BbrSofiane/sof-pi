# Factory (`/factory`)

A minimal, reliable software factory. `/factory <task>` launches a bounded, asynchronous software-delivery pipeline and keeps the parent Pi session as the orchestrator.

## Pipeline

```
build workflow    scout → plan → implement (single writer, checked acceptance handoff)
deterministic     human-authored validation commands from .pi/factory.json
review workflow   3 parallel fresh reviewers (correctness, tests, simplicity)
                  → at most ONE fix pass, only on structured "fix" verdicts
deterministic     the same trusted commands, rerun as final verification
```

- Scout, planner, and reviewers run with fresh context and read-only toolsets; the implement and fix workers are the only writers (one at a time).
- Every machine-consumed child result uses a structured output schema, and branching happens **only** on the structured verdict — never on reviewer prose.
- The plan or implement stage stopping with unresolved human-owned decisions pauses the factory (`needs_approval`) instead of proceeding.
- Malformed or missing structured output fails the stage closed (`needs_attention`), never onward as success.
- Writers report through pi-subagents' `structured_output` tool with two channels kept strictly separate: the `value` object carries the full handoff schema (`changedFiles`, `implementationSummary`, `commandsRun` with exit codes, `testsAddedOrUpdated`, `residualRisks`, `workLeftUndone`, `decisionsRequiringApproval`), while the `acceptanceReport` object may contain only pi-subagents' supported fields (`changedFiles`, `testsAddedOrUpdated`, `commandsRun` as `{command, result, summary}`, `residualRisks`, `validationOutput`, `noStagedFiles`, `diffSummary`, `reviewFindings`, `manualNotes`) — unsupported fields such as `workLeftUndone` are rejected there and would fail the worker at the acceptance handoff.
- The fix loop is capped at exactly one pass by construction. Failed deterministic checks also stop the factory — no automated retry of side-effectful work.
- **No commit, push, merge, publish, deploy, or release is ever performed.**

Execution, lifecycle, missions, artifacts, status, resume, and Herdr integration are owned by the installed [pi-subagents](https://github.com/nicobailon/pi-subagents) package; this extension only validates the baseline, generates the two fixed workflows, correlates RPC replies, and runs the deterministic checks.

## Commands

| Command | Purpose |
| --- | --- |
| `/factory <task>` | Validate trust/baseline/config, then launch the build workflow asynchronously. |
| `/factory-status` | Show the latest run: swimlane waterfall, live workflow state, checks, reviewer disposition, decisions, errors. |

Baseline requirements: trusted project, inside a git work tree, clean working tree (unless `allowDirtyBaseline` is enabled), and `.pi/factory.json` present and valid.

## Configuration — `.pi/factory.json`

Human-authored project configuration. It is the **only** source of validation commands the factory will ever execute; commands proposed by model output are never run. Unknown fields and malformed values fail closed.

```json
{
  "version": 1,
  "validationCommands": [
    { "name": "test", "command": "pnpm test" },
    { "name": "typecheck", "command": "pnpm run typecheck" }
  ],
  "timeoutMs": 1800000,
  "commandTimeoutMs": 300000,
  "maxConcurrency": 4,
  "allowDirtyBaseline": false
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | required | Schema version, exactly `1`. |
| `validationCommands` | `{name, command}[]` (1–8) | required | Trusted validation commands, run in order between workflow phases and again as final verification. Single-line, ≤ 4096 chars each. |
| `timeoutMs` | integer 60 000–86 400 000 | `1800000` | Workflow deadline for each factory workflow launch. |
| `commandTimeoutMs` | integer 1 000–3 600 000 | `300000` | Per-command timeout for validation checks. |
| `maxConcurrency` | integer 1–16 | `4` | Upper bound passed to pi-subagents as the workflow's global concurrency limit. |
| `allowDirtyBaseline` | boolean | `false` | Allow launching from a dirty git baseline. |

Never place prompts, credentials, secrets, or shell fragments from model output in this file.

## Deliberate deviation: checks run in the extension, not via `runs.host`

pi-subagents 0.61 grants `runs.host` authority only to named workflow resources (currently `npm test` / `npm run typecheck`); inline workflow scripts launched through the public execution boundary (`script` RPC param) cannot use it. The factory therefore runs the trusted validation commands **in this extension process**, between the two workflows, using strictly-validated human-authored configuration with bounded timeouts and output capture. The security property is preserved: model-proposed commands are never executed, and the commands come only from `.pi/factory.json`.

If a future pi-subagents version exposes a user/project workflow-resource registry, the check phase can migrate to `runs.host` without changing the pipeline shape.

## Live waterfall UX

Instead of a flat text dump, a run is rendered as a **swimlane waterfall**: one bar per pipeline lane (scout, plan, implement, checks, review ×3, fix, final checks) on a shared time axis, colored by state (accent = running, success = done, error = failed, warning = paused).

- A widget above the editor shows the chart for the latest run and updates live: the active lane grows toward "now" and the current sub-stage appears in the status bar (`factory: build · implement`).
- Sub-stage spans come from a 3s poll of the pi-subagents `status` RPC (`Workflow child <key>: … <status>` lines). Successful children report pi-subagents' `completed` token (`complete` and `stopped` stay accepted for compatibility); the other `WorkflowNodeStatus` tokens map to safe lane states — `rejected` closes the lane as failed, `paused`/`detached`/`partial` close it as attention. Coarse phase spans (build/checks/review/final) are always recorded exactly at phase transitions, so the chart degrades gracefully when polling is unavailable; fine sub-spans replace their coarse span at render time.
- Spans are stored as milliseconds relative to the run start in the session entry, so the waterfall survives restarts and branch restores (fail-closed validation rejects malformed spans).
- When a run finishes, the widget keeps the final chart and the completion notification stays short (task, verdict, final checks, changed files); `/factory-status` renders the full waterfall plus all details.
- On session resume, if the restored phase is still active, the extension queries the run's real status **once** (the `subagent:async-complete` event is per-process and can be lost across a restart). A run already in a terminal state (`complete`/`failed`/`partial`/`stopped`/`rejected`/`paused`) is closed out with a clear error pointing at `/factory-status` and a rerun of `/factory` — the lost completion payload is never faked. Runs still in progress just keep the normal poll.
- Persisted failure diagnostics keep the fullest useful payload text (summary plus any `error`/`errorTail`/`message` fields), bounded at 2000 characters so the actual acceptance-rejection reason survives the state round-trip.
- Layout and status parsing live in `src/waterfall.ts` as pure, unit-tested functions; the widget component (`WaterfallWidget`) only reads the shared model and applies theme colors.

## Tests

```bash
pnpm test   # or: node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/factory/*.test.ts
```

Covers: strict config validation, safe task encoding (quotes, Markdown fences, shell-like text, multiline prompts), sandboxed execution of the generated workflows (stage order, structured-verdict-only branching, bounded fix pass, fail-closed malformed output), deterministic check execution, RPC request/reply correlation and timeouts, waterfall layout/round-trip (`waterfall.test.ts`), and offline validation of both generated scripts against the **real** installed `validateWorkflowScript` plus a read-only smoke test against the **real** RPC bridge. The validator/RPC tests locate the installed package at `~/.pi/agent/npm/node_modules/pi-subagents` (override with `PI_SUBAGENTS_PATH`).
