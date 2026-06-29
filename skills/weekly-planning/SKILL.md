---
name: weekly-planning
description: "Run Sofiane's Monday weekly planning or Friday weekly retro. Use for 'plan the week', 'weekly planning', 'prepare for the week', 'weekly retro', 'Friday retro', or 'weekly review'. Reads Notion Projects, Tasks, and Daily Work, uses a calendar screenshot for planning, sets 3 project-anchored objectives, writes Notion Daily Work plans/reviews, maintains the local Tolaria weekly plan/retro note, and includes Wheel of Life reflection in retros."
metadata:
  author: sofiane
  version: '1.5'
---

# Weekly Planning

## Environment variables

This skill reads Notion IDs and the local vault path from the environment so no secrets are baked into the repo. Set these in your shell env (e.g. `~/.config/mise/config.toml`):

| Variable | Purpose |
|---|---|
| `NOTION_WORKSPACE` | Notion workspace handle |
| `NOTION_PROJECTS_DB_ID` | Projects database id |
| `NOTION_PROJECTS_DATA_SOURCE` | Projects data source id |
| `NOTION_TASKS_DB_ID` | Tasks database id |
| `NOTION_TASKS_DATA_SOURCE` | Tasks data source id |
| `NOTION_DAILY_WORK_DB_ID` | Daily Work database id |
| `NOTION_DAILY_WORK_DATA_SOURCE` | Daily Work data source id |
| `NOTION_PREPARE_FOR_WEEK_TEMPLATE_ID` | `Prepare for the week` template page id |
| `TOLARIA_VAULT_DIR` | Local Tolaria/Obsidian folder where weekly notes live |

Resolve `$VAR` references below from the environment before calling the Notion API.

## When to Use This Skill

Run this on Monday mornings (or whenever Sofiane asks to plan the week). The skill drives a conversation that:

1. Reads in-progress Projects + their linked Tasks from Notion
2. Reads last 7 days of Daily Work to assess execution
3. Asks for a Google Calendar screenshot (the agent has no access to his work calendar)
4. Asks targeted, sequenced questions to set **3 weekly objectives**, each anchored to a Project and backed by one or more Tasks (a mix of execution + scope/plan work — see "How Sofiane's work splits" below)
5. Writes a "Prepare for the week" page in Daily Work and Mon–Fri Daily Work entries (meetings + objective-related to-dos)
6. Writes/updates the matching local markdown note in the Tolaria "Getting Started" folder for lightweight journaling and Friday retro continuity

## Sofiane's Context

- Tech lead at Faculty AI (Frontier team), based in London.
- Process: 3 weekly objectives + Daily Work entries that include key meetings from the work calendar.
- Quarterly anchor is **not** OKRs — it's the in-progress rows of the Projects database.
- Tone: direct, no motivational filler.

### How Sofiane's work splits

As tech lead, his time on any project is split between two modes:

- **Execution** — implementation, hands-on dev, validation, debugging.
- **Scope/Plan** — shape-ups, design docs, scoping future work, breaking it down into Tasks for the team.

