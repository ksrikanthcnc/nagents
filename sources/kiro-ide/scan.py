#!/usr/bin/env python3
"""
Kiro IDE source scanner.

Discovers active IDE sessions from open Kiro windows.
Reads globalStorage/storage.json for open workspaces, then
reads state.vscdb for session tabs.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-ide/scan.py
"""
# App spawns scanners via system python (may be 3.9); keep annotations lazy so
# PEP 604 unions (`X | None`) don't blow up at import time.
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

HOME = Path.home()
APP_SUPPORT = HOME / "Library/Application Support/Kiro"
KIRO_SESSIONS_DIR = HOME / ".kiro/sessions"
GLOBAL_STORAGE = APP_SUPPORT / "User/globalStorage/storage.json"
WORKSPACE_STORAGE = APP_SUPPORT / "User/workspaceStorage"


def log(msg: str) -> None:
    """Log to stderr (stdout is reserved for JSON output)."""
    print(f"[kiro-ide] {msg}", file=sys.stderr)


def discover() -> list[dict]:
    """Return IDE sessions from currently-open windows."""
    sessions = []
    seen_ids: set = set()

    open_ws_dirs = get_open_workspace_dirs()
    if not open_ws_dirs:
        log("no open workspaces found")
        return sessions

    log(f"found {len(open_ws_dirs)} open workspaces")

    for ws_dir in open_ws_dirs:
        db_path = ws_dir / "state.vscdb"
        if not db_path.exists():
            continue

        ws_path = read_workspace_path(ws_dir)

        for tab in get_session_tabs(db_path):
            sid = tab.get("id", "")
            if not sid or sid in seen_ids:
                continue
            title = tab.get("title", "New Session")
            # Skip workflow step sessions — they're managed by discover_workflow_steps()
            # and should only appear when their workflow is running. Completed step
            # sessions linger as tabs but shouldn't clutter the overlay.
            if " · " in title and is_workflow_step_session(sid):
                continue
            seen_ids.add(sid)
            sessions.append(make_session(sid, title, ws_path))

    log(f"discovered {len(sessions)} sessions")

    # Discover running workflow step sessions. These appear as additional sessions
    # grouped with their parent (the session that launched the workflow).
    known_sids = set()
    for s in sessions:
        # Reconstruct full session ID for matching against parentSessionId.
        short = s["id"].replace("ide-", "")
        for hash_dir in KIRO_SESSIONS_DIR.iterdir():
            if not hash_dir.is_dir() or hash_dir.name == "cli":
                continue
            for sess_dir in hash_dir.iterdir():
                if sess_dir.name.startswith("sess_") and sess_dir.name[5:13] == short:
                    known_sids.add(sess_dir.name)
                    break

    wf_steps = discover_workflow_steps(known_sids)
    # Merge: skip workflow steps whose ID already exists in sessions (avoid dupes).
    existing_ids = {s["id"] for s in sessions}
    for step in wf_steps:
        if step["id"] not in existing_ids:
            sessions.append(step)

    if wf_steps:
        log(f"total after workflow steps: {len(sessions)}")

    return sessions


STALE_THRESHOLD_SEC = 3600 * 24  # 24h


def is_session_fresh(session_id: str) -> bool:
    """Check if a session has recent activity (messages.jsonl modified within threshold)."""
    # Search all hash dirs for this session's messages.jsonl
    for hash_dir in (HOME / ".kiro/sessions").iterdir():
        if not hash_dir.is_dir() or hash_dir.name == "cli":
            continue
        msg_file = hash_dir / session_id / "messages.jsonl"
        if msg_file.exists():
            age = time.time() - msg_file.stat().st_mtime
            return age < STALE_THRESHOLD_SEC
    # No messages file found — might be brand new, allow it
    return True


