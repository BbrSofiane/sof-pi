# Friday retro workflow

Read this after the [weekly-planning entry point](../SKILL.md) identifies a Friday retro request. Read [`notion-schema.md`](notion-schema.md) for fields and the local-note template. Read [`calendar-and-daily-work.md`](calendar-and-daily-work.md) for Daily Work concepts and Area values.

## Triggers

Use this workflow for: `weekly retro`, `Friday retro`, `let's review the week`, `review the week`, or `weekly review`.

Every weekly retro includes a Wheel of Life reflection. Use the exact areas and rules below unless Sofiane explicitly changes the model.

## Phase 1 — Gather (silent)

1. **Re-fetch in-progress Projects** with the same filter as Monday (`Status = 🔥In Progress` AND `Owner = me`). Capture today's Completion % per project.

2. **Find this week's Monday snapshot.** Query Daily Work for pages where `Name` starts with `Prepare for the week —` and `Date` is the most recent Monday. Read the page body, locate the `<!-- weekly-planning-snapshot v1 ... -->` block, and parse it. If no snapshot is found, proceed without a diff and tell Sofiane in Phase 2: “no Monday snapshot — showing today's state only”.

3. **Diff Completion %** per project: Monday → today, with delta in points. Also flag any project that appeared on Monday but is now `✅Done`, `⏸ Paused`, or `❌ Canceled`.

4. **For each Monday objective**, look up the linked Task URL and report its current Status. Categorise it as:
   - **shipped** — `✅Done`
   - **partial** — `🔥In Progress`
   - **dropped** — still `❄️Not started` or unchanged

5. **Pull this week's Daily Work** (Date in Mon–Fri of this week). Compute:
   - Completion rate (Done / total)
   - Per-Area breakdown
   - Eisenhower split of completed items (`🔥`/`🔥` vs. `❄️`/`❄️` vs. mixed)
   - **Carryover candidates:** every entry where Status ≠ `✅Done`. The default policy is to carry over everything; do not filter candidates at this stage.

## Phase 2 — Show the retro report

Before asking anything, render:

```text
## Weekly Retro — Week of <Mon DD MMM>

### Objectives — what shipped
| Objective | Linked Task | Status | Outcome (shipped/partial/dropped) |

### Quarterly anchor — Project progress this week
| Project | Mon % | Today % | Δ | Tasks closed |
(include ALL in-progress projects, not just ones tied to objectives, to surface passive drift)

### Daily Work execution
- N entries, M ✅Done (X%)
- Top Areas: <breakdown>
- Eisenhower: <count> 🔥/🔥 closed, <count> ❄️/❄️ closed
- Carryover: <count> entries not Done

### Friday question from Monday
"<question from snapshot.friday_question>"
```

If there was no Monday snapshot, say so in the report or immediately alongside it: **no Monday snapshot — showing today's state only**. If the snapshot recorded projects or objectives that are no longer in progress, keep those rows in the comparison so completion or status drift is visible.

## Phase 3 — Ask (one at a time)

Ask each question in sequence and wait for the answer before asking the next:

**a.** Answer the Friday question from Monday. Record the answer verbatim; do not follow up unless it is ambiguous.

**b.** For each objective that came in `partial` or `dropped`, ask: `Objective <Y> ended <status>. What blocked it — calendar, dependency, scope, motivation?`

**c.** Only if Daily Work shows a notable Area mismatch versus intent (for example, intended Faculty-heavy but `🐝 Life Admin` is greater than 25%), ask: `<Area X> took <%> of the week. Intentional or drift?`

**d.** Ask: `One thing that worked this week worth keeping?`

**e.** Ask: `One thing that didn't work worth changing next week?`

**f.** Ask for the Wheel of Life scores/notes with one structured prompt rather than eight separate questions:

> Fill any Wheel of Life scores/notes you want captured this week: Partner-time, Family & friends, Mental wellbeing, Health & fitness, Team, Business, Finances, Career. Scores can be rough or blank.

**Do not ask a carryover question.** The policy is to carry every non-Done Daily Work entry over by default; only an explicit instruction names an exception.

## Wheel of Life

Use these exact areas:

| Area | Score (1-10) | Notes |
|---|---:|---|
| Partner-time |  |  |
| Family & friends |  |  |
| Mental wellbeing |  |  |
| Health & fitness |  |  |
| Team |  |  |
| Business |  |  |
| Finances |  |  |
| Career |  |  |

Rules:

- Ask for scores/notes during Phase 3 before drafting the Weekly Review.
- Scores are optional and notes are optional. If Sofiane gives narrative only, map it to the relevant area notes and leave unknown scores blank.
- Preserve tradeoffs without moralising. For example, time with a partner can be a positive Partner-time note even if it displaced side-project work.
- Include the Wheel of Life section in both the Notion Weekly Review page and the local Tolaria weekly plan/retro note.

## Approval and write gate

After the report and Phase 3 questions, show the proposed retro content or summary and ask for explicit approval before writing. Do not carry over Daily Work rows or update the local note while gathering or asking questions. Only proceed with the writes after Sofiane approves.

## Phase 4 — Write (after approval)

1. **Carry over every non-Done Daily Work entry from this week.** For each:
   - Update `Date` to next Monday's date.
   - Leave Status, Importance, Urgency, Area, and Name unchanged.
   - Do **not** duplicate the row; update it in place.
   - This is the default policy. Only skip an entry if Sofiane explicitly named it during the conversation (for example, “drop the email triage one”).

2. **Return a summary** including any project that drifted to `✅Done`, `⏸ Paused`, or `❌ Canceled` this week, so Sofiane can decide whether a new project should replace it next Monday.

3. **Update the local Weekly Plan and Retro note:**
   - Find `weekly-plan-and-retro-<Mon YYYY-MM-DD>.md` in `$TOLARIA_VAULT_DIR`.
   - If it exists, preserve `Initial plan` and replace or fill the retro sections using the approved retro content.
   - If it does not exist, create it from the template in [`notion-schema.md`](notion-schema.md), reconstructing `Initial plan` from the Monday snapshot when possible, then fill the retro sections.
   - Include the Wheel of Life table and its captured notes/scores.
   - Return the local file path in the final summary.

The retro sections to fill are `What shipped`, `Partial or carried over`, `Reflection`, `Wheel of Life`, `What worked`, `What to change`, and `Going into next week`. Preserve the initial plan when it exists; the local note is a concise reflective journal, not a full Daily Work dump.
