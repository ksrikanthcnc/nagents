#!/usr/bin/env python3
"""
Set a human-readable title for a nagents session.

Usage:
  python3 sources/set-title.py <session_id_prefix> <title>
  python3 sources/set-title.py list

Examples:
  python3 sources/set-title.py cli2-2ccd k-v2
  python3 sources/set-title.py cli3-4875 "my v3 session"
  python3 sources/set-title.py list

The titles are stored in sources/titles.json and used by scanners
to override auto-detected titles.
"""

import json
import sys
from pathlib import Path

TITLES_FILE = Path(__file__).parent / "titles.json"


def load() -> dict:
    if TITLES_FILE.exists():
        return json.loads(TITLES_FILE.read_text())
    return {}


def save(titles: dict) -> None:
    TITLES_FILE.write_text(json.dumps(titles, indent=2) + "\n")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "list":
        titles = load()
        if not titles:
            print("No titles set.")
        for sid, title in titles.items():
            print(f"  {sid:20s} → {title}")
        sys.exit(0)

    if sys.argv[1] == "rm" and len(sys.argv) >= 3:
        titles = load()
        prefix = sys.argv[2]
        removed = [k for k in titles if k.startswith(prefix)]
        for k in removed:
            del titles[k]
        save(titles)
        print(f"Removed {len(removed)} title(s).")
        sys.exit(0)

    if len(sys.argv) < 3:
        print("Usage: set-title.py <session_id_prefix> <title>")
        sys.exit(1)

    session_prefix = sys.argv[1]
    title = " ".join(sys.argv[2:])

    titles = load()
    titles[session_prefix] = title
    save(titles)
    print(f"Set: {session_prefix} → {title}")


if __name__ == "__main__":
    main()
