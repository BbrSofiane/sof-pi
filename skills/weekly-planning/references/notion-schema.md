# Notion schema and local note

This reference is used by the [weekly-planning skill](../SKILL.md). Use the existing `notion-cli` skill for authentication, query syntax, pagination, and mutation mechanics. Resolve every `$VAR` from the environment before calling the Notion API.

## Environment variables

| Variable | Purpose |
|---|---|
| `NOTION_WORKSPACE` | Notion workspace handle |
| `NOTION_PROJECTS_DB_ID` | Projects database ID |
| `NOTION_PROJECTS_DATA_SOURCE` | Projects data source ID |
| `NOTION_TASKS_DB_ID` | Tasks database ID |
| `NOTION_TASKS_DATA_SOURCE` | Tasks data source ID |
| `NOTION_DAILY_WORK_DB_ID` | Daily Work database ID |
| `NOTION_DAILY_WORK_DATA_SOURCE` | Daily Work data source ID |
| `NOTION_PREPARE_FOR_WEEK_TEMPLATE_ID` | `Prepare for the week` template page ID |
| `TOLARIA_VAULT_DIR` | Local Tolaria/Obsidian folder where weekly notes live |

## Projects — quarterly anchors

- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_PROJECTS_DB_ID`
- Statuses: 🧠 Planning / 🔥In Progress / ⏸ Paused / 🛑 Backlog / ✅Done / ❌ Canceled
- Properties: Project name, Owner, Status, Priority (Low/Med/High), Dates (start/end), Summary
- Rollup: `Completion` (% of linked Tasks Done)
- Relations: `Tasks` → Tasks DB; `Blocked By` / `Is Blocking` → Projects DB
- Monday and Friday focus filter: `Status = "🔥In Progress"` and Owner contains Sofiane/me.
- Capture project name, URL, priority, end date, completion, summary, and blockers. Sort priority descending, then end date ascending.

## Tasks — project-linked weekly progress

- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_TASKS_DB_ID`
- Statuses: ❄️Not started / 🔥In Progress / ✅Done / 📂 Archived
- Properties: Task name, Status, Priority, Due, Tags, Summary, Assignee
- Relations: `Project` → Projects; `Parent-task` / `Sub-tasks` → Tasks
- Follow every selected Project's `Tasks` relation. Categorise Tasks as completed in the last 7 days, currently in progress, overdue (`Due < today` and not Done/Archived), and due in the next 7 days.
- This is the unit of weekly progress. New Tasks approved during planning use Status `❄️Not started`, the parent Project relation, and a mode tag: `💻 Dev` for execution or `🌱 Shape up` for scope/plan.

## Daily Work — execution records

- URL: `https://www.notion.so/$NOTION_WORKSPACE/$NOTION_DAILY_WORK_DB_ID`
- Statuses: ❄️Not started / 🔥In Progress / ✅Done
- Properties: Name, Date, Importance (`🔥Important` / `❄️Not Important`), Urgency (`🔥 Urgent` / `❄️Not Urgent`)
- Area (multi-select): ⚗️ Faculty AI, 🐝 Life Admin, 🐤 Scrub AI, 🎲 Dicey Tech, 🗞 Emerging Times, 🧠 Strategy, 🔗 Network, 🎉 Customer Ops, 💰 Business Developement, 💻 Product, 🛠 Tools, 🎙️ Content, 👨🏿‍💻 Personal Development, 💼 Admin, 🐙 Kraken, 🟧 GlobalLogic
- Deliberately no Project/Task relations: Daily Work records execution noise.
- Templates: `Prepare for the week` (page ID `$NOTION_PREPARE_FOR_WEEK_TEMPLATE_ID`) and `Weekly Review`.

## Local weekly plan and retro note

Maintain `$TOLARIA_VAULT_DIR/weekly-plan-and-retro-<Mon YYYY-MM-DD>.md`. Title it `# Weekly Plan and Retro — Week of <Mon YYYY-MM-DD>` and use:

```markdown
---
type: Note
---

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

Use the previous note as the template when available, especially `weekly-plan-and-retro-2026-05-04.md`. On Monday fill only `Initial plan` and `Friday question`; leave retro sections as placeholders. On Friday preserve the initial plan and fill `What shipped`, `Partial or carried over`, `Reflection`, `Wheel of Life`, `What worked`, `What to change`, and `Going into next week`. Keep it concise and reflective: objective-level work and important carryovers, not every Daily Work row. If Friday's note is missing, reconstruct its initial plan from the Monday snapshot when possible.
