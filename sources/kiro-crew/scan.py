#!/usr/bin/env python3
"""
Kiro Crew source scanner.

Discovers active Crew sessions from context_snapshots.json.
Reads session titles from JSONL files when available.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-crew/scan.py
"""

import json
import sys
import time
from pathlib import Path

HOME = Path.home()
CREW_SNAPSHOTS = HOME / ".kiro/crew/context_snapshots.json"
CREW_SESSIONS_DIR = HOME / ".kiro/crew/sessions"


def log(msg: str) -> None:
    """Log to stderr (stdout is reserved for JSON output)."""
    print(f"[kiro-crew] {msg}", file=sys.stderr)


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

    for key, snap in data.items():
        session_key = key.replace("dashboard:", "")
        used = snap.get("used_tokens", 0)
        window = snap.get("window_tokens", 1000000)

        title = session_key
        jsonl = find_jsonl(session_key)
        if jsonl:
            title = read_session_title(jsonl, fallback=title)

        sessions.append({
            "id": f"crew-{session_key}",
            "source": "crew",
            "name": title[:50],
            "workspace": "",
            "group": "crew",
            "active": True,
            "event": None,
            "attention_source": None,
            "attention": False,
            "attention_reason": None,
            "tool": None,
            "file": None,
            "tokens": used,
            "maxTokens": window,
            "mtime": time.time(),
            "character": None,
            "attention_since": None,
            "on_overlay": False,
        })

    log(f"discovered {len(sessions)} sessions")
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
