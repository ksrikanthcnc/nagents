# Contributing to nagents

## Architecture

```
nagents/
├── ui/                    # Frontend (TypeScript + Vite)
│   ├── overlay/           # Transparent fullscreen overlay
│   │   ├── overlay.ts     # Physics, rendering, cursor tracking
│   │   ├── overlay.css    # Overlay styles
│   │   └── modes.ts       # Mode assignment (pure logic, no DOM)
│   ├── panel/             # Control panel (session list + settings)
│   │   ├── panel.ts       # Panel UI, grouping, event handlers
│   │   └── panel.css      # Panel styles
│   ├── characters/        # Character SVGs + animations
│   │   └── <name>/        # Each char: index.ts, animations.css
│   └── shared/
│       ├── types.ts       # Shared TypeScript types
│       └── bridge.ts      # Tauri/HTTP communication layer
├── src-tauri/             # Backend (Rust + Tauri v2)
│   └── src/
│       ├── lib.rs         # App entry, setup, managed state
│       ├── state.rs       # Session store, event handling
│       ├── config.rs      # Config loading, hot-reload, local override
│       ├── cursor.rs      # Platform-specific cursor reading
│       ├── attention.rs   # Attention computation (stuck detector)
│       ├── scanner.rs     # Source scanners (spawn external commands)
│       ├── server.rs      # HTTP API (hooks, state, cursor)
│       └── overlay.rs     # Overlay window management
├── config.yaml            # Default config (committed)
├── config.local.yaml      # User overrides (gitignored)
├── sources/               # Scanner scripts per source
└── data/events/           # Persisted hook events (JSONL)
```

## Key Concepts

### Mode Waterfall
Sessions are assigned modes by priority:
1. **Pinned** → always follow cursor (exempt from limits)
2. **Follow** → top N by priority follow cursor (max_followers)
3. **Roam** → next M free-roam the screen (max_roamers)
4. **Dot** → next K orbit cursor as tiny dots (max_dots)
5. **Hidden** → overflow (badge shows +N count)

Sort: priority level → LIFO (newest first) → sessionId tiebreak.

### Priority Levels
- 4: approval/stuck (agent blocked)
- 3: idle + waiting_on_user (agent asked something)
- 2: idle + low priority (task done)
- 1: working (running/tool)
- 0: no attention

### Physics
- Followers: lerp toward cursor (or ring edge when dots present)
- Dots: lerp toward orbit position (equidistant, no velocity)
- Roamers: velocity physics with damping, target random positions
- Collision: followers/roamers push each other; dots don't collide

### Config
- `config.yaml` = defaults (committed, shared)
- `config.local.yaml` = user overrides (gitignored, takes priority)
- Deep-merged at load time, both hot-reload on file change
- Frontend polls config every 5s

## Development

```bash
./start.sh          # Start (tmux + cargo tauri dev)
./start.sh stop     # Stop
npm run build       # Frontend build only
cd src-tauri && cargo check  # Rust check only
```

## Adding a Character

1. Create `ui/characters/<name>/`
2. Add `index.ts` exporting character definition (svg, actions)
3. Add `animations.css` with keyframes
4. Register in `ui/characters/registry.ts`
5. Add to config `characters:` pools

## Adding a Source

1. Create `sources/<name>/scan.py` (or any language)
2. Script outputs JSON array of sessions to stdout
3. Add to `config.yaml` under `sources:`
4. Hook pushes go to `POST /event`

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| /health | GET | Liveness check |
| /state | GET | Full state snapshot |
| /cursor | GET | Current cursor position |
| /event | POST | Push partial event update |
| /sessions | POST | Scanner pushes batch |
| /character | POST | Set session character |
| /config | POST | Patch config.local.yaml |

## Platform Support

- **macOS**: Full support (CGEvent cursor, transparent overlay)
- **Windows**: Cursor works (GetCursorPos), overlay needs testing
- **Linux**: Cursor via xdotool (needs install), overlay needs compositor
