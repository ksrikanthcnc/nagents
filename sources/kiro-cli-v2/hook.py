#!/usr/bin/env python3
"""
Kiro CLI v2 hook handler.

Called by Kiro's global hook system (~/.kiro/hooks/).
Reads JSON from stdin, determines if session is v2 (has session file in
~/.kiro/sessions/cli/), translates to nagents EventUpdate, POSTs to nagents.

v2 sessions have UUIDs from --resume-id which map to session files.
Hook ID scheme: cli2-{uuid[:8]} (matches scanner output).

Protocol:
  - Stdin: JSON with session_id, hook_event_name, tool_name, etc.
  - Only processes sessions that exist in ~/.kiro/sessions/cli/
  - POSTs EventUpdate to http://127.0.0.1:3335/event
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

NAGENTS_URL = os.environ.get("NAGENTS_URL", "http://127.0.0.1:3335")
HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"


def log(msg: str) -> None:
    print(f"[nagents-cli2] {msg}", file=sys.stderr)


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

    # Strip sess_ prefix if present
    uuid = raw_session_id.replace("sess_", "")

    # Only handle v2 sessions (those with a file in ~/.kiro/sessions/cli/)
    session_file = CLI_SESSIONS_DIR / f"{uuid}.json"
    if not session_file.exists():
        sys.exit(0)

    update = translate(trigger, payload, uuid)
    if not update:
        sys.exit(0)

    post_event(update, trigger)
    sys.exit(0)


def translate(trigger: str, payload: dict, uuid: str) -> dict | None:
    """Translate hook event to nagents EventUpdate."""
    session_id = f"cli2-{uuid[:8]}"
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
