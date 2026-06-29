---
name: notion-cli
description: Use this skill when the user wants to interact with Notion via the ntn CLI — reading or writing pages, querying databases, managing blocks, or automating Notion workflows from the terminal. Triggers on tasks like "fetch this Notion page", "add a task to my database", "update a Notion property", or "query my Notion workspace".
compatibility: Requires ntn CLI installed. Needs NOTION_TOKEN environment variable set, or authenticated via `ntn auth login`.
---

# Notion CLI (`ntn`) Skill

Use this skill to interact with Notion workspaces from the terminal using the official `ntn` CLI.

## Setup

Ensure `ntn` is installed and authenticated before running any commands.

### Installation

I manage my packages using `mise`. See `~/.config/mise/config.toml` for the packages installed.

### Authentication
```bash
ntn login
# Follow the browser flow to authorize your Notion workspace
```

## Core Commands

Use `./scripts/create_daily.py` (resolved relative to this skill directory) when creating 🐝 Daily Work entries; it runs with `uv` and enforces the required icon, date, status, importance, urgency, and area payload shape.

Use help commands to discover available subcommands/options:

```bash
ntn help
```

### `ntn api` — Most flexible interface to the public Notion API

The `ntn api` command lets you call any public API endpoint. Use `ntn api ls` to list supported paths.

```bash
# Search for pages/databases by name
ntn api /v1/search -d '{"query": "Daily Work", "page_size": 10}'

# Get a page by ID
ntn api /v1/pages/{page_id}

# Create a new page with properties
ntn api /v1/pages -X POST -d '{
  "parent": {"database_id": "<db-id>"},
  "properties": {
    "Name": {"title": [{"text": {"content": "New Task"}}]},
    "Status": {"status": {"name": "Not started"}}
  }
}'

# Update a page
ntn api /v1/pages/{page_id} -X PATCH -d '{
  "properties": {"Status": {"status": {"name": "Done"}}}
}'
```

### Pages (Markdown workflow)

`ntn pages` works with Markdown content and frontmatter (for properties). For full property control, prefer `ntn api /v1/pages`.

```bash
# Retrieve a page as Markdown with frontmatter
ntn pages get <page-id>

# Retrieve full JSON instead of Markdown
ntn pages get <page-id> --json

# Create a new page under a parent (opens $EDITOR or use --content)
ntn pages create --parent data-source:<id> --content '# Title\n\nBody'

# Update a page's content from Markdown
ntn pages update <page-id> --content '# Updated body'

# Trash (delete) a page
ntn pages trash <page-id>
```

### Data Sources (was "Databases")

Notion uses **data sources** rather than raw database IDs. A database can contain multiple data sources.

```bash
# Resolve a Notion database ID to its data source IDs
ntn datasources resolve <database-id>

# Query a data source (returns entries as TSV or JSON)
ntn datasources query <data-source-id>
ntn datasources query <data-source-id> --json

# Query with pagination
ntn datasources query <data-source-id> --limit 50
ntn datasources query <data-source-id> --limit 100 --start-cursor <cursor>

# Query with a filter
ntn datasources query <data-source-id> --filter '{"property": "Status", "status": {"equals": "Not started"}}'

# Query with sorting
ntn datasources query <data-source-id> --sort 'Date desc'
```


## Error Handling

| Error | Likely Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Bad or missing token | Re-run `ntn login` or check `NOTION_API_TOKEN` |
| `404 Not Found` | Page/DB not shared with integration | Share the page with your integration in Notion |
| `400 Bad Request` | Malformed JSON properties | Validate JSON structure against the Notion API reference and property type docs |
| `403 Forbidden` | Integration lacks permission | Add the integration to the parent page |

## Important Notes

- **Data sources vs databases**: Notion now uses **data sources** as children of databases. Query a data source ID, not a database ID. Use `ntn datasources resolve <database-id>` to find the data source ID.
- **`ntn datasources query` output**: Default output is TSV. Use `--json` for structured data with full properties.
- **`ntn pages`** is optimized for Markdown workflows. For full property-level control (e.g., setting `status`, `select`, `multi_select`), use `ntn api /v1/pages` instead.
- **`ntn search` does not exist**. Search via `ntn api /v1/search`.
- **`ntn datasources create` does not exist**. Create entries via `ntn api /v1/pages`.

## Reference

- Official CLI docs: https://developers.notion.com/cli/get-started/installation
- Notion API reference: https://developers.notion.com/reference
- Property value formats: https://developers.notion.com/reference/property-value-object
- API status/property type schema: https://developers.notion.com/reference/status-property-value