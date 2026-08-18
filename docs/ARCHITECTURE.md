# nagents — Architecture

## What is nagents?

Small animated characters that live on your screen and follow your cursor
when AI agent sessions need your attention. A control center panel shows
all sessions; those needing attention pop out as overlay characters.

## System Design

```
┌─────────────────────────────────────────────────────────────────┐
│  SOURCES (any language)                                          │
│  sources/kiro-ide/scan.py  — discovers IDE sessions              │
│  sources/kiro-crew/scan.py — discovers Crew sessions             │
│  ... (anyone adds new sources)                                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ JSON stdout / HTTP POST
┌──────────────────────────────▼──────────────────────────────────┐
│  RUST BACKEND (src-tauri/)                                       │
│  Single process: Tauri app                                       │
│                                                                  │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────────┐ │
│  │ scanner │  │ server   │  │ attention │  │ overlay         │ │
│  │ spawns  │  │ HTTP     │  │ hybrid    │  │ cursor broadcast│ │
│  │ sources │  │ endpoint │  │ rules     │  │ window mgmt     │ │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └─────────────────┘ │
│       │             │              │                              │
│       └─────────────┼──────────────┘                             │
│                     ▼                                            │
│            ┌───────────────┐                                     │
│            │ state.rs      │  In-memory HashMap<id, Session>     │
│            │ field ownership│  Scanner owns meta, hooks own events│
│            └───────┬───────┘                                     │
│                    │ Tauri events + commands                      │
└────────────────────┼────────────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (ui/)                                                  │
│                                                                  │
│  ┌───────────────────────┐   ┌────────────────────────────────┐ │
│  │ Panel (index.html)    │   │ Overlay (overlay.html)         │ │
│  │ Control center        │   │ Transparent fullscreen         │ │
│  │ Grouped sessions      │   │ Chars follow cursor            │ │
│  │ Shows all sessions    │   │ Only attention sessions        │ │
│  └───────────────────────┘   └────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Characters (ui/characters/)                                 │ │
│  │ Self-contained plugins: SVG + manifest + CSS animations     │ │
│  │ Anyone adds new characters following the interface          │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Single Process
Everything runs in one Tauri app. No separate daemon, no file-based state,
no bridge scripts. The Rust backend IS the server.

### Language-Agnostic Sources
Sources are external executables. Python, shell, Go — anything that outputs
JSON to stdout. The Rust backend spawns them periodically and parses output.

### Hybrid Attention
- Sources CAN explicitly set `attention_source: true/false`
- If they don't (null), core rules apply: stuck detection, idle threshold, waiting statuses
- Core rules are configurable in config.yaml

### Field Ownership
Scanner and hooks update different fields. Neither overwrites the other.
See `docs/SOURCE_CONTRACT.md` for the full breakdown.

### Plugin Architecture
- **Characters**: drop a folder in `ui/characters/<id>/`, implement CharacterDef
- **Sources**: drop a folder in `sources/<id>/`, write any executable, register in config
- Both are self-contained, documented, and independently deployable

### Config Hot-Reload
`config.yaml` is watched by the Rust backend. Changes take effect within seconds
without restarting the app.

## Data Flow

```
1. Scanner spawns source executable (every N seconds)
2. Source outputs JSON array of sessions to stdout
3. scanner.rs parses JSON, calls store.push_sessions()
4. state.rs merges: updates meta fields, preserves hook fields, GCs dead sessions
5. attention.rs runs every 5s: computes attention per session
6. Frontend polls state (1.5s) via Tauri command or HTTP GET /state
7. Panel renders all sessions grouped
8. Overlay renders only attention=true sessions following cursor
```

## File Structure

```
nagents/
├── src-tauri/src/       ← Rust backend
│   ├── lib.rs           ← Entry + Tauri setup
│   ├── state.rs         ← Session store (HashMap, merge logic)
│   ├── config.rs        ← YAML config + hot-reload
│   ├── attention.rs     ← Hybrid attention computation
│   ├── scanner.rs       ← Spawns source executables
│   ├── server.rs        ← HTTP endpoint (hooks, state queries)
│   └── overlay.rs       ← Overlay window + cursor broadcast
├── ui/                  ← TypeScript frontend
│   ├── main.ts          ← Panel entry
│   ├── overlay-entry.ts ← Overlay entry
│   ├── panel/           ← Control center UI
│   ├── overlay/         ← Overlay physics + rendering
│   ├── characters/      ← Character plugins
│   │   ├── types.ts     ← CharacterDef interface
│   │   ├── registry.ts  ← Character lookup
│   │   ├── ghost/       ← Ghost character
│   │   └── cat/         ← Cat character
│   └── shared/          ← Types + bridge
├── sources/             ← Source plugins (any language)
│   ├── kiro-ide/        ← IDE scanner
│   └── kiro-crew/       ← Crew scanner
├── docs/                ← Contract documentation
├── config.yaml          ← User config (hot-reloaded)
├── index.html           ← Panel window
├── overlay.html         ← Overlay window
└── start.sh             ← Process management
```

## Cross-Platform

- macOS: CGEvent for cursor position (proven in v6)
- Windows: GetCursorPos (win32)
- Linux: placeholder (X11/Wayland TBD)
- Frontend: pure web, identical everywhere
- Tauri: builds native binary for all three

## Future Agents

- **data agent**: writes new source plugins, improves scanners
- **anim agent**: adds characters, improves animations
- **demo agent**: creates GitHub Pages demo with mock data
