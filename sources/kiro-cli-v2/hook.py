#!/usr/bin/env python3
"""
Kiro CLI v2 hook handler.

Called via hook-dispatch.py for v2 sessions (UUID exists in ~/.kiro/sessions/cli/ as .json).
Translates Kiro hook payload → nagents EventUpdate → POST /event.

ID scheme: cli2-{uuid[:8]}
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from translate import translate  # noqa: E402

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

    uuid = raw_session_id.replace("sess_", "")

    # Only handle v2 sessions (those with a .json file)
    if not (CLI_SESSIONS_DIR / f"{uuid}.json").exists():
        sys.exit(0)

    session_id = f"cli2-{uuid[:8]}"
    update = translate(trigger, payload, session_id)
    if not update:
        sys.exit(0)

    post_event(update, trigger)
    sys.exit(0)


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
