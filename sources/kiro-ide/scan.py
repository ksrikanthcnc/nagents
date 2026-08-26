#!/usr/bin/env python3
"""
Kiro IDE source scanner.

Discovers active IDE sessions from open Kiro windows.
Reads globalStorage/storage.json for open workspaces, then
reads state.vscdb for session tabs.

Outputs JSON array to stdout (consumed by nagents Rust backend).

Usage: python3 sources/kiro-ide/scan.py
"""

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
            seen_ids.add(sid)
            title = tab.get("title", "New Session")
            sessions.append(make_session(sid, title, ws_path))

    log(f"discovered {len(sessions)} sessions")
    return sessions


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


def main():
    sessions = discover()
    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
