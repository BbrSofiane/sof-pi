---
name: browser
description: Use this skill when the user wants to drive a real headless browser from the terminal to check for things on the web — inspect rendered pages, extract text/HTML/title/attributes, run JS, assert conditions, capture screenshots, or audit accessibility. Uses `rodney`, a Go CLI that drives a persistent headless Chrome over CDP (via the rod library). Triggers on tasks like "check what's on this page", "screenshot this URL", "open this in a browser and look at it", "is this element on the page", "does the page show X", "run this JS in the browser", "grab the text of the h1", "does the page have a login button", or "audit accessibility on this page".
compatibility: Requires the `rodney` CLI installed (mise: `rodney`) and on PATH, plus a Chrome/Chromium binary. If Google Chrome is not installed, set `ROD_CHROME_BIN` to a Chrome-for-Testing binary — get one with `npx playwright install chromium`, then `export ROD_CHROME_BIN="$(find "$HOME/Library/Caches/ms-playwright" -path '*MacOS/Google Chrome for Testing' -type f | head -1)"` (macOS; on Linux the binary is at `.../chrome-linux/chrome`). Verify with `rodney status` after `rodney start`.
---

# Browser (`rodney`) Skill

Use this skill to check for things in a **real, JavaScript-rendered** browser from the terminal. `rodney` is a Go CLI that drives a **persistent headless Chrome** instance via the [rod](https://github.com/go-rod/rod) library over the Chrome DevTools Protocol. Each command is a short-lived process that connects to the same long-running Chrome over WebSocket, so you can script multi-step browser flows from plain shell — navigate, wait, extract, assert, screenshot — without any Python/Node glue.

> Why rodney (not obscura)? Obscura is a Rust headless engine with **no layout/paint engine** — great for semantic scraping (text/markdown/links) but it explicitly rejects `Page.captureScreenshot`, so it can't produce visual screenshots. Rodney drives real Chrome, so screenshots, PDFs, and full visual rendering all work.

## Architecture & lifecycle

```
rodney start    →  launches headless Chrome (persists after the CLI exits)
                   saves WebSocket debug URL to ~/.rodney/state.json
rodney <cmd>    →  connects to running Chrome, does one thing, disconnects
rodney stop     →  shuts down Chrome, cleans up state
```

Chrome runs independently and tabs/state persist between commands. You typically `rodney start` once, run a sequence of commands, then `rodney stop`.

## Setup

```bash
rodney --help            # verify the CLI is installed
rodney start             # launch headless Chrome (needs ROD_CHROME_BIN if Chrome isn't on the system)
rodney status            # show browser info + active page (sanity check)
rodney stop              # shut down Chrome
```

If `rodney start` fails with no Chrome binary found, install Chrome for Testing and point `rodney` at it (one-time):

```bash
npx playwright install chromium
# macOS (Apple Silicon / Intel — same relative path):
export ROD_CHROME_BIN="$(find "$HOME/Library/Caches/ms-playwright" -path '*MacOS/Google Chrome for Testing' -type f | head -1)"
# Linux:
# export ROD_CHROME_BIN="$(find "$HOME/.cache/ms-playwright" -path '*chrome-linux/chrome' -type f | head -1)"
rodney start
```

If you have Google Chrome installed normally (e.g. `/Applications/Google Chrome.app` on macOS), `rodney` finds it automatically — no `ROD_CHROME_BIN` needed.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ROD_CHROME_BIN` | `/usr/bin/google-chrome` | Path to the Chrome/Chromium binary |
| `RODNEY_HOME` | `~/.rodney` | Data dir for state + Chrome profile |
| `ROD_TIMEOUT` | `30` | Default timeout (seconds) for element queries |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | Authenticated proxy; `rodney start` auto-spawns a local forwarding proxy for Chrome (Chrome can't auth to proxies natively on CONNECT) |

### Directory-scoped sessions (`--local`)

By default state lives globally in `~/.rodney/`. Use `--local` for an isolated session per project (own Chrome instance, cookies, profile in `./.rodney/`):

```bash
rodney start --local       # state in ./.rodney/state.json, profile in ./.rodney/chrome-data/
rodney open https://example.com   # auto-detects local session if ./.rodney exists
rodney stop                # cleans up the local session
```

Add `.rodney/` to `.gitignore`. Force a scope explicitly with `--global` / `--local` anywhere in the command.

## The check-for-things workflow

A typical "look at this page and tell me what's there" run:

```bash
rodney start
rodney open https://example.com
rodney waitstable           # let the DOM settle
rodney title                # → page <title>
rodney text "h1"            # → text of the first <h1>
rodney html "main"          # → outer HTML of <main>
rodney js 'document.querySelectorAll("a").length'   # run arbitrary JS
rodney screenshot page.png  # save a PNG (1280×720 by default)
rodney stop
```

## Command reference

### Lifecycle & navigation

```bash
rodney start [--show] [--insecure|-k]   # --show = visible window; -k = ignore TLS errors
rodney connect host:9222                 # attach to an existing Chrome remote-debug port
rodney status                            # browser info + active page
rodney stop                              # shut down Chrome

rodney open https://example.com          # navigate (http:// added for bare hosts)
rodney back | forward | reload           # reload --hard bypasses cache
rodney clear-cache
```

### Extract information

```bash
rodney url                      # current URL
rodney title                    # <title>
rodney text "h1"                # text content of element
rodney html "div.content"       # outer HTML of element
rodney html                     # full page HTML
rodney attr "a#link" href       # attribute value
rodney pdf output.pdf           # save page as PDF
```

### Run JavaScript

```bash
rodney js document.title
rodney js '1 + 2'                                   # → 3
rodney js 'document.querySelector("h1").textContent'
rodney js '[1,2,3].map(x => x * 2)'                 # pretty-printed JSON
```

The expression is auto-wrapped in `() => { return (expr); }`, exactly as rod's `Eval` requires — so write it as an expression, not a statement block.

### Interact with elements

```bash
rodney click "button#submit"
rodney input "#search" "query"
rodney clear "#search"
rodney file "#upload" photo.png     # set file on a file input; use - for stdin
rodney download "a.pdf-link"        # download href/src target to a file; use - for stdout
rodney select "#dropdown" "value"
rodney submit "form#login"
rodney hover ".menu-item"
rodney focus "#email"
```

### Wait for conditions

```bash
rodney wait ".loaded"     # wait for element to appear and be visible
rodney waitload           # wait for page load event
rodney waitstable         # wait for DOM to stop changing
rodney waitidle           # wait for network to be idle
rodney sleep 2.5          # sleep N seconds
```

### Screenshots & PDF

```bash
rodney screenshot                       # → screenshot.png
rodney screenshot page.png              # → named file
rodney screenshot -w 1280 -h 720 out.png   # set viewport
rodney screenshot-el ".chart" chart.png    # screenshot a specific element
rodney pdf output.pdf                   # save page as PDF
```

Screenshots are real PNGs — open/attach them to *see* what the page renders. This is the core "look at it" capability of the skill.

### Tabs

```bash
rodney pages                 # list tabs (* marks active)
rodney newpage https://...   # open URL in new tab
rodney page 1                # switch to tab by index
rodney closepage 1           # close tab by index
rodney closepage             # close active tab
```

### Checks & assertions (great for "does the page show X?")

These print a result to stdout and use **exit codes** so they compose in shell scripts and CI: `0` = pass, `1` = check failed (condition not met), `2` = error (couldn't run). This lets you distinguish "the assertion is false" from "the command broke."

```bash
rodney exists ".loading"            # true/false; exit 0/1
rodney visible "#modal"             # true/false; exit 0/1
rodney count "li.item"              # number of matching elements
rodney assert 'document.title' 'Dashboard'           # equality check; exit 0/1
rodney assert 'document.querySelector(".logged-in") !== null'   # truthy check
rodney assert 'document.title' 'Wrong' -m "wrong page loaded"   # custom failure message
```

Because check failures are exit `1` and real errors are exit `2`, `set -e` aborts on errors while letting you handle check failures explicitly:

```bash
set -euo pipefail
FAIL=0
check() { if ! "$@"; then echo "FAIL: $*"; FAIL=1; fi }
rodney start; rodney open https://example.com; rodney waitstable
check rodney exists "h1"
check rodney visible "h1"
check rodney assert 'document.title' 'Example Domain'
check rodney ax-find --role navigation
rodney stop
[ "$FAIL" -eq 0 ] && echo "all checks passed" || { echo "some checks failed"; exit 1; }
```

### Accessibility (`ax-*`)

Uses Chrome's [Accessibility CDP domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) to expose what assistive technologies see — handy for "can a screen-reader user find the login button?"

```bash
rodney ax-tree                       # full a11y tree
rodney ax-tree --depth 3             # limit depth
rodney ax-tree --json                # JSON output
rodney ax-find --role button                          # find by role
rodney ax-find --name "Submit"                        # find by accessible name
rodney ax-find --role link --name "Home" --json       # combine filters, JSON out
rodney ax-node "#submit-btn"         # inspect one element's a11y properties
rodney ax-node "h1" --json
```

CI example — fail if any button lacks an accessible name:

```bash
rodney ax-find --role button --json | python3 -c "
import json, sys
buttons = json.load(sys.stdin)
unnamed = [b for b in buttons if not b.get('name', {}).get('value')]
if unnamed:
    print(f'FAIL: {len(unnamed)} button(s) missing accessible name'); sys.exit(1)
print(f'PASS: all {len(buttons)} buttons have accessible names')
"
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Check failed — command ran but the condition/assertion wasn't met |
| `2` | Error — bad args, no browser session, timeout, etc. |

## Discovery

```bash
rodney --help        # top-level command list
rodney <cmd> --help  # flags for a specific command (where supported)
```

Repo: https://github.com/simonw/rodney · rod library: https://github.com/go-rod/rod