A single weekly objective will typically need **multiple sequential Tasks** — often a mix of both modes (e.g. one in-progress execution Task + two shape-up Tasks for next quarter's work). Don't try to collapse an objective to a single "anchor task". Always think in terms of: *which set of Tasks moves this Project forward this week?*

## The Three Notion Databases

### 1. Projects — quarterly anchor
- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_PROJECTS_DB_ID`
- Data source: `$NOTION_PROJECTS_DATA_SOURCE`
- Statuses: 🧠 Planning / 🔥In Progress / ⏸ Paused / 🛑 Backlog / ✅Done / ❌ Canceled
- Properties: Project name, Owner, Status, Priority (Low/Med/High), Dates (start/end), Summary
- Rollup: `Completion` (% of linked Tasks Done)
- Relations: `Tasks` → Tasks DB, `Blocked By` / `Is Blocking` → Projects DB
- **Focus on Status = "🔥In Progress" AND Owner = me**

### 2. Tasks — high-level, project-linked
- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_TASKS_DB_ID`
- Data source: `$NOTION_TASKS_DATA_SOURCE`
- Statuses: ❄️Not started / 🔥In Progress / ✅Done / 📂 Archived
- Properties: Task name, Status, Priority, Due, Tags, Summary, Assignee
- Relations: `Project` → Projects, `Parent-task`/`Sub-tasks` → Tasks
- **This is the unit of weekly progress.** Every weekly objective must link to a Task here. Closing Tasks here advances `Project.Completion` automatically.

### 3. 🐝 Daily Work — day-to-day execution
- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_DAILY_WORK_DB_ID`
- Data source: `$NOTION_DAILY_WORK_DATA_SOURCE`
- Statuses: ❄️Not started / 🔥In Progress / ✅Done
- Properties: Name, Date, Importance (🔥Important / ❄️Not Important), Urgency (🔥 Urgent / ❄️Not Urgent) — Eisenhower matrix
- Area (multi-select): ⚗️ Faculty AI, 🐝 Life Admin, 🐤 Scrub AI, 🎲 Dicey Tech, 🗞 Emerging Times, 🧠 Strategy, 🔗 Network, 🎉 Customer Ops, 💰 Business Developement, 💻 Product, 🛠 Tools, 🎙️ Content, 👨🏿‍💻 Personal Development, 💼 Admin, 🐙 Kraken, 🟧 GlobalLogic
- **Page icon = expected time signal.** Every Daily Work entry created must have one of these icons set:
  - 🍃 **Quick win** — < 30 min (e.g. standup, daily connect, quick check-in)
  - ⚡ **Medium** — 30 min to 1.5 h (e.g. PR review, 1:1, sprint retro, refinement)
  - 🎯 **Deep** — > 1.5 h (focus blocks, workshops, longer planning meetings, deep-work to-dos)
- **No relations to Projects/Tasks** — deliberately. This is execution noise.
- Templates: `Prepare for the week` (Notion page id `$NOTION_PREPARE_FOR_WEEK_TEMPLATE_ID`), `Weekly Review`

## Local Weekly Plan and Retro note

Maintain a local markdown note in Sofiane's Tolaria vault:

- Folder: `$TOLARIA_VAULT_DIR`
- File name: `weekly-plan-and-retro-<Mon YYYY-MM-DD>.md`
- Title: `# Weekly Plan and Retro — Week of <Mon YYYY-MM-DD>`
- Frontmatter:

```markdown
---
type: Note
---
```

Use the previous note as the template when available, especially `weekly-plan-and-retro-2026-05-04.md`. The structure is:

```markdown
## Initial plan

### Objectives

- **<Objective title>**
  - <Task / work item>
  - <Task / work item>

### Friday question

<Friday retro question>

## Retro

### What shipped

- 

### Partial or carried over

- 

## Reflection

## Wheel of Life

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

## What worked

## What to change

- 

## Going into next week

- **Carryover** — 
- **Risk to watch** — 
```

Rules:

- On Monday planning, fill only the `Initial plan` and `Friday question` sections; leave retro sections as placeholders.
- On Friday retro, fill `What shipped`, `Partial or carried over`, `Reflection`, `Wheel of Life`, `What worked`, `What to change`, and `Going into next week` from the retro conversation.
- Keep the note concise and reflective. It is a lightweight journal, not a full task dump. List objective-level work and important carryovers, not every Daily Work row.

## Phase 1 — Gather (silent, no questions yet)

Use the Notion CLI.

1. **Pull in-progress Projects.** Fetch the Projects DB. Filter rows where `Status = "🔥In Progress"` AND `Owner` contains Sofiane. Sort: Priority desc, then Dates.end asc. For each, capture: name, URL, Priority, end date, Completion %, Summary, Blocked By.

2. **Pull each Project's linked Tasks.** Follow the `Tasks` relation. Categorise:
   - Completed in last 7 days (Status = ✅Done, recent edit)
   - Currently 🔥In Progress
   - Overdue (Due < today AND Status not in [✅Done, 📂 Archived])
   - Due in next 7 days

3. **Pull last 7 days of Daily Work.** Compute completion rate (Done / total), top Areas, and any 🔥Important + 🔥 Urgent items still not Done.

4. **Ask for a calendar screenshot** — see Phase 2 step 0. Wait for it. Extract per-day meetings (title, start/end), total meeting hours per day, days with <2hr free, recurring 1:1s and Frontier rituals.

   **Screenshot parsing rules:**
   - Treat **all colour-coded events as in-scope by default** (Faculty purple, personal, etc.). Never drop events by colour unless Sofiane gives an unambiguous explicit instruction.
   - After parsing, before showing the situation report, echo back a one-line per-day count: *"Mon: N events, Tue: N events, …"* and ask Sofiane to confirm. Only proceed once confirmed.
   - If he says the parse is wrong, ask for a sharper screenshot rather than guessing.

5. **Check for UK bank holidays** in the planning week (Mon–Fri). If any day falls on a UK bank holiday, treat that day as 0 working hours, surface it explicitly in the situation report, and factor it into the objective-count decision (Phase 2b).

6. **Show the situation report** before asking any planning questions:

   ```
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

   When estimating per-day meeting hours, use the time-icon convention: 🍃 = 0.25 h, ⚡ = 1 h, 🎯 = 2 h (or use the actual screenshot duration if visible). The icon mix per day is a useful signal — a day stacked with 🎯 means almost no focus time even if the raw hour count looks moderate.

## Phase 2 — Ask (one question at a time, wait for each answer)

**0.** First message of the conversation, before reading any data, request the screenshot:

> "Share a screenshot of your Faculty Google Calendar for the next 7 days (Mon–Sun). I'll wait."

**a.** "Project `<X>` is at `<Y>%` with `<N>` days left and `<M>` overdue Tasks. Still the #1 priority this week, or has something shifted?"

**b.** "Calendar load: `<X>` meeting hours, `<Z>` hrs lost to bank holidays, ~`<Y>` hrs of focus time. Recommendation: `<3 or 2>` objectives. Agree, or override?"

**c.** For each chosen objective:
   - "Which Project does this belong to?"
   - "Which Tasks in that Project move it forward this week? List as many as needed — typically a mix of execution Tasks (in-progress dev work) and scope/plan Tasks (shape-ups, scoping future work). For any that don't yet exist, propose Task title + Due date + mode (execution / scope-plan) — I'll approve before you create them."
   - "Definition of Done for this week?"

**d.** "Side-project slot — anything for Scrub AI / Dicey Tech / Personal Development this week, or Faculty-only?"

**e.** "Founder-era habits to drop — anything from last week's Daily Work that shouldn't recur (e.g. daily email triage)?"

## Phase 3 — Output the draft (do not write yet)

Show, in order:

1. **Weekly objectives** — each row: Title | linked Project URL | linked Tasks (list of URLs, with mode tag exec/scope-plan) | DoD | recommended day(s)
2. **Daily Work plan, Mon–Fri.** Per day:
   - Meeting rows from screenshot
   - One or more objective-related to-dos
   - Total committed hours vs. available hours
3. **Risks** — which objective is most likely to slip and why (calendar load, blocker, overdue parent Task)
4. **Friday retro question** — a single question to ask at end of week

### Phase 3.5 — Removal pass (before approval)

After showing the draft, explicitly ask:

> "Anything to drop or downgrade in the meeting list before I write? (Daily Connects, optional plenaries, social/'time' blocks, duplicate option-1/option-2 invites.)"

Proactively flag candidates whose title contains any of: `Daily Connect`, `(option 1)`, `(option 2)`, `TIME`, `Roundtable`, `DEAL`, social/coffee patterns. Do **not** auto-drop — surface them and let Sofiane decide. Iterate until he says "that's it" / "nothing else" / approves.

## Phase 4 — Write to Notion (only after explicit approval)

Ask: **"Approve to write to Notion? (yes / edits)"**

On approval, in this order:

1. **New high-level Tasks** (only those Sofiane greenlit in Phase 2c):
   - Create in Tasks DB with: Task name, Status = `❄️Not started`, Priority, Due, `Project` relation set to the parent Project, Tags inferred from Project context + mode (`💻 Dev` for execution, `🌱 Shape up` for scope/plan).

2. **Mon–Fri Daily Work entries:**
   - One row per meeting: Name = meeting title, Date = day, Area = inferred from context (default `⚗️ Faculty AI`), Status = `❄️Not started`, **page icon set per the time-icon heuristic below**. Importance/Urgency heuristic below.
   - One row per objective-related to-do: Name = task name, Date = recommended day, Area = matched to parent Project, Importance = `🔥Important`, Urgency = `🔥 Urgent` if Due ≤ this week else `❄️Not Urgent`, Status = `❄️Not started`, **page icon set per the time-icon heuristic below**.
   - For days that are UK bank holidays, skip meeting rows entirely and only place to-dos if Sofiane explicitly chose to work that day.

3. **Create/update the local Weekly Plan and Retro note** in `$TOLARIA_VAULT_DIR`:
   - File name = `weekly-plan-and-retro-<Mon YYYY-MM-DD>.md`.
   - Use the template in "Local Weekly Plan and Retro note".
   - Populate `Initial plan > Objectives` from the final approved objectives and linked Tasks/work items.
   - Populate `Friday question` from Phase 3.
   - Leave retro sections blank/placeholders for Friday.
   - Return the local file path in the final summary.

### Importance/Urgency heuristic for meetings

Meetings have a clear time-bound commitment, so their **Urgency defaults to `🔥 Urgent`**. Use Importance to distinguish whether the meeting is strategically worth attention (`🔥Important`) or just a scheduled obligation / ritual (`❄️Not Important`).

| Meeting type                          | Importance       | Urgency           |
| ------------------------------------- | ---------------- | ----------------- |
| Recurring 1:1 (manager, report)       | 🔥Important      | 🔥 Urgent         |
| Backlog refinement / planning review  | 🔥Important      | 🔥 Urgent         |
| Product / tech spec review            | 🔥Important      | 🔥 Urgent         |
| Team retro / standup                  | ❄️Not Important  | 🔥 Urgent         |
| Stakeholder / client / exec review    | 🔥Important      | 🔥 Urgent         |
| Interview panel / hiring loop         | 🔥Important      | 🔥 Urgent         |
| Internal meet-and-greet / social      | ❄️Not Important  | 🔥 Urgent         |

Examples:

- `Backlog Refinement` → Importance `🔥Important`, Urgency `🔥 Urgent`.
- Standups / Daily Connects → Importance `❄️Not Important`, Urgency `🔥 Urgent`.
- Optional/social calendar events that Sofiane keeps in the plan → Importance `❄️Not Important`, Urgency `🔥 Urgent`. If he asks to remove them in the removal pass, do not create Daily Work rows for them.

If unsure, ask once and remember the answer for the rest of the session.

### Time-icon heuristic (page icon — mandatory on every Daily Work entry)

| Entry type                                                          | Icon | Expected duration |
| ------------------------------------------------------------------- | ---- | ----------------- |
| Standup, daily connect, quick check-in, status ping                 | 🍃   | < 30 min          |
| 1:1, PR review, sprint retro, backlog refinement, short sync        | ⚡   | 30 min – 1.5 h    |
| Workshop, planning meeting, design review, focus block, deep to-do  | 🎯   | > 1.5 h           |

When the calendar screenshot shows the duration, use that to pick the icon. When inferring (recurring meeting whose length isn't visible), use the type heuristic above. Objective-related to-dos default to 🎯 unless they're clearly admin (⚡) or a one-tap action (🍃).

### Area inference for meetings

| Meeting context                                  | Area                |
| ------------------------------------------------ | ------------------- |
| Frontier team, Faculty internals, client work    | ⚗️ Faculty AI       |
| Hiring, performance reviews, strategy offsites   | 🧠 Strategy         |
| External networking, intros, coffee chats        | 🔗 Network          |
| Personal admin, doctor, finance                  | 🐝 Life Admin       |
| Side-project standups (Scrub AI, Dicey Tech…)    | matching Area       |

## Operating Rules

- Never propose tasks Sofiane doesn't have time for — if meetings consume the week, push back.
- Every weekly objective must anchor to a Project, with **one or more Tasks** linked under it. Tasks can be a mix of execution + scope/plan — don't force a single "anchor". If something doesn't fit any in-progress Project, ask whether it should become a Project or be dropped.
- Don't blur the DBs: **objectives → Tasks** (linked to Projects); **execution → Daily Work** (Areas, no relations).
- Weekly objectives default to 3. Cut to 2 if focus hours < 40% of nominal working hours (after subtracting meetings + bank holidays). Show the calculation, don't just announce the result.
- Skip motivational filler. Treat Sofiane as a tech lead, not a coachee.

## Friday Retro Variant

Trigger phrases: "weekly retro", "Friday retro", "let's review the week", "review the week", "weekly review".

### Wheel of Life

Every weekly retro includes a Wheel of Life reflection. Use these exact areas unless Sofiane explicitly changes the model:

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

- Ask for the Wheel of Life scores/notes during Phase 3 before drafting the Weekly Review. A single structured prompt is preferred over eight separate questions: "Fill any Wheel of Life scores/notes you want captured this week: Partner-time, Family & friends, Mental wellbeing, Health & fitness, Team, Business, Finances, Career."
- Scores are optional; notes are optional. If Sofiane gives narrative only, map it to the relevant area notes and leave unknown scores blank.
- Preserve tradeoffs without moralising. Example: time with partner can be a positive Partner-time note even if it displaced side-project work.
- Include the Wheel of Life section in both the Notion Weekly Review page and the local Tolaria weekly plan/retro note.

### Phase 1 — Gather (silent)

1. **Re-fetch in-progress Projects** with the same filter as Monday (`Status = 🔥In Progress` AND `Owner = me`). Capture today's Completion % per project.

2. **Find this week's Monday snapshot.** Query Daily Work for pages where `Name` starts with `Prepare for the week —` and `Date` is the most recent Monday. Read the page body, locate the `<!-- weekly-planning-snapshot v1 ... -->` block, and parse it. If no snapshot is found, proceed without a diff and tell Sofiane in Phase 2 ("no Monday snapshot — showing today's state only").

3. **Diff Completion %** per project: Monday → today, with delta in points. Also flag any project that appeared on Monday but is now Done / Paused / Canceled.

4. **For each Monday objective**, look up the linked Task URL and report its current Status. Categorise: shipped (✅Done), partial (🔥In Progress), dropped (still ❄️Not started or unchanged).

5. **Pull this week's Daily Work** (Date in Mon–Fri of this week). Compute:
   - Completion rate (Done / total)
   - Per-Area breakdown
   - Eisenhower split of completed items (🔥/🔥 vs. ❄️/❄️ vs. mixed)
   - **Carryover candidates**: every entry where Status ≠ `✅Done`. Default policy is to carry over everything — don't filter.

### Phase 2 — Show the retro report

Before asking anything, render:

```
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

### Phase 3 — Ask (one at a time)

**a.** Answer the Friday question from Monday. (Record verbatim — no follow-up unless the answer is ambiguous.)

**b.** For each objective that came in `partial` or `dropped`: "Objective `<Y>` ended `<status>`. What blocked it — calendar, dependency, scope, motivation?"

**c.** *(Only if Daily Work shows a notable Area mismatch vs. intent — e.g. intended Faculty-heavy but `🐝 Life Admin` >25%.)* "`<Area X>` took `<%>` of the week. Intentional or drift?"

**d.** "One thing that worked this week worth keeping?"

**e.** "One thing that didn't work worth changing next week?"

**f.** "Fill any Wheel of Life scores/notes you want captured this week: Partner-time, Family & friends, Mental wellbeing, Health & fitness, Team, Business, Finances, Career. Scores can be rough or blank."

**Skip the carryover question** — policy is to carry everything over by default (see Phase 5).


### Phase 4 — Write (after approval)


1. **Carry over every non-Done Daily Work entry from this week.** For each:
   - Update `Date` to next Monday's date.
   - Leave Status, Importance, Urgency, Area, Name unchanged.
   - Do NOT duplicate the row — update in place.
   - This is the default policy. Only skip an entry if Sofiane explicitly named it during the conversation (e.g. "drop the email triage one").

2. **Return a summary** with:
   - Any project that drifted to ✅Done / ⏸ Paused / ❌ Canceled this week (so Sofiane can decide if a new project should replace it next Monday)

3. **Update the local Weekly Plan and Retro note**:
   - Find `weekly-plan-and-retro-<Mon YYYY-MM-DD>.md` in `$TOLARIA_VAULT_DIR`.
   - If it exists, preserve `Initial plan` and replace/fill the retro sections using the approved retro content.
   - If it does not exist, create it from the template, reconstructing the `Initial plan` from the Monday snapshot when possible and then filling the retro sections.
   - Return the local file path in the final summary.
