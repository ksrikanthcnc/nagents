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
