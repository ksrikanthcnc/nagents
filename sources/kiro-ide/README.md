# Source: kiro-ide

Discovers Kiro IDE sessions from open windows.

## Scanner

`scan.py` — runs periodically (default: 5s).

Reads:
- `~/Library/Application Support/Kiro/User/globalStorage/storage.json` → finds open windows
- `~/Library/Application Support/Kiro/User/workspaceStorage/*/state.vscdb` → finds session tabs

Outputs: JSON array of sessions to stdout.

## Hook

IDE hooks push events via HTTP `POST /event` to the nagents server.

Hook events are triggered by Kiro's agent hook system (`.kiro/hooks/`).
The hook translates trigger events (PreToolUse, PostToolUse, Stop, UserPromptSubmit)
into nagents EventUpdate format.

See `../../docs/SOURCE_CONTRACT.md` for the full schema.

## Platform

Currently macOS only (hardcoded `~/Library/Application Support/Kiro` path).
Linux/Windows would need different paths for the storage location.
