#!/usr/bin/env python3
"""
Kiro CLI v3 hook handler.

Called by Kiro's global hook system (~/.kiro/hooks/).
Reads JSON from stdin, determines if session is v3 (exists in conversations_v2
SQLite table but NOT in ~/.kiro/sessions/cli/), translates to nagents EventUpdate.

v3 sessions use conversation_id as their identity. When the session has a unique
CWD, the scanner maps it to cli3-{conv_id[:8]}. When multiple v3 sessions share
a CWD, the scanner uses cli3-{PID} — in that case the hook can't match perfectly,
but nagents's prefix matching + minimal session creation handles the gap.

Protocol:
  - Stdin: JSON with session_id, hook_event_name, tool_name, etc.
  - Only processes sessions NOT in ~/.kiro/sessions/cli/ (those are v2)
  - Also skips sessions with sess_ prefix (those are IDE)
  - POSTs EventUpdate to http://127.0.0.1:3335/event
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

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

    # IDE sessions without sess_ prefix and not in our systems — skip
    # (they'll be handled by the IDE hook via the dispatcher)

    uuid = raw_session_id.replace("sess_", "")

    # v2 sessions have .json files in ~/.kiro/sessions/cli/ — skip
    if (CLI_SESSIONS_DIR / f"{uuid}.json").exists():
        sys.exit(0)

    # Must be a v3 session — check for .history file or conversations_v2
    is_v3 = (CLI_SESSIONS_DIR / f"{raw_session_id}.history").exists()
    if not is_v3:
        is_v3 = is_v3_conversation(uuid)
    if not is_v3:
        sys.exit(0)

    update = translate(trigger, payload, uuid)
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


def translate(trigger: str, payload: dict, uuid: str) -> dict | None:
    """Translate hook event to nagents EventUpdate."""
    # Use conv_id[:8] as session ID — matches scanner when CWD is unique
    session_id = f"cli3-{uuid[:8]}"
    tool_name = payload.get("tool_name", "") or payload.get("toolName", "")
    file_path = payload.get("tool_input", {}).get("path") if isinstance(payload.get("tool_input"), dict) else None

    if trigger == "PreToolUse":
        return {
            "session_id": session_id,
            "event": "tool",
            "tool": tool_name or "unknown",
            "file": shorten_path(file_path),
            "mtime": time.time(),
        }
    elif trigger == "PostToolUse":
        return {
            "session_id": session_id,
            "event": "running",
            "tool": None,
            "mtime": time.time(),
        }
    elif trigger == "Stop":
        return {
            "session_id": session_id,
            "event": "idle",
            "attention": True,
            "mtime": time.time(),
        }
    elif trigger == "UserPromptSubmit":
        return {
            "session_id": session_id,
            "event": "running",
            "attention": False,
            "mtime": time.time(),
        }
    return None


def shorten_path(path: str | None) -> str | None:
    if not path:
        return None
    home = str(HOME)
    if path.startswith(home):
        path = path[len(home) + 1:]
    for prefix in ("work/tasks/", "work/git/", "work/worktree/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    return path


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
        log(f"{trigger} -> {update.get('event', '?')} (session={update['session_id']}, status={resp.status})")
    except Exception as e:
        log(f"POST failed: {e}")


if __name__ == "__main__":
    main()
