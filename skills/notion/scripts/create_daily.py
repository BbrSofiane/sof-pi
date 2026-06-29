#!/usr/bin/env -S uv run --script
"""Create one Notion Daily Work entry via ntn.

Example:
  python scripts/create_daily.py \
    --name "Tiger team internal standup" \
    --date 2026-06-17 \
    --icon 🍃 \
    --importance "❄️Not Important" \
    --urgency "🔥 Urgent" \
    --area "⚗️ Faculty AI"
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

DEFAULT_DAILY_WORK_DATA_SOURCE = os.environ.get("NOTION_DAILY_WORK_DATA_SOURCE")
DEFAULT_STATUS = "❄️Not started"


def build_payload(args: argparse.Namespace) -> dict:
    return {
        "parent": {"data_source_id": args.data_source},
        "icon": {"type": "emoji", "emoji": args.icon},
        "properties": {
            "Name": {"title": [{"text": {"content": args.name}}]},
            "Date": {"date": {"start": args.date}},
            "Status": {"status": {"name": args.status}},
            "Importance": {"select": {"name": args.importance}},
            "Urgency": {"select": {"name": args.urgency}},
            "Area": {"multi_select": [{"name": area} for area in args.area]},
        },
    }


def create_page(payload: dict, dry_run: bool) -> int:
    body = json.dumps(payload, ensure_ascii=False)
    if dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    result = subprocess.run(
        ["ntn", "api", "/v1/pages", "-X", "POST"],
        input=body,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        return result.returncode

    print(result.stdout)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a Notion Daily Work entry via ntn")
    parser.add_argument("--name", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--icon", required=True, choices=["🍃", "⚡", "🎯"])
    parser.add_argument("--importance", required=True, choices=["🔥Important", "❄️Not Important"])
    parser.add_argument("--urgency", required=True, choices=["🔥 Urgent", "❄️Not Urgent"])
    parser.add_argument("--area", required=True, action="append", help="Daily Work Area. Repeat for multiple areas.")
    parser.add_argument("--status", default=DEFAULT_STATUS)
    parser.add_argument("--data-source", default=DEFAULT_DAILY_WORK_DATA_SOURCE)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.data_source:
        print("error: --data-source not provided and NOTION_DAILY_WORK_DATA_SOURCE is not set", file=sys.stderr)
        return 2
    return create_page(build_payload(args), args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
