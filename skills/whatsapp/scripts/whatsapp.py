#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""whatsapp — a small CLI for a ruwa WhatsApp server.

Config (env, all overridable by flags):
  RUWA_API_ENDPOINT  base URL, e.g. https://example.com
                      (scheme-less values like "example.com" get https:// prepended)
  RUWA_API_TOKEN     bearer token for /v1/*
  RUWA_SESSION       default session id OR label; falls back to the
                      single session if exactly one exists

Examples:
  whatsapp send <number> "Hello from my agent"
  whatsapp send <session> "hi" --mention <number>   # `to` may be a label? no — to is a number
  whatsapp send <number> "replying" --reply-to <message_id>
  whatsapp send-media <number> ./photo.jpg --caption "look"
  whatsapp chats
  whatsapp messages <number> --limit 20
  whatsapp sessions
  whatsapp qr
  whatsapp pair-phone <number>
  whatsapp health
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
from datetime import datetime, timezone

import httpx


# ── config ────────────────────────────────────────────────────────────────────
def base_url(arg: str | None) -> str:
    b = arg or os.environ.get("RUWA_API_ENDPOINT") or os.environ.get("RUWA_BASE_URL")
    if not b:
        die("no endpoint set: pass --base or set RUWA_API_ENDPOINT")
    b = b.strip().rstrip("/")
    if not b.startswith(("http://", "https://")):
        b = "https://" + b
    return b


def token(arg: str | None) -> str:
    t = arg or os.environ.get("RUWA_API_TOKEN")
    if not t:
        die("no token set: pass --token or set RUWA_API_TOKEN")
    return t


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


# ── http ──────────────────────────────────────────────────────────────────────
class Client:
    def __init__(self, base: str, tok: str, timeout: float):
        self.base = base
        self.tok = tok
        self.http = httpx.Client(
            base_url=base, timeout=timeout, headers={"Authorization": f"Bearer {tok}"}
        )

    def req(
        self,
        method: str,
        path: str,
        *,
        json_body=None,
        files=None,
        data=None,
        params=None,
    ):
        try:
            r = self.http.request(
                method, path, json=json_body, files=files, data=data, params=params
            )
        except httpx.HTTPError as e:
            die(f"request failed: {e}")
        if r.status_code >= 400:
            try:
                body = r.json()
                msg = body.get("error", json.dumps(body))
            except Exception:
                msg = r.text or f"HTTP {r.status_code}"
            die(f"{method} {path} → HTTP {r.status_code}: {msg}")
        return r

    def get_json(self, path, params=None):
        return self.req("GET", path, params=params).json()

    def post_json(self, path, body):
        return self.req("POST", path, json_body=body).json()


# ── session resolution ────────────────────────────────────────────────────────
def is_uuidish(s: str) -> bool:
    return len(s) >= 8 and "-" in s and all(c in "-0123456789abcdef" for c in s.lower())


def resolve_session(client: Client, value: str | None) -> str:
    sessions = client.get_json("/v1/sessions")
    if value:
        # exact id match
        for s in sessions:
            if s.get("id") == value:
                return value
        # label match
        for s in sessions:
            if (s.get("label") or "") == value:
                return s["id"]
        # if it looks like a uuid, trust it (maybe server has no list perm? unlikely)
        if is_uuidish(value):
            return value
        die(
            f"session '{value}' not found; known: "
            + ", ".join(f"{s.get('label') or s['id']}" for s in sessions)
            or "(none)"
        )
    # no value: env RUWA_SESSION
    env_s = os.environ.get("RUWA_SESSION")
    if env_s:
        return resolve_session(client, env_s)
    if len(sessions) == 1:
        return sessions[0]["id"]
    die(
        "no session specified; set RUWA_SESSION or pass --session. known: "
        + ", ".join(f"{s.get('label') or s['id']}" for s in sessions)
        or "(none)"
    )


# ── helpers ───────────────────────────────────────────────────────────────────
def to_jid(v: str) -> str:
    """Accept a bare phone number or a full jid; normalize phone → ...@s.whatsapp.net."""
    if "@" in v:
        return v
    digits = "".join(c for c in v if c.isdigit())
    if not digits:
        die(f"'{v}' is not a valid phone number or jid")
    return f"{digits}@s.whatsapp.net"


def ts_fmt(v) -> str:
    """Format a unix timestamp that may be in seconds OR milliseconds.

    1e12 ms == 2001-09-09, so any value below that threshold is seconds and any
    value at/above it is milliseconds — a clean split for any real 1970–2286
    timestamp. Pass the raw value; the function figures out the unit."""
    if v is None:
        return "-"
    try:
        v = int(v)
    except (TypeError, ValueError):
        return str(v)
    if v >= 10_000_000_000:  # >= ~2001 in ms → milliseconds
        v //= 1000
    try:
        return datetime.fromtimestamp(v, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    except (OverflowError, OSError, ValueError):
        return str(v)


def print_json(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


# ── commands ──────────────────────────────────────────────────────────────────
def cmd_send(client: Client, args):
    sid = resolve_session(client, args.session)
    body = {
        "to": to_jid(args.to),
        "text": args.text,
        "mentions": [to_jid(m) for m in args.mention],
    }
    if args.reply_to:
        body["reply_to"] = args.reply_to
    if args.quote_participant:
        body["quoted"] = {
            "id": args.reply_to or args.quote_id,
            "participant": to_jid(args.quote_participant),
        }
    elif args.quote_id:
        body["quoted"] = {"id": args.quote_id}
    r = client.post_json(f"/v1/sessions/{sid}/messages", body)
    if args.json:
        print_json(r)
        return
    print(f"✓ sent to {args.to}  id={r.get('id')}  status={r.get('status')}")


def cmd_send_media(client: Client, args):
    sid = resolve_session(client, args.session)
    path = args.path
    # support http(s) URLs by downloading first
    if path.startswith(("http://", "https://")):
        try:
            r = httpx.get(path, timeout=60, follow_redirects=True)
            r.raise_for_status()
        except httpx.HTTPError as e:
            die(f"download failed: {e}")
        data = r.content
        filename = args.filename or path.rsplit("/", 1)[-1].split("?")[0] or "file"
        mime = r.headers.get("content-type", "").split(";")[0] or None
    else:
        if not os.path.isfile(path):
            die(f"file not found: {path}")
        with open(path, "rb") as f:
            data = f.read()
        filename = args.filename or os.path.basename(path)
        mime = args.mime or mimetypes.guess_type(filename)[0]
    kind = args.type or infer_kind(filename, mime)
    meta = {
        "to": to_jid(args.to),
        "type": kind,
        "mime": mime or "application/octet-stream",
        "filename": filename,
    }
    if args.caption:
        meta["caption"] = args.caption
    r = client.post_json(
        f"/v1/sessions/{sid}/messages/media/multipart",
        files={"file": (filename, data, mime or "application/octet-stream")},
        data={"metadata": json.dumps(meta)},
    )
    if args.json:
        print_json(r)
        return
    print(f"✓ sent {kind} to {args.to}  id={r.get('id')}  status={r.get('status')}")


def infer_kind(filename: str, mime: str | None) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    g = mimetypes.guess_type(filename)[0] or ""
    if g.startswith("image/"):
        return "image"
    if g.startswith("video/"):
        return "video"
    if g.startswith("audio/"):
        return "audio"
    return "document"


def cmd_sessions(client: Client, args):
    rows = client.get_json("/v1/sessions")
    if args.json:
        print_json(rows)
        return
    if not rows:
        print("(no sessions)")
        return
    print(f"{'ID':36} {'LABEL':16} {'STATUS':12} {'JID'}")
    for s in rows:
        print(
            f"{s.get('id',''):36} {(s.get('label') or '-')[:16]:16} "
            f"{str(s.get('status',''))[:12]:12} {s.get('jid') or '-'}"
        )


def cmd_chats(client: Client, args):
    sid = resolve_session(client, args.session)
    rows = client.get_json(f"/v1/sessions/{sid}/chats")
    if args.limit:
        rows = rows[: args.limit]
    if args.json:
        print_json(rows)
        return
    if not rows:
        print("(no chats yet — send a message or wait for history sync)")
        return
    print(f"{'NAME':24} {'JID':40} {'GRP':3} {'LAST'}")
    for c in rows:
        name = (c.get("name") or c.get("jid") or "-")[:24]
        last = ts_fmt(c["last_msg_ts"]) if c.get("last_msg_ts") else "-"
        print(
            f"{name:24} {c.get('jid','')[:40]:40} {'Y' if c.get('is_group') else '-':3} {last}"
        )


def cmd_messages(client: Client, args):
    sid = resolve_session(client, args.session)
    chat = to_jid(args.chat)
    rows = client.get_json(
        f"/v1/sessions/{sid}/messages", params={"chat": chat, "limit": args.limit}
    )
    if args.json:
        print_json(rows)
        return
    if not rows:
        print("(no messages)")
        return
    for m in rows:  # oldest-first from the API
        who = "me" if m.get("from_me") else "in "
        ts = ts_fmt(m.get("timestamp"))
        body = (m.get("body_text") or f"[{m.get('msg_type','?')}]")[:200]
        print(f"{ts}  {who}  {body}")


def cmd_qr(client: Client, args):
    sid = resolve_session(client, args.session)
    r = client.get_json(f"/v1/sessions/{sid}/qr")
    if args.json:
        print_json(r)
        return
    qr = r.get("qr") or r.get("data_url") or ""
    print("QR ready. Open the ruwa dashboard (GET /) and view Pairing, or decode the")
    print("payload below into an image:")
    print(qr[:120] + ("…" if len(qr) > 120 else ""))


def cmd_pair_phone(client: Client, args):
    sid = resolve_session(client, args.session)
    r = client.post_json(
        f"/v1/sessions/{sid}/pair-phone", {"phone": to_jid(args.phone).split("@")[0]}
    )
    if args.json:
        print_json(r)
        return
    print(f"pairing code: {r.get('code') or r}")


def cmd_health(client: Client, args):
    h = client.get_json("/health")
    if args.json:
        print_json(h)
        return
    print(f"endpoint: {client.base}")
    print(f"status:   {h.get('status')}  version: {h.get('version')}")


# ── argparse ──────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="whatsapp", description="ruwa WhatsApp CLI")
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--base", help="ruwa base URL (env RUWA_API_ENDPOINT)")
    parent.add_argument("--token", help="bearer token (env RUWA_API_TOKEN)")
    parent.add_argument("--session", help="session id or label (env RUWA_SESSION)")
    parent.add_argument("--json", action="store_true", help="raw JSON output")
    parent.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout (s)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", parents=[parent], help="send a text message")
    s.add_argument("to", help="phone number (digits) or full jid")
    s.add_argument("text", help="message body")
    s.add_argument(
        "--reply-to", metavar="MSGID", help="reply to (quote) a message — 1:1 shorthand"
    )
    s.add_argument("--quote-id", metavar="MSGID", help="quoted message stanza id")
    s.add_argument(
        "--quote-participant", help="author jid/phone of the quoted msg (group replies)"
    )
    s.add_argument(
        "--mention",
        action="append",
        default=[],
        help="phone/jid to @mention (repeatable)",
    )
    s.set_defaults(func=cmd_send)

    m = sub.add_parser(
        "send-media", parents=[parent], help="send an image/video/audio/document"
    )
    m.add_argument("to", help="phone number (digits) or full jid")
    m.add_argument("path", help="local file path or http(s) URL")
    m.add_argument("--caption", help="caption (image/video/document)")
    m.add_argument("--type", choices=["image", "video", "audio", "document", "sticker"])
    m.add_argument(
        "--filename", help="display filename (documents); default = basename"
    )
    m.add_argument("--mime", help="override mime type")
    m.set_defaults(func=cmd_send_media)

    sc = sub.add_parser("sessions", parents=[parent], help="list sessions")
    sc.set_defaults(func=cmd_sessions)

    cc = sub.add_parser("chats", parents=[parent], help="list chats")
    cc.add_argument("--limit", type=int, default=50)
    cc.set_defaults(func=cmd_chats)

    mc = sub.add_parser("messages", parents=[parent], help="list messages in a chat")
    mc.add_argument("chat", help="phone number (digits) or full jid")
    mc.add_argument("--limit", type=int, default=50)
    mc.set_defaults(func=cmd_messages)

    qc = sub.add_parser("qr", parents=[parent], help="get the pairing QR")
    qc.set_defaults(func=cmd_qr)

    pc = sub.add_parser(
        "pair-phone", parents=[parent], help="get a phone-link pairing code"
    )
    pc.add_argument("phone", help="phone number (digits)")
    pc.set_defaults(func=cmd_pair_phone)

    hc = sub.add_parser(
        "health", parents=[parent], help="show endpoint + server health"
    )
    hc.set_defaults(func=cmd_health)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    client = Client(base_url(args.base), token(args.token), args.timeout)
    args.func(client, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