def get_open_workspace_dirs() -> list[Path]:
    """Read windowsState from global storage to find open workspaces."""
    if not GLOBAL_STORAGE.exists():
        log(f"global storage not found: {GLOBAL_STORAGE}")
        return []
    if not WORKSPACE_STORAGE.exists():
        log(f"workspace storage not found: {WORKSPACE_STORAGE}")
        return []

    try:
        data = json.loads(GLOBAL_STORAGE.read_text())
    except Exception as e:
        log(f"failed to read global storage: {e}")
        return []

    ws_state = data.get("windowsState", {})
    all_windows = []
    if ws_state.get("lastActiveWindow"):
        all_windows.append(ws_state["lastActiveWindow"])
    all_windows.extend(ws_state.get("openedWindows", []))

    open_folders: set = set()
    open_workspaces: set = set()
    for w in all_windows:
        if "folder" in w and w["folder"]:
            open_folders.add(w["folder"])
        if "workspaceIdentifier" in w:
            wid = w["workspaceIdentifier"]
            if "configURIPath" in wid:
                open_workspaces.add(wid["configURIPath"])
        if "workspace" in w and w["workspace"]:
            open_workspaces.add(w["workspace"])

    matched: list[Path] = []
    for ws_dir in WORKSPACE_STORAGE.iterdir():
        if not ws_dir.is_dir():
            continue
        ws_json = ws_dir / "workspace.json"
        if not ws_json.exists():
            continue
        try:
            ws_data = json.loads(ws_json.read_text())
            folder = ws_data.get("folder", "")
            workspace = ws_data.get("workspace", "")
            if folder in open_folders or workspace in open_workspaces:
                matched.append(ws_dir)
        except Exception:
            pass

    return matched


def get_session_tabs(db_path: Path) -> list[dict]:
    """Read session entries from a vscdb file."""
    try:
        conn = sqlite3.connect(str(db_path), timeout=2)
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = 'kiro.kiroAgent'"
        ).fetchone()
        conn.close()
        if not row:
            return []
        data = json.loads(row[0])
        entries = data.get("sessionPanels.entries", [])
        if not entries:
            entries = data.get("sessionPanels", {}).get("entries", [])
        return entries
    except Exception as e:
        log(f"failed to read {db_path}: {e}")
        return []


def read_workspace_path(ws_dir: Path) -> str:
    """Read workspace path from workspace.json."""
    ws_json = ws_dir / "workspace.json"
    if not ws_json.exists():
        return ""
    try:
        data = json.loads(ws_json.read_text())
        workspace = data.get("workspace", "")
        if workspace.startswith("file://"):
            ws_path = workspace[7:]
            if ws_path.endswith(".code-workspace"):
                # Multi-root workspace: use workspace file's parent as path
                # but group will use filename stem (handled in path_to_group)
                return ws_path
            return str(Path(ws_path).parent)
        folder = data.get("folder", "")
        if folder.startswith("file://"):
            return folder[7:]
        return folder
    except Exception:
        return ""


def find_session_created_at(session_id: str) -> float:
    """Find session.json and read createdAt. Returns epoch seconds or 0."""
    from datetime import datetime
    # Search for session folder (could be sess_<uuid> or bare <uuid>)
    for pattern in [f"*/sess_{session_id}", f"*/{session_id}"]:
        matches = list(KIRO_SESSIONS_DIR.glob(f"{pattern}/session.json"))
        if matches:
            try:
                data = json.loads(matches[0].read_text())
                ts = data.get("createdAt", "")
                if ts:
                    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            except Exception:
                pass
    # Fallback: try directory birth time (macOS)
    for pattern in [f"*/sess_{session_id}", f"*/{session_id}"]:
        dirs = list(KIRO_SESSIONS_DIR.glob(pattern))
        if dirs:
            try:
                return dirs[0].stat().st_birthtime
            except (AttributeError, OSError):
                pass
    return 0


def make_session(session_id: str, title: str, ws_path: str) -> dict:
    """Create a session dict matching the nagents contract."""
    ws_display = ws_path.replace(str(HOME), "~") if ws_path else ""
    group = path_to_group(ws_path)
    short_id = session_id.replace("sess_", "")[:8]

    # Try to read createdAt from session.json
    created_at = find_session_created_at(session_id)

    return {
        "id": f"ide-{short_id}",
        "source": "kiro-ide",
        "name": (title or "New Session")[:50],
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
        "maxTokens": 200000,
        "mtime": created_at,  # Session creation time (stable, doesn't change on scan)
        "character": None,
        "attention_since": None,
        "on_overlay": False,
    }


def path_to_group(ws_path: str) -> str:
    """Derive group name from workspace path."""
    if not ws_path:
        return "ide"
    p = Path(ws_path)
    # .code-workspace file → use filename stem as group
    if ws_path.endswith(".code-workspace"):
        return p.stem
    name = p.name
    if not name:
        return "ide"
    return name


