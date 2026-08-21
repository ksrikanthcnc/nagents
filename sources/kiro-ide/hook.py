#!/usr/bin/env python3
"""
Kiro IDE hook handler.

Called via hook-dispatch.py for IDE sessions (sess_ prefix or default).
Translates Kiro hook payload → nagents EventUpdate → POST /event.

ID scheme: ide-{uuid[:8]}
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

# Add parent dir to path for shared translate module
sys.path.insert(0, str(Path(__file__).parent.parent))
from kiro_translate import translate  # noqa: E402

NAGENTS_URL = os.environ.get("NAGENTS_URL", "http://127.0.0.1:3335")


def log(msg: str) -> None:
    print(f"[nagents-ide] {msg}", file=sys.stderr)


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

    session_id = make_session_id(raw_session_id)
    update = translate(trigger, payload, session_id)
    if not update:
        sys.exit(0)

    post_event(update, trigger)
    sys.exit(0)


def make_session_id(raw_id: str) -> str:
    """Convert Kiro session ID to nagents format: ide-{first8}."""
    if not raw_id:
        return ""
    short = raw_id.replace("sess_", "")[:8]
    return f"ide-{short}"


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
