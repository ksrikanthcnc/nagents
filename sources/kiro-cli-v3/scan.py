#!/usr/bin/env python3
"""
Kiro CLI v3 source scanner.

Discovers active v3 CLI sessions via ps detection.
v3 sessions run as: kiro-cli-chat chat --v3

v3 doesn't use --resume-id or write session files to ~/.kiro/sessions/cli/.
Instead, conversation state is in SQLite:
  ~/Library/Application Support/kiro-cli/data.sqlite3 (conversations_v2 table)

Title is extracted from the first user prompt in the conversation.
CWD is obtained from lsof.

ID scheme: cli3-{conversation_id[:8]}
If conversation can't be resolved, falls back to cli3-{pid}.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-cli-v3/scan.py
"""

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CLI_DB = HOME / "Library/Application Support/kiro-cli/data.sqlite3"


def log(msg: str) -> None:
    print(f"[kiro-cli-v3] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return active v3 CLI sessions."""
    sessions = []
    seen_pids: set[str] = set()

    ps_lines = get_ps_lines()

    # Collect all v3 processes first to detect CWD collisions
    v3_procs: list[tuple[str, str]] = []  # (pid, cwd)

    for line in ps_lines:
        if "kiro-cli-chat" not in line or "grep" in line:
            continue

        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, cmd = parts[0], parts[1]

        # Must be: kiro-cli-chat chat --v3
        if "kiro-cli-chat chat" not in cmd:
            continue
        if "--v3" not in cmd:
            continue
        # Skip crew processes
        if "acp" in cmd:
            continue
        # Skip shell wrappers
        if cmd.startswith("zsh"):
            continue

        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        cwd = get_process_cwd(pid)
        v3_procs.append((pid, cwd))

    # Detect CWD collisions — if multiple v3 procs share a CWD,
    # we can't uniquely map them to conversations. Use PID-based IDs.
    cwd_counts: dict[str, int] = {}
    for _, cwd in v3_procs:
        cwd_counts[cwd] = cwd_counts.get(cwd, 0) + 1

    for pid, cwd in v3_procs:
        has_collision = cwd_counts.get(cwd, 0) > 1

        if has_collision:
            # Can't distinguish — use PID-based ID
            session_id = pid
            title = ""
        else:
            conv_id, title = resolve_conversation(cwd)
            session_id = conv_id[:8] if conv_id else pid

        sessions.append({
            "id": f"cli3-{session_id}",
            "source": "kiro-cli-v3",
            "name": (title or f"CLI v3 ({pid})")[:50],
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
            "mtime": time.time(),
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


def resolve_conversation(cwd: str) -> tuple[str, str]:
    """
    Find the most recent conversation for a given CWD from SQLite.

    Returns (conversation_id, title).
    Title is the first user prompt in the conversation.
    """
    if not cwd or not CLI_DB.exists():
        return "", ""

    try:
        conn = sqlite3.connect(str(CLI_DB), timeout=2)
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute(
            "SELECT conversation_id, value FROM conversations_v2 "
            "WHERE key = ? ORDER BY updated_at DESC LIMIT 1",
            (cwd,)
        ).fetchone()
        conn.close()

        if not row:
            return "", ""

        conv_id, raw_value = row
        title = extract_title(raw_value)
        return conv_id, title

    except Exception as e:
        log(f"sqlite query failed: {e}")
        return "", ""


def extract_title(raw_value: str) -> str:
    """Extract a meaningful user prompt from a conversation JSON as title."""
    try:
        data = json.loads(raw_value)
        history = data.get("history", [])
        for msg in history:
            if "user" not in msg:
                continue
            user = msg["user"]
            content = user.get("content", "")

            # v3 format: content is {"Prompt": {"prompt": "..."}}
            if isinstance(content, dict):
                if "Prompt" in content:
                    text = content["Prompt"].get("prompt", "")
                elif "prompt" in content:
                    text = content["prompt"]
                else:
                    continue
            elif isinstance(content, str):
                text = content
            else:
                continue

            title = clean_title(text)
            if title:
                return title
            # If this message was filtered (JSON blob, etc.), try next user msg
    except Exception:
        pass
    return ""


def clean_title(raw: str) -> str:
    """Clean and truncate a title."""
    if not raw:
        return ""
    # Skip JSON blobs, system prompts
    if raw.startswith("{") or raw.startswith("[AGENT"):
        return ""
    # Take first line only
    raw = raw.split("\n")[0].strip()
    if len(raw) > 60:
        raw = raw[:57] + "..."
    return raw


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
