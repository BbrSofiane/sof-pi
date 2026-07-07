---
name: whatsapp
description: 'Send a WhatsApp message (text or media) or inspect a ruwa WhatsApp instance from the terminal — list chats, list messages, show the pairing QR, pair via phone code, or list sessions. Triggers on "send a whatsapp message", "whatsapp", "message someone on whatsapp", "send a photo on whatsapp", "show my whatsapp chats", or "pair a whatsapp number". Backed by a ruwa HTTP server.'
compatibility: 'Requires `uv` (inline-script deps are auto-installed). Needs a reachable ruwa server and these env vars: `RUWA_API_ENDPOINT` (base URL, e.g. https://example.com — a scheme-less host gets https:// prepended) and `RUWA_API_TOKEN` (bearer). Optionally `RUWA_SESSION` (session id or label); if unset and only one session exists it is used automatically.'
---

# WhatsApp (ruwa) Skill

Use this skill to send WhatsApp messages and inspect a [ruwa](https://github.com/oqva-digital/ruwa) instance from the terminal. All operations go through the ruwa HTTP API; this skill wraps it in a small `uv` inline-script CLI so the agent doesn't hand-roll `curl` + bearer headers + session IDs every time.

## Setup (once)

`uv` must be on PATH (managed via `mise`). Then ensure the env vars are exported in the shell the agent runs in:

```sh
export RUWA_API_ENDPOINT=https://<endpoint>   # scheme-less host is fine too
export RUWA_API_TOKEN=<bearer token>                    # ruwa admin token
export RUWA_SESSION=<session>                                  # optional: session id or label
```

Verify connectivity:

```sh
./scripts/whatsapp.py health
# status:   ok  version: 0.3.5
```

The script (`scripts/whatsapp.py`, resolved relative to this skill directory) is a PEP-723 inline script — `uv` installs its single dependency (`httpx`) on first run and caches it. Run it directly (the shebang invokes `uv run --script`) or explicitly via `uv run --script scripts/whatsapp.py ...`.

## Send a message

```sh
# text
./scripts/whatsapp.py send <number> "Hello from my agent"

# reply to / quote a message (1:1 shorthand)
./scripts/whatsapp.py send <number> "noted 👍" --reply-to <message_id>

# group reply (quote + participant author)
./scripts/whatsapp.py send <group_jid> "yes" --quote-id <message_id> --quote-participant <number>

# @mention (repeatable; bare phone is fine)
./scripts/whatsapp.py send <group_jid> "hey @<number>" --mention <number>

# media (local file or http URL; type/mime auto-detected)
./scripts/whatsapp.py send-media <number> ./photo.jpg --caption "look"
./scripts/whatsapp.py send-media <number> https://example.com/cat.png
```

The `to` / `chat` / `--mention` args accept either a **bare phone number** (`<number>`) or a **full jid** (`<number>@s.whatsapp.net`); bare numbers are normalized to `@s.whatsapp.net`.

On success the CLI prints `✓ sent to <n>  id=<id>  status=<queued|sent|…>`. Add `--json` for the raw API response (useful when the agent needs the message id to reply later).

## Inspect

```sh
./scripts/whatsapp.py sessions                 # list instances
./scripts/whatsapp.py chats                    # recent chats (default session)
./scripts/whatsapp.py chats --limit 20
./scripts/whatsapp.py messages <number>    # conversation with a contact
./scripts/whatsapp.py messages <number> --limit 20
```

All inspect commands accept `--json`.

## Pair a new number

```sh
./scripts/whatsapp.py qr               # pairing QR (view in the ruwa dashboard)
./scripts/whatsapp.py pair-phone <number>   # phone-link code, enter on the primary device
```

## Session selection

Every command accepts `--session <id-or-label>`; otherwise the CLI uses `RUWA_SESSION`, and if that's unset and exactly one session exists it is used automatically. `sessions` lists the known ids/labels.

## Error handling

| Symptom | Likely cause | Fix |
|---|---|---|
| `HTTP 401: unauthorized` | wrong/empty token | check `RUWA_API_TOKEN` |
| `HTTP 404: not found: session` | bad session id/label | `./scripts/whatsapp.py sessions`; set `RUWA_SESSION` |
| `session 'x' not found` | label typo or session not created | list sessions; create one via the dashboard or `POST /v1/sessions` |
| `request failed: ...` | wrong endpoint / network / proxy | `health` to confirm reachability |
| send returns `queued` but never `delivered` | linked device offline / banned | check `health` for the session; re-pair if needed |

## Notes

- This speaks the **unofficial** WhatsApp Web multi-device protocol via ruwa — automating real accounts may violate WhatsApp's ToS. Prefer numbers you own.
- Outbound send latency is gated by WhatsApp's servers, not ruwa — `queued` → `sent` → `delivered` events are visible via the session's event stream (`GET /v1/sessions/:id/events/history`).
- The full HTTP API (webhooks, SSE, reactions, edits, polls, presence, S3 media, MCP) is documented in the ruwa repo's `SPEC.md`; this CLI covers the common messaging + inspection surface.
