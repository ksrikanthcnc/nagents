#!/usr/bin/env python3
"""
Kiro CLI v3 source scanner.

Discovers active v3 CLI sessions via ps detection.
v3 sessions run as: kiro-cli-chat chat --v3

v3 session IDs have `sess_` prefix. They create:
  - ~/.kiro/sessions/cli/sess_<uuid>.history (input history)
  - ~/.kiro/sessions/<hash>/sess_<uuid>/session.json (full session metadata)

ID scheme: cli3-{uuid[:8]} (stripping sess_ prefix)
When session can't be resolved, falls back to cli3-{pid}.

Titles come from: data/titles.json (POST /title) > session.json > fallback PID.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-cli-v3/scan.py
"""

import json
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
KIRO_SESSIONS_DIR = HOME / ".kiro/sessions"
TITLES_FILE = Path(__file__).parent.parent.parent / "data/titles.json"


def log(msg: str) -> None:
    print(f"[kiro-cli-v3] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active v3 CLI sessions."""
    sessions = []
    seen_pids: set[str] = set()
    titles_override = load_titles()

    ps_lines = get_ps_lines()

    # Find all v3 processes
    v3_procs: list[tuple[str, str]] = []  # (pid, cwd)

    for line in ps_lines:
        if "kiro-cli-chat" not in line or "grep" in line:
            continue

        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, cmd = parts[0], parts[1]

        if "kiro-cli-chat chat" not in cmd:
            continue
        if "--v3" not in cmd:
            continue
        if "acp" in cmd:
            continue
        if cmd.startswith("zsh"):
            continue

        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        cwd = get_process_cwd(pid)
        v3_procs.append((pid, cwd))

    # Find v3 session IDs from .history files (sess_ prefix = v3)
    v3_session_ids = find_v3_sessions()

    # Try to map processes to sessions
    # If only one v3 process and one active v3 session, they match.
    # Otherwise fall back to PID-based IDs.
    if len(v3_procs) == 1 and len(v3_session_ids) >= 1:
        # Single process — use most recent v3 session
        pid, cwd = v3_procs[0]
        sess_id = v3_session_ids[0]  # most recent
        uuid = sess_id.replace("sess_", "")
        title = read_session_title(sess_id)
        nagents_id = f"cli3-{uuid[:8]}"
        display_title = resolve_title(nagents_id, titles_override) or title or f"CLI v3 ({pid})"

        sessions.append(make_session(nagents_id, display_title, cwd))

    elif len(v3_procs) > 1:
        # Multiple processes — can't reliably map. Use PID-based IDs.
        # But if we have matching count of sessions, try by recency order.
        if len(v3_session_ids) >= len(v3_procs):
            # Sort procs by PID (older PIDs = older sessions usually)
            # and sessions by recency — but this is fragile. Use PID for safety.
            for pid, cwd in v3_procs:
                nagents_id = f"cli3-{pid}"
                display_title = resolve_title(nagents_id, titles_override) or f"CLI v3 ({pid})"
                sessions.append(make_session(nagents_id, display_title, cwd))
        else:
            for pid, cwd in v3_procs:
                nagents_id = f"cli3-{pid}"
                display_title = resolve_title(nagents_id, titles_override) or f"CLI v3 ({pid})"
                sessions.append(make_session(nagents_id, display_title, cwd))

    log(f"discovered {len(sessions)} sessions")
    return sessions


def find_v3_sessions() -> list[str]:
    """
    Find v3 session IDs from .history files with sess_ prefix.
    Returns sorted by most recent modification first.
    """
    if not CLI_SESSIONS_DIR.exists():
        return []

    candidates = []
    for f in CLI_SESSIONS_DIR.glob("sess_*.history"):
        candidates.append((f.stat().st_mtime, f.stem))

    candidates.sort(reverse=True)
    return [sess_id for _, sess_id in candidates]


def read_session_title(sess_id: str) -> str:
    """Read title from ~/.kiro/sessions/<hash>/<sess_id>/session.json."""
    if not KIRO_SESSIONS_DIR.exists():
        return ""

    # Search all hash dirs for this session
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


def make_session(nagents_id: str, title: str, cwd: str) -> dict:
    """Create a session dict matching the nagents SOURCE_CONTRACT."""
    return {
        "id": nagents_id,
        "source": "kiro-cli-v3",
        "name": title[:50],
        "workspace": cwd.replace(str(HOME), "~") if cwd else "",
        "group": "cli",
        "active": True,
        "event": None,
        "attention_source": None,
        "attention": False,
        "attention_reason": None,
        "tool": None,
        "file": None,
        "tokens": 0,
        "maxTokens": 1000000,
        "mtime": 0,  # Don't update mtime from scanner — hooks manage it via push_event
        "character": None,
        "attention_since": None,
        "on_overlay": False,
    }


def get_ps_lines() -> list[str]:
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,command"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.splitlines()
    except Exception as e:
        log(f"ps failed: {e}")
        return []


def get_process_cwd(pid: str) -> str:
    """Get working directory of a process via lsof."""
    try:
        result = subprocess.run(
            ["lsof", "-p", pid, "-a", "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=3
        )
        for line in result.stdout.splitlines():
            if line.startswith("n") and line[1:].startswith("/"):
                return line[1:]
    except Exception:
        pass
    return ""


def load_titles() -> dict:
    """Load user-assigned title overrides."""
    if TITLES_FILE.exists():
        try:
            return json.loads(TITLES_FILE.read_text())
        except Exception:
            pass
    return {}


def resolve_title(session_id: str, titles: dict) -> str:
    """Check if there's a title override (exact or prefix match)."""
    if session_id in titles:
        return titles[session_id]
    for key, title in titles.items():
        if session_id.startswith(key):
            return title
    return ""


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
