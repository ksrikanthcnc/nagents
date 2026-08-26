# Sources

Each folder here is a **source plugin** — a self-contained module that discovers
sessions from one agent system and reports them to the nagents backend.

## How sources work

1. Nagents's Rust backend calls your scanner command periodically
2. Your scanner outputs JSON to stdout
3. Nagents normalizes and stores the sessions in memory
4. The panel and overlay react to state changes

## Creating a new source

1. Create a folder: `sources/<your-source>/`
2. Write a scanner script (any language: Python, shell, Node, Go, Rust...)
3. Register it in `config.yaml`:
   ```yaml
   sources:
     your-source:
       scanner: "python3 sources/your-source/scan.py"
       interval_sec: 5
       hook: true  # optional: accept pushes via POST /event
   ```
4. Your scanner outputs JSON matching the contract (see `docs/SOURCE_CONTRACT.md`)
5. That's it!

## Existing sources

| Source | Scanner | Hook | Notes |
|--------|---------|------|-------|
| kiro-ide | `scan.py` | Yes | Reads Kiro storage + vscdb |
| kiro-crew | `scan.py` | No | Reads context_snapshots.json |

## Adding more

- `kiro-cli-v2/` — CLI v2 sessions (reads session files)
- `kiro-cli-v3/` — CLI v3 sessions (reads session files)
- `copilot/` — GitHub Copilot sessions (if detectable)
- `cursor/` — Cursor AI sessions (if detectable)

Just follow the contract. Any language, any method of discovery.


## Setting session titles (CLI)

Type `nagents:<session_id>:<group>:<title>` anywhere in a prompt to set a session's title and group.

**Find your session ID:** Run `/session-id` in the CLI terminal.

**Format:** `nagents:<sess_id>:<group>:<title>`

**Examples:**
```
nagents:sess_ca95a60c-b0d6-49dc:k8s:deploy-monitor
→ group: v3:k8s, title: deploy-monitor

ignore this nagents:ca95a60c::my-project
→ group: v3 (default), title: my-project

nagents:sess_ca95a60c::
→ RESET (removes manual title, back to defaults)
```

**Behavior:**
- Works from any session (IDE, CLI v2, CLI v3)
- Searches anywhere in the prompt (prefix with "ignore this" so the agent skips it)
- Group is prepended with source type: `v2:k8s`, `v3:k8s`, `ide:nagents`
- Title persists in `data/sessions.json` until explicitly reset
- Reset: send `nagents:<sess_id>::` (both group and title empty)

**Display fallback (when no manual title):**
- IDE: session name from Kiro (e.g. "data", "app")
- CLI: latest prompt text (updates every message)
- Fallback: session ID prefix (e.g. "2ccd6071")
