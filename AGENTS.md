# Agent Guidelines

## Keep the README in sync

`README.md` is the canonical overview of this pi package. Whenever you add,
remove, or meaningfully change a skill or extension, update the relevant
section of `README.md` to reflect it:

- **Skills** — update the skills table. Pull the trigger description from the
  skill's frontmatter `description`.
- **Extensions** — update the Extensions section. Describe the commands/tools
  the extension exposes and link to any per-extension README.
- **Agents** — update the Agents section. Describe what each packaged agent
  override changes relative to its builtin (rubric additions, tool/model
  differences) and note the precedence it relies on.

Do this as part of the same change set rather than as a follow-up, and commit
the README update together with the skill/extension change.
