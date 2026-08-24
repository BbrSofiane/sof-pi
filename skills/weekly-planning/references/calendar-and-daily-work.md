# Calendar and Daily Work rules

This reference is used by the [weekly-planning skill](../SKILL.md). It preserves the heuristics for turning a confirmed calendar screenshot and selected objectives into Daily Work records.

## Calendar parsing and capacity

The agent has no access to Sofiane's work calendar. Monday planning therefore starts by requesting a screenshot of his Faculty Google Calendar for the next 7 days (Mon–Sun), before reading any data. Parse event title, start/end, and per-day meeting hours, including recurring 1:1s and Frontier rituals.

Treat **all colour-coded events as in scope by default** (Faculty purple, personal, and all other colours). Never discard an event by colour unless Sofiane gives an unambiguous explicit instruction. Echo one line of daily counts—`Mon: N events, Tue: N events, …`—before the situation report and wait for confirmation. If the parse is wrong, ask for a sharper screenshot rather than guessing.

Check UK bank holidays during planning Monday–Friday. Treat each as zero working hours, surface it explicitly, and subtract its hours from capacity. Use:

`working hours − meeting hours − bank-holiday hours = focus hours`

Estimate meeting duration from visible times when possible. Otherwise use the icon convention below: 🍃 = 0.25 h, ⚡ = 1 h, 🎯 = 2 h. Report each day's hours and icon mix; a day stacked with 🎯 can have little focus time even when raw meeting hours look moderate. Recommend 3 objectives when focus is greater than 40% of nominal working hours, otherwise 2.

## Daily Work records

For each retained meeting and objective-related to-do, create one Daily Work row only after explicit approval. Set Status to `❄️Not started`. For meetings, use the title and day from the screenshot, inferred Area (default `⚗️ Faculty AI`), and the meeting Importance/Urgency rules below. For objective to-dos, match the parent Project's Area, set Importance `🔥Important`, and set Urgency `🔥 Urgent` when Due is this week, otherwise `❄️Not Urgent`.

Every entry must have a page icon:

| Entry | Icon | Expected duration |
|---|---|---|
| Standup, Daily Connect, quick check-in, status ping | 🍃 | < 30 min |
| 1:1, PR review, sprint retro, backlog refinement, short sync | ⚡ | 30 min–1.5 h |
| Workshop, planning meeting, design review, focus block, deep to-do | 🎯 | > 1.5 h |

When screenshot duration is visible, use it. Otherwise infer from meeting type. Objective to-dos default to 🎯 unless clearly admin (⚡) or a one-tap action (🍃).

## Meeting importance and urgency

Meetings are time-bound, so Urgency defaults to `🔥 Urgent`. Importance indicates strategic value:

| Meeting type | Importance | Urgency |
|---|---|---|
| Recurring 1:1 (manager, report) | 🔥Important | 🔥 Urgent |
| Backlog refinement / planning review | 🔥Important | 🔥 Urgent |
| Product / tech spec review | 🔥Important | 🔥 Urgent |
| Team retro / standup | ❄️Not Important | 🔥 Urgent |
| Stakeholder / client / exec review | 🔥Important | 🔥 Urgent |
| Interview panel / hiring loop | 🔥Important | 🔥 Urgent |
| Internal meet-and-greet / social | ❄️Not Important | 🔥 Urgent |

Examples: Backlog Refinement is Important/Urgent; Standups and Daily Connects are Not Important/Urgent; optional/social events retained after the removal pass are Not Important/Urgent. If unsure, ask once and remember the answer for the rest of the session.

## Area inference

| Meeting context | Area |
|---|---|
| Frontier team, Faculty internals, client work | ⚗️ Faculty AI |
| Hiring, performance reviews, strategy offsites | 🧠 Strategy |
| External networking, intros, coffee chats | 🔗 Network |
| Personal admin, doctor, finance | 🐝 Life Admin |
| Side-project standups (Scrub AI, Dicey Tech, etc.) | Matching Area |

## Removal pass

After drafting the plan, explicitly ask:

> Anything to drop or downgrade in the meeting list before I write? (Daily Connects, optional plenaries, social/'time' blocks, duplicate option-1/option-2 invites.)

Proactively flag titles containing `Daily Connect`, `(option 1)`, `(option 2)`, `TIME`, `Roundtable`, `DEAL`, or social/coffee patterns. Do not auto-drop; surface candidates and iterate until Sofiane says “that's it”, “nothing else”, or approves. Bank-holiday meeting rows are skipped; to-dos on that day are added only if Sofiane explicitly chose to work.
