#!/usr/bin/env python3
"""
Kiro Crew source scanner.

Discovers active Crew sessions from context_snapshots.json.
Reads session titles from JSONL files when available.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-crew/scan.py
"""
# NOTE: The app spawns scanners via `sh -c "python3 ..."`, which on macOS may
# resolve to the system python (/usr/bin/python3 = 3.9). PEP 604 unions like
# `Path | None` aren't evaluatable at runtime until 3.10. This future import
# makes all annotations lazy strings, so the scanners run on 3.7+.
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HOME = Path.home()
CREW_SNAPSHOTS = HOME / ".kiro/crew/context_snapshots.json"
CREW_SESSIONS_DIR = HOME / ".kiro/crew/sessions"
# Authoritative list of currently-OPEN crew chats. context_snapshots.json is a
# persistent token-usage cache that keeps closed chats forever, so we must
# intersect with open_slots.json to avoid showing chats the user has closed.
CREW_OPEN_SLOTS = HOME / ".kiro/crew/open_slots.json"


def log(msg: str) -> None:
    """Log to stderr (stdout is reserved for JSON output)."""
    print(f"[kiro-crew] {msg}", file=sys.stderr)


def open_keys() -> set | None:
    """Return the set of currently-open crew chat keys, or None if the file is
    missing/unreadable (in which case we don't filter, to fail open)."""
    if not CREW_OPEN_SLOTS.exists():
        return None
    try:
        data = json.loads(CREW_OPEN_SLOTS.read_text())
        keys = data.get("keys")
        if isinstance(keys, list):
            return {str(k).replace("dashboard:", "") for k in keys}
    except Exception as e:
        log(f"failed to read open_slots: {e}")
    return None


def discover() -> list[dict]:
    """Return all active Crew sessions."""
    sessions = []

    if not CREW_SNAPSHOTS.exists():
        log(f"snapshots not found: {CREW_SNAPSHOTS}")
        return sessions

    try:
        data = json.loads(CREW_SNAPSHOTS.read_text())
    except Exception as e:
        log(f"failed to read snapshots: {e}")
        return sessions

    # Only include chats that are currently open (per open_slots.json). If that
    # file is unavailable, fall open (show all) rather than hide everything.
    open_set = open_keys()
    skipped = 0

    for key, snap in data.items():
        session_key = key.replace("dashboard:", "")
        if open_set is not None and session_key not in open_set:
            skipped += 1
            continue
        used = snap.get("used_tokens", 0)
        window = snap.get("window_tokens", 1000000)

        title = session_key
        jsonl = find_jsonl(session_key)
        if jsonl:
            title = read_session_title(jsonl, fallback=title)

        sessions.append({
            "id": f"crew-{session_key}",
            "source": "kiro-crew",
            "name": title[:50],
            "workspace": "",
            "group": "kiro-crew",
            "active": True,
            "event": None,
            "attention_source": None,
            "attention": False,
            "attention_reason": None,
            "tool": None,
            "file": None,
            "tokens": used,
            "maxTokens": window,
            "mtime": 0,  # Don't update mtime from scanner — hooks manage it via push_event
            "character": None,
            "attention_since": None,
            "on_overlay": False,
        })

    log(f"discovered {len(sessions)} sessions ({skipped} closed, filtered)")
    return sessions


def find_jsonl(session_key: str) -> Path | None:
    """Locate the session JSONL file."""
    if not CREW_SESSIONS_DIR.exists():
        return None
    candidate = CREW_SESSIONS_DIR / f"dashboard_{session_key}.jsonl"
    if candidate.exists():
        return candidate
    for f in CREW_SESSIONS_DIR.glob(f"*{session_key}*.jsonl"):
        return f
    return None


def read_session_title(jsonl: Path, fallback: str) -> str:
    """Read session title from first line of JSONL (metadata entry)."""
    try:
        with open(jsonl) as f:
            first = f.readline().strip()
            if first:
                meta = json.loads(first)
                if meta.get("_type") == "metadata":
                    return meta.get("title", fallback)
    except Exception:
        pass
    return fallback


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
