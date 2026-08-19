#!/usr/bin/env python3
"""
Kiro CLI v2 source scanner.

Discovers active v2 CLI sessions via ps detection.
v2 sessions run as: kiro-cli-chat chat --resume-id <uuid>

The --resume-id UUID maps directly to session files in ~/.kiro/sessions/cli/
which contain title, cwd, timestamps.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-cli-v2/scan.py
"""

import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
CLI_SESSIONS_DIR = HOME / ".kiro/sessions/cli"
TITLES_FILE = Path(__file__).parent.parent.parent / "data/titles.json"


def log(msg: str) -> None:
    print(f"[kiro-cli-v2] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active v2 CLI sessions."""
    sessions = []
    seen_pids: set[str] = set()
    titles_override = load_titles()

    ps_lines = get_ps_lines()

    for line in ps_lines:
        if "kiro-cli-chat" not in line or "grep" in line:
            continue

        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, cmd = parts[0], parts[1]

        # Must be: kiro-cli-chat chat --resume-id <uuid>
        if "kiro-cli-chat chat" not in cmd:
            continue
        if "--resume-id" not in cmd:
            continue
        # Skip crew sub-agents
        if "acp" in cmd:
            continue
        # Skip shell wrappers
        if cmd.startswith("zsh"):
            continue

        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        # Extract session UUID
        session_id = extract_resume_id(cmd)
        if not session_id:
            continue

        title, cwd, mtime = enrich(session_id)

        session_nagents_id = f"cli2-{session_id[:8]}"
        display_title = resolve_title(session_nagents_id, titles_override) or title or f"CLI ({session_id[:8]})"

        sessions.append({
            "id": session_nagents_id,
            "source": "kiro-cli-v2",
            "name": display_title[:50],
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
            "mtime": mtime,
            "character": None,
            "attention_since": None,
            "on_overlay": False,
        })

    log(f"discovered {len(sessions)} sessions")
    return sessions


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


def extract_resume_id(cmd: str) -> str:
    """Extract UUID from --resume-id argument."""
    try:
        return cmd.split("--resume-id")[1].strip().split()[0]
    except (IndexError, ValueError):
        return ""


def enrich(session_id: str) -> tuple[str, str, float]:
    """Get title, cwd, mtime from session file."""
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
    """Filter out non-user titles (system prompts, memory agents)."""
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
    # Prefix match
    for key, title in titles.items():
        if session_id.startswith(key):
            return title
    return ""


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
