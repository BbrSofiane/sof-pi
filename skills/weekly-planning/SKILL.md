---
name: weekly-planning
description: "Run Sofiane's Monday weekly planning or Friday weekly retro. Use for 'plan the week', 'weekly planning', 'prepare for the week', 'weekly retro', 'Friday retro', or 'weekly review'. Reads Notion Projects, Tasks, and Daily Work, uses a calendar screenshot for planning, sets 3 project-anchored objectives, writes Notion Daily Work plans/reviews, maintains the local Tolaria weekly plan/retro note, and includes Wheel of Life reflection in retros."
metadata:
  author: sofiane
  version: '1.6'
---

# Weekly Planning

Run Sofiane's Monday planning workflow or Friday retro workflow. This skill captures durable planning rules; read the relevant reference before doing workflow-specific work:

- For Monday planning, read [`references/monday-planning.md`](references/monday-planning.md), [`references/notion-schema.md`](references/notion-schema.md), and [`references/calendar-and-daily-work.md`](references/calendar-and-daily-work.md).
- For Friday retro, read [`references/friday-retro.md`](references/friday-retro.md), [`references/notion-schema.md`](references/notion-schema.md), and [`references/calendar-and-daily-work.md`](references/calendar-and-daily-work.md) as needed.
- Use the existing `notion-cli` skill for CLI mechanics; these references define what to query and write, not a replacement CLI manual.

## Triggers and context

- Monday (or “plan the week”, “weekly planning”, “prepare for the week”): plan the next week.
- Friday (or “weekly retro”, “Friday retro”, “let's review the week”, “review the week”, “weekly review”): review the current week.
- Sofiane is a London-based Faculty AI Frontier tech lead. His quarterly anchors are the in-progress Projects database rows, not OKRs. Use a direct tone with no motivational filler.
- His work has two modes: **execution** (implementation, validation, debugging) and **scope/plan** (shape-ups, design docs, scoping and decomposing future work).

## Non-negotiable model

Keep the three Notion databases distinct:

- **Projects** are quarterly anchors.
- **Tasks** are high-level, project-linked units of weekly progress.
- **Daily Work** is execution noise (meetings and to-dos) and deliberately has no Project/Task relations.

Every weekly objective must anchor to an in-progress Project and one or more Tasks. An objective may require multiple sequential Tasks, often mixing execution and scope/plan; never collapse it to one “anchor task”. If work fits no in-progress Project, ask whether to create a Project or drop it.

## Capacity and calendar gate

A Google Calendar screenshot is mandatory for Monday planning because the agent cannot access Sofiane's work calendar. Request it before reading data, wait for it, parse all colour-coded events as in scope by default, echo per-day event counts, and proceed only after Sofiane confirms the parse. If the parse is wrong, request a sharper screenshot rather than guessing.

Check UK bank holidays in Monday–Friday of the planning week. A bank holiday counts as zero working hours, must be surfaced, and must reduce capacity. Show the calculation:

`working hours − meeting hours − bank-holiday hours = focus hours`

Recommend 3 objectives by default, but cut to 2 when focus hours are less than 40% of nominal working hours. Never propose more work than the capacity supports.

## Approval and safety gates

- Ask one question at a time and wait for each answer.
- Show a situation report, then a draft; do not write while still gathering or drafting.
- Before writing, run the removal pass for optional/duplicate calendar events; surface candidates and never auto-drop them.
- Ask for explicit approval before creating Tasks, Daily Work entries, or the local note.
- Confirm targets and inspect state before paid, public, destructive, or irreversible changes.
- Carry over every non-Done Daily Work item by updating it in place, never by duplicating it; skip one only when Sofiane explicitly names it.

## Workflow outline

### Monday planning

1. Request and confirm the calendar screenshot.
2. Gather in-progress Projects and linked Tasks, recent Daily Work, bank holidays, and calendar capacity.
3. Show the situation report and ask sequenced priority/objective questions.
4. Draft objectives, Daily Work, risks, and a Friday question; run the removal pass.
5. After approval, create only approved Tasks, write Mon–Fri Daily Work entries, and create/update the local weekly note.

Read [`references/monday-planning.md`](references/monday-planning.md) for the exact phases, questions, report/draft formats, write order, and snapshot behavior.

### Friday retro

1. Re-fetch all in-progress Projects and compare them with the Monday snapshot when available.
2. Report objective outcomes, progress for every in-progress Project, Daily Work execution, and carryover candidates.
3. Ask the Friday question, investigate partial/dropped objectives, collect what worked/changed, and include the Wheel of Life reflection.
4. After approval, carry over every non-Done Daily Work row in place and update the local note.

Read [`references/friday-retro.md`](references/friday-retro.md) for the exact snapshot diff, report, questions, Wheel of Life, and write behavior.

## Living documentation

This skill is a living record of observed planning failures and preferences. If a session reveals a calendar parsing error, capacity mistake, Notion schema change, carryover mistake, objective/task-linking failure, or changed preference, update the relevant reference (or this entry point when it changes a global rule) with the durable lesson and increment the metadata version. Do not add speculative procedures for failures that have not occurred.
