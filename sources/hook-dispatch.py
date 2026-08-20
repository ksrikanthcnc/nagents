#!/usr/bin/env python3
"""
Nagents hook dispatcher.

Single entry point for Kiro's global hook system.
Reads the hook payload from stdin and routes to the correct source handler
based on session_id characteristics:

  - sess_ prefix or IDE session paths → kiro-ide/hook.py
  - UUID exists in ~/.kiro/sessions/cli/ → kiro-cli-v2/hook.py
  - UUID exists in conversations_v2 SQLite → kiro-cli-v3/hook.py
  - Otherwise → kiro-ide/hook.py (default)

Each handler is responsible for posting to nagents with the correct session ID
format for its source.
"""

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
NAGENTS_ROOT = Path(__file__).parent
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
CLI_DB = HOME / "Library/Application Support/kiro-cli/data.sqlite3"

HANDLERS = {
    "ide": NAGENTS_ROOT / "kiro-ide/hook.py",
    "cli-v2": NAGENTS_ROOT / "kiro-cli-v2/hook.py",
    "cli-v3": NAGENTS_ROOT / "kiro-cli-v3/hook.py",
}


def log(msg: str) -> None:
    print(f"[nagents-dispatch] {msg}", file=sys.stderr)


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        sys.exit(0)

    # Debug: full payload dump
    debug_file = Path("/tmp/nagents-dispatch-debug.log")
    with open(debug_file, "a") as f:
        f.write(f"[{__import__('time').strftime('%H:%M:%S')}] {raw[:3000]}\n")

    try:
        payload = json.loads(raw)
    except Exception:
        sys.exit(0)

    raw_session_id = payload.get("session_id", "") or payload.get("sessionId", "")
    if not raw_session_id:
        sys.exit(0)

    handler = classify(raw_session_id)
    handler_path = HANDLERS.get(handler)

    if not handler_path or not handler_path.exists():
        log(f"no handler for {handler}")
        sys.exit(0)

    # Forward stdin to the handler
    env = os.environ.copy()
    try:
        subprocess.run(
            ["python3", str(handler_path)],
            input=raw,
            text=True,
            timeout=5,
            env=env,
        )
    except Exception as e:
        log(f"handler {handler} failed: {e}")

    sys.exit(0)


def classify(session_id: str) -> str:
    """Determine which source owns this session."""
    # Strip sess_ prefix for file lookups
    uuid = session_id.replace("sess_", "")

    # v2: has a .json session file in ~/.kiro/sessions/cli/
    if (CLI_SESSIONS_DIR / f"{uuid}.json").exists():
        return "cli-v2"

    # v3: has a .history file with sess_ prefix in ~/.kiro/sessions/cli/
    if (CLI_SESSIONS_DIR / f"{session_id}.history").exists():
        return "cli-v3"
    # Also check without sess_ prefix (older v3 sessions)
    if session_id.startswith("sess_") and (CLI_SESSIONS_DIR / f"{session_id}.history").exists():
        return "cli-v3"

    # v3 alternative: exists in conversations_v2 SQLite table
    if is_v3_conversation(uuid):
        return "cli-v3"

    # Default: treat as IDE
    return "ide"


def is_v3_conversation(conv_id: str) -> bool:
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


if __name__ == "__main__":
    main()