def is_workflow_step_session(session_id: str) -> bool:
    """Check if a session is a workflow step by reading its session.json agentMode.
    Returns True if agentMode starts with 'wf-' (workflow step agents like wf-coder,
    wf-planner, semantic_reviewer running as a workflow step)."""
    for hash_dir in KIRO_SESSIONS_DIR.iterdir():
        if not hash_dir.is_dir() or hash_dir.name == "cli":
            continue
        sj = hash_dir / session_id / "session.json"
        if sj.exists():
            try:
                data = json.loads(sj.read_text())
                mode = data.get("agentMode", "")
                return mode.startswith("wf-") or mode == "semantic_reviewer"
            except Exception:
                return False
    return False


# ─── Workflow Discovery ──────────────────────────────────────────────────────

def discover_workflow_steps(known_session_ids: set[str]) -> list[dict]:
    """Discover running workflow step sessions from ~/.kiro/sessions/<hash>/workflows/.

    For each running workflow, checks if the parent session is already known
    (in the scanner's discovered sessions). If so, emits the step sessions
    with workflow metadata so nagents can group them with the parent.

    Args:
        known_session_ids: Set of full session IDs (e.g. "sess_2d2ea641-...")
            already discovered by the main scanner. Used to verify the parent
            is an active session in an open workspace.
    """
    steps: list[dict] = []

    for hash_dir in KIRO_SESSIONS_DIR.iterdir():
        if not hash_dir.is_dir() or hash_dir.name == "cli":
            continue
        wf_dir = hash_dir / "workflows"
        if not wf_dir.exists():
            continue

        for run_dir in wf_dir.iterdir():
            if not run_dir.is_dir() or not run_dir.name.startswith("wf_"):
                continue
            state_file = run_dir / "workflow-state.json"
            if not state_file.exists():
                continue

            try:
                state = json.loads(state_file.read_text())
            except Exception:
                continue

            if state.get("status") != "running":
                continue

            wf_id = state.get("workflowId", "")
            wf_name = state.get("workflowName", "workflow")
            wf_label = state.get("runLabel", wf_name)
            parent_sid = state.get("parentSessionId", "")
            workspace_path = state.get("workspacePath", "")

            # Only track workflows whose parent is a known active session.
            if parent_sid and parent_sid not in known_session_ids:
                continue

            parent_short = parent_sid.replace("sess_", "")[:8] if parent_sid else ""

            # Walk the node tree to find running step sessions.
            def walk_steps(node: dict) -> None:
                if node.get("type") == "step":
                    step_status = node.get("status", "pending")
                    step_sid = node.get("sessionId", "")
                    # Only emit steps that have a session (running). Pending steps
                    # don't have a session yet — they'll appear when they start.
                    if step_status == "running" and step_sid:
                        step_id = node.get("nodeId", "step")
                        agent = node.get("agentName", "wf-agent")

                        # Read step session.json for title
                        title = f"{wf_label} · {step_id}"
                        if step_sid:
                            sj = hash_dir / step_sid / "session.json"
                            if sj.exists():
                                try:
                                    sd = json.loads(sj.read_text())
                                    title = sd.get("title", title)
                                except Exception:
                                    pass

                        short_id = step_sid.replace("sess_", "")[:8] if step_sid else step_id[:8]
                        group = path_to_group(workspace_path) if workspace_path else "ide"

                        steps.append({
                            "id": f"ide-{short_id}",
                            "source": "kiro-ide",
                            "name": title[:50],
                            "workspace": workspace_path.replace(str(HOME), "~") if workspace_path else "",
                            "group": group,
                            "active": True,
                            "event": "running" if step_status == "running" else None,
                            "attention_source": None,
                            "attention": False,
                            "attention_reason": None,
                            "tool": None,
                            "file": None,
                            "tokens": 0,
                            "maxTokens": 200000,
                            "mtime": time.time(),  # Use current time so it's always "fresh"
                            "character": None,
                            "attention_since": None,
                            "on_overlay": False,
                            # Workflow metadata (consumed by nagents backend)
                            "workflow_id": wf_id,
                            "workflow_name": wf_label,
                            "workflow_step_id": step_id,
                            "workflow_step_agent": agent,
                            "workflow_parent_id": f"ide-{parent_short}" if parent_short else None,
                        })

                for child in node.get("children", []):
                    walk_steps(child)

            walk_steps(state.get("root", {}))

    if steps:
        log(f"discovered {len(steps)} running workflow step(s)")
    return steps


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
