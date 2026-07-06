# sof-pi

Personal pi package — workflows, extensions, skills, prompt templates, and themes primarily for Sofiane.

## Structure

```
sof-pi/
├── extensions/   # .ts / .js extensions
├── skills/       # SKILL.md folders / top-level .md skills
├── prompts/      # .md prompt templates
├── themes/       # .json themes
└── package.json  # pi manifest
```

## Skills

| Skill | Triggers |
| --- | --- |
| **[weekly-planning](./skills/weekly-planning)** | Sofiane's Monday weekly planning or Friday weekly retro. Reads Notion Projects, Tasks, and Daily Work, uses a calendar screenshot for planning, sets 3 project-anchored objectives, writes Notion Daily Work plans/reviews, maintains the local Tolaria weekly plan/retro note, and includes a Wheel of Life reflection in retros. |
| **[notion-cli](./skills/notion)** | Interact with Notion via the `ntn` CLI — reading/writing pages, querying databases, managing blocks, automating Notion workflows from the terminal. |
| **[google-workspace](./skills/google-workspace)** | Interact with Google Workspace via the `gog` CLI — Gmail, Calendar, Drive, Tasks, Sheets, Docs, Slides, Chat, Contacts, People, Keep, Forms, Meet, Apps Script, and more. |
| **[mise](./skills/mise)** | Manage dev tools, runtime versions, and environment variables with `mise`, and run mise tasks (make-like commands). |
| **[github-cli](./skills/github-cli)** | Interact with GitHub via the `gh` CLI — cloning repos for inspecting dependencies/third-party projects, checking GitHub Actions pipeline logs and statuses, viewing workflow runs, and ad-hoc GitHub API calls. |

## Extensions

### Code Review (`extensions/review.ts`)

Adds a `/review` command that prompts the agent to review code changes. Supports several modes:

- `/review` — interactive selector
- `/review pr 123` — review GitHub PR #123 (checks it out locally)
- `/review pr https://github.com/owner/repo/pull/123` — review a PR from URL
- `/review uncommitted` — review uncommitted changes directly
- `/review branch main` — review against a base branch (PR-style diff)
- `/review commit abc123` — review a specific commit
- `/review folder src docs` — snapshot review of specific folders/files (not a diff)
- `/review --extra "focus on performance regressions"` — add extra review instructions (works with any mode)

Supports shared custom review instructions (added/removed via the selector) and project-specific guidelines from a `REVIEW_GUIDELINES.md` next to `.pi`. PR review requires a clean working tree.

### Perplexity (`extensions/perplexity/`)

Web search and interactive research via the [Perplexity API](https://docs.perplexity.ai/), designed to keep raw search traffic out of the main pi context window. Two pieces:

1. **`perplexity_search` tool** — single-shot LLM-callable web search. Returns the answer plus numbered sources. Good for quick inline lookups.
2. **`/research` command** — an interactive, full-screen research panel for back-and-forth Perplexity sessions (queries + streamed answers + sources). Build a recap you can shape in an editor and inject into your main thread; intermediate search content stays in the panel and is discarded unless you build a recap.

See [`extensions/perplexity/README.md`](./extensions/perplexity/README.md) for details.

## License

[Apache License 2.0](./LICENSE)
