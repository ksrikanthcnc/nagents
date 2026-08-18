#!/usr/bin/env python3
"""
Kiro CLI source scanner (v2 + v3 combined).

Discovers active CLI sessions:
  - v2: lock files with alive PIDs + `kiro-cli-chat chat --resume-id <uuid>`
  - v3: `kiro-cli-chat chat --v3` processes (no lock files)

Filters OUT crew sub-agents (kiro-cli-chat acp ...) — those are covered
by the kiro-crew source scanner.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-cli/scan.py
"""

import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"


def log(msg: str) -> None:
    """Log to stderr (stdout is reserved for JSON output)."""
    print(f"[kiro-cli] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active CLI sessions (v2 + v3, excluding crew sub-agents)."""
    sessions = []
    seen_pids: set[str] = set()

    # Get all kiro-cli-chat processes
    ps_lines = get_ps_lines()

    # --- v2: lock files with alive PIDs ---
    v2_sessions = discover_v2(ps_lines, seen_pids)
    sessions.extend(v2_sessions)

    # --- v3: ps-based detection ---
    v3_sessions = discover_v3(ps_lines, seen_pids)
    sessions.extend(v3_sessions)

    log(f"discovered {len(sessions)} sessions (v2={len(v2_sessions)}, v3={len(v3_sessions)})")
    return sessions


def get_ps_lines() -> list[str]:
    """Get all process lines from ps."""
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,command"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.splitlines()
    except Exception as e:
        log(f"ps failed: {e}")
        return []


def discover_v2(ps_lines: list[str], seen_pids: set[str]) -> list[dict]:
    """
    Discover v2 sessions via ps detection.

    v2 sessions run as: kiro-cli-chat chat --resume-id <uuid>
    The --resume-id maps directly to a session file in CLI_SESSIONS_DIR.
    """
    sessions = []

    for line in ps_lines:
        if "kiro-cli-chat" not in line or "grep" in line:
            continue
        if "chat" not in line or "--resume-id" not in line:
            continue
        # Skip crew processes
        if "acp" in line:
            continue

        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, cmd = parts[0], parts[1]

        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        # Extract session UUID from --resume-id
        session_id = ""
        try:
            session_id = cmd.split("--resume-id")[1].strip().split()[0]
        except (IndexError, ValueError):
            pass

        if session_id:
            title, cwd, mtime = enrich_from_session_file(session_id)
        else:
            title, cwd, mtime = "", "", time.time()

        sessions.append(make_session(
            session_id=session_id or pid,
            pid=pid,
            title=title or f"CLI ({session_id[:8] if session_id else pid})",
            cwd=cwd,
            mtime=mtime,
            version="v2",
        ))

    return sessions


def discover_v3(ps_lines: list[str], seen_pids: set[str]) -> list[dict]:
    """Discover v3 sessions via ps (kiro-cli-chat chat --v3)."""
    sessions = []

    for line in ps_lines:
        if "kiro-cli-chat" not in line or "grep" in line:
            continue
        if "chat" not in line or "--v3" not in line:
            continue
        # Skip crew processes
        if "acp" in line:
            continue

        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid = parts[0]

        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        # v3 doesn't write lock files, so we can't directly map PID→session.
        # Try to find a recently-active session file that might belong to this process.
        title, cwd, mtime, session_id = find_v3_session(pid)

        sessions.append(make_session(
            session_id=session_id or pid,
            pid=pid,
            title=title or f"CLI v3 ({pid})",
            cwd=cwd,
            mtime=mtime,
            version="v3",
        ))

    return sessions


def find_v3_session(pid: str) -> tuple[str, str, float, str]:
    """
    Attempt to find the session file for a v3 process.

    v3 processes don't have lock files or --resume-id in args.
    Best effort: check lsof for open files, or find recently-modified
    session files without lock files.
    """
    # Strategy: find session files modified recently that don't have
    # corresponding lock files (those are v2). A v3 session will be
    # actively writing to its session file.
    title = ""
    cwd = ""
    mtime = time.time()
    session_id = ""

    if not CLI_SESSIONS_DIR.exists():
        return title, cwd, mtime, session_id

    # Get sessions that have lock files (v2-claimed)
    locked_sessions = {f.stem for f in CLI_SESSIONS_DIR.glob("*.lock")}

    # Find recently-modified session files not claimed by v2
    candidates = []
    for f in CLI_SESSIONS_DIR.glob("*.json"):
        if f.stem in locked_sessions:
            continue
        # Only consider files modified in the last hour (likely active)
        stat = f.stat()
        age_sec = time.time() - stat.st_mtime
        if age_sec < 3600:
            candidates.append((stat.st_mtime, f))

    if not candidates:
        return title, cwd, mtime, session_id

    # Sort by most recently modified
    candidates.sort(reverse=True)

    # Take the most recent unclaimed session
    # (If multiple v3 sessions exist, this is approximate — but better than nothing)
    _, session_file = candidates[0]
    session_id = session_file.stem

    title, cwd, mtime = enrich_from_session_file(session_id)
    return title, cwd, mtime, session_id





def enrich_from_session_file(session_id: str) -> tuple[str, str, float]:
    """Get title, cwd, mtime from a session JSON file."""
    title = ""
    cwd = ""
    mtime = time.time()

    session_file = CLI_SESSIONS_DIR / f"{session_id}.json"
    if not session_file.exists():
        return title, cwd, mtime

    try:
        data = json.loads(session_file.read_text())
        raw_title = data.get("title") or ""
        # Clean up titles: skip system prompt prefixes, memory agent prompts, etc.
        title = clean_title(raw_title)
        cwd = data.get("cwd", "")
        ts = data.get("updated_at", "")
        if ts:
            mtime = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception as e:
        log(f"failed to read session {session_id}: {e}")

    return title, cwd, mtime


def clean_title(raw: str) -> str:
    """Clean up a session title — skip agent system prompts, memory prompts, etc."""
    if not raw:
        return ""
    # Skip known non-user titles
    skip_prefixes = [
        "[AGENT SYSTEM PROMPT]",
        "You are a memory consolidation agent",
        "First, decide: is the following text",
        "[SESSION CONTEXT",
    ]
    for prefix in skip_prefixes:
        if raw.startswith(prefix):
            return ""
    # Truncate long titles
    if len(raw) > 60:
        raw = raw[:57] + "..."
    return raw


def make_session(
    session_id: str,
    pid: str,
    title: str,
    cwd: str,
    mtime: float,
    version: str,
) -> dict:
    """Create a session dict matching the nagents SOURCE_CONTRACT."""
    ws_display = cwd.replace(str(HOME), "~") if cwd else ""
    group = "cli"

    return {
        "id": f"cli-{pid}",
        "source": "kiro-cli",
        "name": title[:50],
        "workspace": ws_display,
        "group": group,
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
    }


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
