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
from kiro_translate import translate  # noqa: E402

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

    # Handle nagents: command (user setting title/group)
    if update.get("_nagents_cmd"):
        handle_nagents_cmd(update)
        sys.exit(0)

    # Auto-title from prompt (skip if manually set via nagents:)
    if trigger == "UserPromptSubmit":
        pass  # prompt already sent in EventUpdate; app uses it for display

    post_event(update, trigger)
    sys.exit(0)


def handle_nagents_cmd(cmd: dict) -> None:
    """Handle nagents: command — set title/group on a session by UUID prefix."""
    prefix = cmd.get("sess_id_prefix", "")
    title = cmd.get("title", "")
    group = cmd.get("group", "")
    is_reset = cmd.get("_reset", False)

    if not prefix:
        return

    if is_reset:
        _remove_manual_title(prefix)
        # Also clear in nagents server
        for id_prefix in [f"cli3-{prefix}", f"cli2-{prefix}", f"ide-{prefix}"]:
            try:
                data = json.dumps({"session_id": id_prefix, "title": ""}).encode()
                req = urllib.request.Request(
                    f"{NAGENTS_URL}/title",
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=2)
            except Exception:
                pass
        return

    # Format: "v3:group" or just "v3" if no group
    full_group = f"v3:{group}" if group else "v3"
    display_title = f"{full_group}:{title}" if title else full_group

    for id_prefix in [f"cli3-{prefix}", f"cli2-{prefix}", f"ide-{prefix}"]:
        try:
            data = json.dumps({"session_id": id_prefix, "title": title}).encode()
            req = urllib.request.Request(
                f"{NAGENTS_URL}/title",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass
    _mark_manual_title(prefix, title, group)


TITLES_FILE = Path(__file__).parent.parent.parent / "data/sessions.json"


def _mark_manual_title(uuid_prefix: str, title: str, group: str) -> None:
    """Persist manual title to data/sessions.json."""
    TITLES_FILE.parent.mkdir(parents=True, exist_ok=True)
    sessions = {}
    if TITLES_FILE.exists():
        try:
            sessions = json.loads(TITLES_FILE.read_text())
        except Exception:
            pass
    for id_prefix in [f"cli3-{uuid_prefix}", f"cli2-{uuid_prefix}", f"ide-{uuid_prefix}"]:
        entry = sessions.get(id_prefix, {})
        if not isinstance(entry, dict):
            entry = {}
        entry["title"] = title
        if group:
            entry["group"] = group
        sessions[id_prefix] = entry
    TITLES_FILE.write_text(json.dumps(sessions, indent=2) + "\n")


def _remove_manual_title(uuid_prefix: str) -> None:
    """Remove manual title (reset to defaults)."""
    if not TITLES_FILE.exists():
        return
    try:
        sessions = json.loads(TITLES_FILE.read_text())
    except Exception:
        return
    changed = False
    for id_prefix in [f"cli3-{uuid_prefix}", f"cli2-{uuid_prefix}", f"ide-{uuid_prefix}"]:
        if id_prefix in sessions:
            entry = sessions[id_prefix]
            if isinstance(entry, dict):
                entry.pop("title", None)
                entry.pop("group", None)
                if not entry:
                    del sessions[id_prefix]
            else:
                del sessions[id_prefix]
            changed = True
    if changed:
        TITLES_FILE.write_text(json.dumps(sessions, indent=2) + "\n")
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
