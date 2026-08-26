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
from kiro_translate import translate  # noqa: E402

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

    # Handle nagents: command
    if update.get("_nagents_cmd"):
        handle_nagents_cmd(update)
        sys.exit(0)

    # Auto-set title from prompt (skip if manually set via nagents:)
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

    full_group = f"v2:{group}" if group else "v2"

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
