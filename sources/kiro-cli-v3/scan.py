#!/usr/bin/env python3
"""
Kiro CLI v3 source scanner.

Discovers active v3 CLI sessions via .history files.
v3 sessions create: ~/.kiro/sessions/cli/sess_{uuid}.history (after first message)
                    ~/.kiro/sessions/<hash>/sess_{uuid}/session.json (full metadata)

Detection: scan sess_*.history files, check recency + find session.json for title.
No ps grep — works regardless of how CLI was launched.

ID scheme: cli3-{uuid[:8]}

Outputs JSON array to stdout (consumed by nagents Rust backend).
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
KIRO_SESSIONS_DIR = HOME / ".kiro/sessions"
SESSIONS_FILE = Path(__file__).parent.parent.parent / "data/sessions.json"

# Consider a v3 session active if its .history file was modified within this window.
# Matches the longest reasonable idle time before a session is considered dead.
ACTIVE_THRESHOLD_SEC = 3600 * 24  # 24h — generous, GC handles the rest


def log(msg: str) -> None:
    print(f"[kiro-cli-v3] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active v3 CLI sessions from .history files."""
    sessions = []
    titles_override = load_titles()

    if not CLI_SESSIONS_DIR.exists():
        return sessions

    # v3 .history files have sess_ prefix
    for hist_file in CLI_SESSIONS_DIR.glob("sess_*.history"):
        # Check recency
        age = time.time() - hist_file.stat().st_mtime
        if age > ACTIVE_THRESHOLD_SEC:
            continue

        sess_id = hist_file.stem  # "sess_ca95a60c-b0d6-..."
        uuid = sess_id.replace("sess_", "")
        nagents_id = f"cli3-{uuid[:8]}"

        # Skip if there's a .lock file for this UUID (that's a v2 session)
        if (CLI_SESSIONS_DIR / f"{uuid}.lock").exists():
            continue

        title = read_session_title(sess_id)
        override_title, override_group = resolve_title(nagents_id, titles_override)
        display_title = override_title or title or f"sess_{uuid[:8]}"
        display_group = override_group or "cli"

        sessions.append({
            "id": nagents_id,
            "source": "kiro-cli-v3",
            "name": display_title[:50],
            "workspace": "",
            "group": display_group,
            "active": True,
            "event": None,
            "attention_source": None,
            "attention": False,
            "attention_reason": None,
            "tool": None,
            "file": None,
            "tokens": 0,
            "maxTokens": 1000000,
            "mtime": hist_file.stat().st_mtime,
            "character": None,
            "attention_since": None,
            "on_overlay": False,
        })

    log(f"discovered {len(sessions)} sessions")
    return sessions


def read_session_title(sess_id: str) -> str:
    """Read title from ~/.kiro/sessions/<hash>/<sess_id>/session.json."""
    if not KIRO_SESSIONS_DIR.exists():
        return ""

    for hash_dir in KIRO_SESSIONS_DIR.iterdir():
        if not hash_dir.is_dir():
            continue
        if hash_dir.name == "cli":
            continue
        session_dir = hash_dir / sess_id
        session_json = session_dir / "session.json"
        if session_json.exists():
            try:
                data = json.loads(session_json.read_text())
                title = data.get("title", "")
                if title:
                    return title[:50]
            except Exception:
                pass
    return ""


def load_titles() -> dict:
    """Load user-assigned title overrides from data/sessions.json."""
    if SESSIONS_FILE.exists():
        try:
            data = json.loads(SESSIONS_FILE.read_text())
            titles = {}
            for sid, meta in data.items():
                if isinstance(meta, dict) and meta.get("title"):
                    titles[sid] = meta["title"]
                elif isinstance(meta, str):
                    titles[sid] = meta
            return titles
        except Exception:
            pass
    return {}


def resolve_title(session_id: str, titles: dict) -> tuple[str, str]:
    """
    Check if there's a title override.
    Returns (title, group_override).
    """
    raw = ""
    if session_id in titles:
        raw = titles[session_id]
    else:
        for key, val in titles.items():
            if session_id.startswith(key):
                raw = val
                break
    if not raw:
        return "", ""
    if ":" in raw:
        group, title = raw.split(":", 1)
        return title, group
    return raw, ""


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
