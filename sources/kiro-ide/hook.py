#!/usr/bin/env python3
"""
Kiro IDE hook handler.

Called by Kiro's agent hook system (.kiro/hooks/).
Reads JSON from stdin (hook payload), translates to nagents EventUpdate,
and POSTs to the nagents server.

Protocol:
  - Stdin: JSON with trigger, sessionId, toolName, file, etc.
  - Translates to nagents EventUpdate and POSTs to http://127.0.0.1:3334/event

Supported triggers:
  - PreToolUse  → event="tool", tool=<toolName>
  - PostToolUse → event="running", tool=null
  - Stop        → event="idle", attention=true
  - UserPromptSubmit → event="running", attention=false
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

NAGENTS_URL = os.environ.get("NAGENTS_URL", "http://127.0.0.1:3335")
HOME = str(Path.home())


def log(msg: str) -> None:
    print(f"[nagents-hook] {msg}", file=sys.stderr)


def main():
    # Read hook payload from stdin
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.exit(0)
        payload = json.loads(raw)
    except Exception as e:
        log(f"failed to read stdin: {e}")
        sys.exit(0)

    # Debug: log raw payload to file
    debug_file = Path("/tmp/nagents-hook-debug.log")
    with open(debug_file, "a") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {raw[:300]}\n")

    trigger = payload.get("hook_event_name", "") or payload.get("trigger", "")
    session_id = payload.get("session_id", "") or payload.get("sessionId", "")

    if not session_id:
        sys.exit(0)

    update = translate(trigger, payload)
    if not update:
        sys.exit(0)

    # POST to nagents
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
        # Don't fail the hook if nagents isn't running
        log(f"POST failed (nagents not running?): {e}")

    sys.exit(0)


def translate(trigger: str, payload: dict) -> dict | None:
    """Translate a Kiro hook event to nagents EventUpdate."""
    raw_session_id = payload.get("session_id", "") or payload.get("sessionId", "")
    session_id = make_session_id(raw_session_id)
    if not session_id:
        return None

    tool_name = payload.get("tool_name", "") or payload.get("toolName", "unknown")
    file_path = payload.get("file") or payload.get("tool_input", {}).get("path")

    if trigger == "PreToolUse":
        return {
            "session_id": session_id,
            "event": "tool",
            "tool": tool_name,
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
    else:
        return None


def make_session_id(raw_id: str) -> str:
    """Convert Kiro session ID to nagents format: ide-{first8}."""
    if not raw_id:
        return ""
    short = raw_id.replace("sess_", "")[:8]
    return f"ide-{short}"


def shorten_path(path: str | None) -> str | None:
    """Shorten absolute path for display."""
    if not path:
        return None
    if path.startswith(HOME):
        path = path[len(HOME) + 1:]
    for prefix in ("work/tasks/", "work/git/", "work/worktree/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    return path


if __name__ == "__main__":
    main()
