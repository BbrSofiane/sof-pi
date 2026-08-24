# Learning extension

A small project-based learning mode for pi, inspired by the principle: build ramps to knowledge, not syllabi.

The extension keeps the learner inside a concrete project loop:

1. encounter a need;
2. attempt a solution;
3. identify the exact friction;
4. learn the minimum needed concept;
5. apply it immediately;
6. prove understanding through explanation or variation.

## Commands

### `/learn <concept>`

Starts a learning ramp. The command asks for your current understanding and a timebox, then asks pi to propose two or three tiny projects where the concept becomes necessary.

```text
/learn TypeScript discriminated unions
/learn how SQLite indexes work
/learn pi extension lifecycle events
```

Learning state is scoped to the current pi session and follows its active branch. A small footer status shows the current target while learning mode is active.

### `/learn-status`

Shows the active concept, starting point, and timebox.

### `/learn-stop`

Stops learning mode in the current session.

## Coaching behavior

While a ramp is active, pi is instructed to:

- start from an observable project problem rather than a syllabus;
- ask for predictions and attempts before explaining;
- reveal one challenge at a time;
- provide progressively stronger hints;
- avoid implementing the substantive learning task unless explicitly asked;
- help directly with incidental tooling and boilerplate;
- finish with an explanation and an independent variation.

## Dogfooding

After installing or reloading this package, try:

```text
/learn pi extension lifecycle and state
```

A fitting first project is to inspect and modify this extension itself.

## Current scope

This intentionally small first version has no course format, knowledge graph, mastery score, spaced repetition, or cross-session learner profile. The goal is to learn from actual use before adding infrastructure.
