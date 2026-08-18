# Source: kiro-crew

Discovers Kiro Crew sessions from `~/.kiro/crew/`.

## Scanner

`scan.py` — runs periodically (default: 10s).

Reads:
- `~/.kiro/crew/context_snapshots.json` → active sessions with token usage
- `~/.kiro/crew/sessions/*.jsonl` → session titles (from metadata line)

Outputs: JSON array of sessions to stdout.

## No Hook (yet)

Crew sessions don't have a hook mechanism currently.
The scanner provides the full state each cycle.

## Notes

- Token usage (`used_tokens` / `window_tokens`) is tracked for context pressure
- Session titles are read from the JSONL metadata line if available
- All sessions are reported as active (no way to detect idle crew sessions currently)
