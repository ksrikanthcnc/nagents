#!/usr/bin/env python3
"""
Kiro CLI v2 source scanner.

Discovers active v2 CLI sessions via lock files.
v2 sessions create: ~/.kiro/sessions/cli/{uuid}.lock (with PID)
                    ~/.kiro/sessions/cli/{uuid}.json (session metadata)

Detection: scan *.lock files, check PID alive, read .json for title.
No ps grep — works regardless of how CLI was launched.

ID scheme: cli2-{uuid[:8]}

Outputs JSON array to stdout (consumed by nagents Rust backend).
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
SESSIONS_FILE = Path(__file__).parent.parent.parent / "data/sessions.json"


def log(msg: str) -> None:
    print(f"[kiro-cli-v2] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active v2 CLI sessions from lock files."""
    sessions = []
    titles_override = load_titles()

    if not CLI_SESSIONS_DIR.exists():
        return sessions

    for lock_file in CLI_SESSIONS_DIR.glob("*.lock"):
        # Skip v3 sessions (sess_ prefix)
        if lock_file.stem.startswith("sess_"):
            continue

        try:
            lock_data = json.loads(lock_file.read_text())
            pid = lock_data.get("pid")
            if not pid:
                continue

            # Check PID is alive
            os.kill(int(pid), 0)
        except (ProcessLookupError, PermissionError, OSError, json.JSONDecodeError, ValueError):
            continue

        session_id = lock_file.stem
        nagents_id = f"cli2-{session_id[:8]}"
        title, cwd, mtime = enrich(session_id)
        override_title, override_group = resolve_title(nagents_id, titles_override)
        display_title = override_title or title or session_id[:8]
        display_group = override_group or "cli"

        sessions.append({
            "id": nagents_id,
            "source": "kiro-cli-v2",
            "name": display_title[:50],
            "workspace": cwd.replace(str(HOME), "~") if cwd else "",
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
            "mtime": mtime,
            "character": None,
            "attention_since": None,
            "on_overlay": False,
        })

    log(f"discovered {len(sessions)} sessions")
    return sessions


def enrich(session_id: str) -> tuple[str, str, float]:
    """Get title, cwd, mtime from session .json file."""
    title = ""
    cwd = ""
    mtime = time.time()

    session_file = CLI_SESSIONS_DIR / f"{session_id}.json"
    if not session_file.exists():
        return title, cwd, mtime

    try:
        data = json.loads(session_file.read_text())
        raw_title = data.get("title") or ""
        title = clean_title(raw_title)
        cwd = data.get("cwd", "")
        ts = data.get("updated_at", "")
        if ts:
            mtime = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception as e:
        log(f"failed to read session {session_id}: {e}")

    return title, cwd, mtime


def clean_title(raw: str) -> str:
    """Filter out non-user titles."""
    if not raw:
        return ""
    skip_prefixes = [
        "[AGENT SYSTEM PROMPT]",
        "You are a memory consolidation agent",
        "First, decide: is the following text",
        "[SESSION CONTEXT",
    ]
    for prefix in skip_prefixes:
        if raw.startswith(prefix):
            return ""
    if len(raw) > 60:
        raw = raw[:57] + "..."
    return raw


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
