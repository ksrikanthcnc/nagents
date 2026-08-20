#!/usr/bin/env python3
"""
Kiro CLI v3 hook handler.

Called via hook-dispatch.py for v3 sessions (has .history file with sess_ prefix
or exists in conversations_v2 SQLite, but NOT a .json session file).

ID scheme: cli3-{uuid[:8]}
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from translate import translate  # noqa: E402

NAGENTS_URL = os.environ.get("NAGENTS_URL", "http://127.0.0.1:3335")
HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
CLI_DB = HOME / "Library/Application Support/kiro-cli/data.sqlite3"


def log(msg: str) -> None:
    print(f"[nagents-cli3] {msg}", file=sys.stderr)


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        payload = json.loads(raw)
    except Exception as e:
        log(f"failed to read stdin: {e}")
        sys.exit(0)

    trigger = payload.get("hook_event_name", "") or payload.get("trigger", "")
    raw_session_id = payload.get("session_id", "") or payload.get("sessionId", "")

    if not raw_session_id:
        sys.exit(0)

    uuid = raw_session_id.replace("sess_", "")

    # v2 sessions have .json files — skip
    if (CLI_SESSIONS_DIR / f"{uuid}.json").exists():
        sys.exit(0)

    # Must be v3: has .history file or exists in conversations_v2
    is_v3 = (CLI_SESSIONS_DIR / f"{raw_session_id}.history").exists()
    if not is_v3:
        is_v3 = is_v3_conversation(uuid)
    if not is_v3:
        sys.exit(0)

    session_id = f"cli3-{uuid[:8]}"
    update = translate(trigger, payload, session_id)
    if not update:
        sys.exit(0)

    post_event(update, trigger)
    sys.exit(0)


def is_v3_conversation(conv_id: str) -> bool:
    """Check if a conversation_id exists in the v3 SQLite database."""
    if not CLI_DB.exists():
        return False
    try:
        conn = sqlite3.connect(str(CLI_DB), timeout=1)
        row = conn.execute(
            "SELECT 1 FROM conversations_v2 WHERE conversation_id = ? LIMIT 1",
            (conv_id,)
        ).fetchone()
        conn.close()
        return row is not None
    except Exception:
        return False


def post_event(update: dict, trigger: str) -> None:
    try:
        data = json.dumps(update).encode()
        req = urllib.request.Request(
            f"{NAGENTS_URL}/event",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=3)
        log(f"{trigger} → {update.get('event', '?')} (session={update['session_id']}, status={resp.status})")
    except Exception as e:
        log(f"POST failed: {e}")


if __name__ == "__main__":
    main()
