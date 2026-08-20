"""
Shared hook translation logic for all sources.

Converts raw Kiro hook payloads into nagents EventUpdate dicts.
Used by kiro-ide/hook.py, kiro-cli-v2/hook.py, kiro-cli-v3/hook.py.
"""

import json
import re
import time
from pathlib import Path

HOME = str(Path.home())


def translate(trigger: str, payload: dict, session_id: str) -> dict | None:
    """Translate a Kiro hook event to nagents EventUpdate."""
    if not session_id:
        return None

    tool_name = payload.get("tool_name", "") or payload.get("toolName", "")
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_response = payload.get("tool_response", "")

    if trigger == "PreToolUse":
        file_path = extract_file(tool_name, tool_input)
        return {
            "session_id": session_id,
            "event": "tool",
            "tool": tool_name or "unknown",
            "file": shorten_path(file_path),
            "mtime": time.time(),
        }

    elif trigger == "PostToolUse":
        update: dict = {
            "session_id": session_id,
            "event": "running",
            "tool": "",        # clear
            "file": "",        # clear
            "mtime": time.time(),
        }

        # Extract exit status for execute_bash
        if tool_name == "execute_bash":
            update["tool_ok"] = parse_exit_code(tool_response)

        # Extract task progress from todo_list
        elif tool_name == "todo_list":
            result = parse_todo_result(tool_response)
            if result:
                update["tool_result"] = result

        # Extract description/status from update_session_information
        elif tool_name == "update_session_information":
            desc = tool_input.get("description")
            status = tool_input.get("status")
            if desc:
                update["description"] = desc
            if status:
                update["status"] = status

        return update

    elif trigger == "Stop":
        return {
            "session_id": session_id,
            "event": "idle",
            "attention": True,
            "priority": "low",
            "tool": "",        # clear
            "file": "",        # clear
            "tool_result": "", # clear
            "mtime": time.time(),
        }

    elif trigger == "UserPromptSubmit":
        prompt = payload.get("prompt", "")
        return {
            "session_id": session_id,
            "event": "running",
            "attention": False,
            "prompt": prompt or "",
            "tool": "",         # clear stale
            "file": "",         # clear stale
            "tool_result": "",  # clear stale
            "description": "",  # clear stale
            "status": "",       # clear stale
            "priority": "",     # clear
            "mtime": time.time(),
        }

    return None


def extract_file(tool_name: str, tool_input: dict) -> str | None:
    """Extract relevant display info from tool_input per tool type."""
    if tool_name == "execute_bash":
        cmd = tool_input.get("command", "")
        parts = re.split(r'&&|\|\||[|;&]', cmd)
        cmds = []
        for part in parts:
            words = part.strip().split()
            if not words:
                continue
            first_word = words[0].split("/")[-1]
            if first_word == "cd" or "=" in first_word:
                continue
            if first_word and first_word not in cmds:
                cmds.append(first_word)
        return ",".join(cmds[:4]) if cmds else cmd[:30]

    elif tool_name in ("read_file", "read_code", "str_replace", "fs_write", "fs_append", "delete_file"):
        return tool_input.get("path") or tool_input.get("targetFile")

    elif tool_name in ("grep_search", "file_search"):
        return tool_input.get("query")

    elif tool_name == "list_directory":
        return tool_input.get("path")

    elif tool_name == "todo_list":
        return f"todo:{tool_input.get('command', '')}"

    elif tool_name == "update_session_information":
        return tool_input.get("title") or tool_input.get("status")

    else:
        return tool_input.get("path") or tool_input.get("query")


def parse_exit_code(tool_response: str) -> bool | None:
    """Parse exit code from execute_bash tool_response."""
    if not tool_response:
        return None
    idx = tool_response.rfind("Exit Code: ")
    if idx == -1:
        return None
    try:
        code = int(tool_response[idx + 11:].strip().split()[0])
        return code == 0
    except (ValueError, IndexError):
        return None


def parse_todo_result(tool_response: str) -> str:
    """Parse todo_list response into 'done/total: current_task' format."""
    if not tool_response:
        return ""
    try:
        data = json.loads(tool_response)
        tasks = data.get("tasks", [])
        if not tasks:
            return ""
        total = len(tasks)
        done = sum(1 for t in tasks if t.get("completed"))
        current = ""
        for t in tasks:
            if not t.get("completed"):
                current = t.get("task_description", "")[:40]
                break
        if current:
            return f"{done}/{total}: {current}"
        return f"{done}/{total}"
    except (json.JSONDecodeError, TypeError):
        return ""


def shorten_path(path: str | None) -> str | None:
    """Shorten absolute path for display."""
    if not path:
        return None
    if path.startswith(HOME):
        path = path[len(HOME) + 1:]
    for prefix in ("work/tasks/", "work/git/", "work/worktree/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    return path
