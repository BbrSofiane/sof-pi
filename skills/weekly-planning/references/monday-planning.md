# Monday planning workflow

Read this after the [weekly-planning entry point](../SKILL.md) identifies a Monday planning request. Read [`notion-schema.md`](notion-schema.md) for fields and [`calendar-and-daily-work.md`](calendar-and-daily-work.md) for calendar and Daily Work heuristics.

## Phase 1 — Gather (silent, then calendar gate)

The first message, before reading data, must be:

> Share a screenshot of your Faculty Google Calendar for the next 7 days (Mon–Sun). I'll wait.

Wait for the screenshot, parse all colour-coded events as in scope, echo per-day event counts, and wait for confirmation as described in `calendar-and-daily-work.md`.

Then use the Notion CLI (following the existing `notion-cli` skill) to:

1. Fetch Projects, filtering `Status = "🔥In Progress"` and Owner contains Sofiane. Sort by Priority descending, then `Dates.end` ascending. Capture name, URL, priority, end date, Completion %, Summary, and Blocked By.
2. Follow each Project's Tasks relation. Categorise Tasks as completed in the last 7 days (✅Done with recent edit), currently 🔥In Progress, overdue (Due < today and not ✅Done/📂 Archived), or due in the next 7 days.
3. Pull the last 7 days of Daily Work. Compute completion rate, top Areas, and open `🔥Important` + `🔥 Urgent` items.
4. Check UK bank holidays in the planning week and calculate actual focus capacity.

Show this situation report before planning questions:

```text
## Quarterly anchor — In-Progress Projects
| Project | Priority | End | Completion | Open | Overdue | Blocked? |
...

## Last 7 days
- Tasks closed: <list grouped by Project>
- Slipped: <Tasks now overdue or pushed>
- Daily Work: X% completion, top Area: Y
- Eisenhower: <N> 🔥/🔥 still open

## Next 7 days — calendar load
- Bank holidays: <list, or "none">
- Mon: <hrs> (🍃<n> ⚡<n> 🎯<n>), Tue: <hrs> (...), ...
- Lightest: <day> | Heaviest: <day>
- Capacity calc: <working hrs> − <meeting hrs> − <bank holiday hrs> = <focus hrs>
- Recommendation: <3 objectives if focus > 40% of working hrs, else 2>
```

## Phase 2 — Ask (one question at a time)

Ask these in sequence, waiting after every question:

1. For the highest-priority project: `Project <X> is at <Y>% with <N> days left and <M> overdue Tasks. Still the #1 priority this week, or has something shifted?`
2. `Calendar load: <X> meeting hours, <Z> hrs lost to bank holidays, ~<Y> hrs of focus time. Recommendation: <3 or 2> objectives. Agree, or override?`
3. For each objective:
   - Which Project does it belong to?
   - Which Tasks move it forward this week? List as many as needed, mixing execution and scope/plan Tasks. For missing Tasks, propose title, due date, and mode; get approval before creating them.
   - What is the Definition of Done this week?
4. `Side-project slot — anything for Scrub AI / Dicey Tech / Personal Development this week, or Faculty-only?`
5. `Founder-era habits to drop — anything from last week's Daily Work that shouldn't recur (e.g. daily email triage)?`

## Phase 3 — Draft (do not write)

Show, in order:

1. **Weekly objectives:** title, linked Project URL, all linked Task URLs with `exec`/`scope-plan` mode tags, Definition of Done, and recommended days.
2. **Daily Work plan, Mon–Fri:** screenshot meetings, objective to-dos, and committed versus available hours per day.
3. **Risks:** the most likely objective to slip and whether the cause is calendar load, a blocker, or an overdue parent Task.
4. **Friday retro question:** one question.

Run the removal pass from [`calendar-and-daily-work.md`](calendar-and-daily-work.md) before asking for approval.

## Phase 4 — Write (only after explicit approval)

Ask: **Approve to write to Notion? (yes / edits)**

On approval, in order:

1. Create only the new high-level Tasks Sofiane approved: `❄️Not started`, selected priority/due date, parent Project relation, and `💻 Dev` or `🌱 Shape up` mode tag.
2. Create Mon–Fri Daily Work rows for retained meetings and objective-related to-dos using the schema and heuristics in the calendar reference. Set icons on every row. Skip meeting rows on UK bank holidays; add to-dos there only if Sofiane explicitly chose to work.
3. Create/update `$TOLARIA_VAULT_DIR/weekly-plan-and-retro-<Mon YYYY-MM-DD>.md`, populating only Initial plan → Objectives and Friday question, leaving retro placeholders. Return the path.

## Monday snapshot

The `Prepare for the week` Daily Work page must retain a parseable block:

`<!-- weekly-planning-snapshot v1 ... -->`

Include the approved objectives, linked Task URLs, Project identifiers/completion, Friday question, and enough calendar/capacity context to support Friday's diff. Use the template and fields in [`notion-schema.md`](notion-schema.md). If the implementation changes the snapshot format, increment its version and update the Friday reference.
