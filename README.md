# nagents

Nagging AI Agents — desktop companion app where animated characters follow your cursor when AI agent sessions need attention.

Think: Clippy meets tmux sessions. Each running AI agent (Kiro IDE, CLI, Crew) gets a character that visually represents its state. Done agents nag you to respond. Working agents roam freely. Stale sessions shrink to dots orbiting your cursor.

## How it works

A transparent overlay window sits on top of everything. Characters appear when agents need you:

- **Follow cursor** — agent finished, needs your response (nagging you)
- **Free roam** — agent working, or low-priority done (background awareness)
- **Dot orbit** — overflow, orbits cursor as a small dot
- **Hidden** — too many, shown as `+N` badge at cursor

Priority waterfall decides placement: `approval > idle(?) > idle(done) > working`. Each zone has configurable max slots. Sessions sorted by LIFO (newest first), FIFO, LRU, frequency, or priority — configurable and chainable.

## Features

### Overlay
- Transparent fullscreen window (Tauri + WebView)
- Physics-based movement (follow, roam, orbit)
- 10 animated characters (ghost, cat, skeleton, robot, owl, mushroom, flame, crystal, cloud, blob)
- Per-character animations (walk, alert, idle, sleep)
- Eye tracking (eyes follow cursor)
- Group connections (same-group chars linked with dashed lines, nearest-neighbor chain)
- Group attraction (same-group chars gently pull toward each other)
- Collision avoidance between chars
- GC walk-off animation (chars walk to screen edge when session closes)
- Hidden count badge (`+N` at cursor center)
- Smooth cursor interpolation (configurable lerp)

### Panel (Control Center)
- Grid layout with char SVGs + session names
- Grouped by source (CLI, Crew, IDE) with sub-groups by workspace
- CLI/Crew supports `group:title` naming (e.g. "PPTP:fix-bug" → group PPTP)
- ON SCREEN meta group showing overlay sessions
- Collapsible groups (persisted to localStorage)
- Right-click to change character (persisted to backend)
- Health bar (token usage)
- Tooltip with full session details
- Overlay edit mode (toggle click-through)

### Mode Assignment (`modes.ts`)
- Pure logic module, no DOM
- Priority waterfall: pinned → attention → idle(?) → idle(done) → working
- Configurable zones: `max_followers`, `max_roamers`, `max_dots`
- Follower ordering: `fifo`, `lifo`, `lru`, `freq`, `priority`, `round_robin`
- Chainable: `"priority,lifo"` = sort by urgency, break ties with newest
- `group_as_one` mode: `single` (one rep), `cluster` (all close), `carousel` (rotate)
- `pin_counts_toward_max` option
- Persistent queue ordering (survives across sync cycles)

### Character System
- Plugin architecture: add `ui/characters/<id>/` with manifest + SVG + CSS
- Actions: idle, walk, alert, sleep, think, celebrate, wave, disappear
- Per-character CSS classes applied in overlay (ghost-walk, cat-alert, etc.)
- Random assignment from pool on new sessions
- User override via panel right-click (persisted to backend)

### Backend (Rust/Tauri)
- HTTP server (:3335) for hooks and state queries
- Session state management (in-memory HashMap, persisted on shutdown)
- Scanner orchestrator (spawns source executables periodically)
- Attention computation (stuck detector, priority rules, 5s loop)
- Config hot-reload (watches config.yaml)
- Event persistence (JSONL per session for debug + restart recovery)
- Shutdown persistence (full session snapshot to `data/sessions.json`)

### Sources
- **kiro-ide** — discovers IDE sessions from Kiro's SQLite storage
- **kiro-cli-v2/v3** — discovers CLI sessions from process list
- **kiro-crew** — discovers Crew sessions from crew config
- **Hook dispatch** — unified entry point for all Kiro hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit)

### Enriched Events
- `tool_ok` — tool exit success/failure
- `tool_result` — short result text (e.g. "3/5: Fix bug")
- `prompt` — user's last prompt
- `description` — agent's self-summary
- `status` — agent status (in_progress, completed, waiting_on_user)
- `priority` — hook-set priority (high, normal, low)
- `last_user_ts` — timestamp of last user interaction
- `interaction_count` — number of user interactions (for frequency sorting)

## Architecture

```
src-tauri/src/
  lib.rs        — Tauri app setup, shutdown persistence
  state.rs      — Session store, push_event, push_sessions, GC
  server.rs     — HTTP endpoints (/state, /event, /sessions, /cursor, /title, /character)
  attention.rs  — Attention computation loop (stuck detector, priority rules)
  scanner.rs    — Scanner orchestrator (spawns source executables)
  overlay.rs    — Overlay window management, cursor broadcast
  config.rs     — Config hot-reload

ui/
  overlay/
    overlay.ts  — Physics, rendering, DOM management
    modes.ts    — Pure mode assignment logic (waterfall, sorting)
    overlay.css — Styles, animations, transitions
  panel/
    panel.ts    — Control center grid
    panel.css   — Panel styles
  shared/
    types.ts    — TypeScript interfaces
    bridge.ts   — Tauri/HTTP bridge, state polling
  characters/
    registry.ts — Character discovery
    types.ts    — Plugin interface
    ghost/cat/skeleton/robot/owl/mushroom/flame/crystal/cloud/blob/

sources/
  hook-dispatch.py  — Unified hook entry point
  translate.py      — Event translation utilities
  kiro-ide/         — IDE scanner + hook
  kiro-cli-v2/     — CLI v2 scanner + hook
  kiro-cli-v3/     — CLI v3 scanner + hook
  kiro-crew/       — Crew scanner

config.yaml         — All settings (hot-reloaded)
```

## Configuration

```yaml
overlay:
  follow_strength: 0.04      # Physics pull toward cursor
  roam_strength: 0.008       # Physics pull toward roam target
  collision_distance: 100    # Min distance between chars (px)
  revolve_radius: 50         # Dot orbit radius
  dot_scale: 0.5             # Dot shrink factor
  cursor_fps: 5              # Cursor HTTP poll rate
  cursor_smoothing: 0.07     # Lerp factor (lower=smoother, higher=snappier)
  physics_fps: 60            # Render loop rate
  max_followers: 2           # Cursor follow slots
  max_roamers: 3             # Free roam slots
  max_dots: 5                # Dot orbit slots
  follower_mode: "priority,lifo"  # Sorting chain
  group_as_one: false        # Merge same-group chars
  group_display: cluster     # single | cluster | carousel
  round_robin_sec: 10        # Rotation interval

attention_rules:
  tool_stuck_sec: 30         # Tool event age → approval
  running_stuck_sec: 120     # Running age → stuck
```

## Testing

```bash
python3 test-flow.py           # 20-assertion lifecycle test
python3 test-lifecycle.py      # Full 6-phase visual lifecycle
python3 test-overlay.py zones  # Zone threshold test
python3 test-overlay.py status # Current backend state
```

## Development

```bash
./start.sh          # Start (tmux + cargo tauri dev)
./start.sh stop     # Stop
```

Requires: Rust, Node.js, Tauri CLI (`cargo install tauri-cli`).

## Demo (GitHub Pages)

A standalone web demo showcasing the overlay behavior:
- Dropdown to select source (CLI/IDE/Crew)
- Text input for `group:title`
- Buttons to change state (working → done → approval → stuck)
- Randomize button (spawns N sessions with random states)
- Full lifecycle replay (auto-runs through all phases)
- Pure frontend — no Tauri/Rust needed, just the overlay + modes.ts

## Roadmap

- [ ] Demo page (GitHub Pages)
- [ ] Pin UI (panel right-click → pin session/group)
- [ ] Panel meta sidebar (colored zones: following/roaming/dots/hidden)
- [ ] Smooth transition animations (CSS: appear/hide/mode-change)
- [ ] External source plugins (Copilot, Claude, Cursor)
- [ ] Notification sounds (configurable per priority)
- [ ] macOS menu bar integration
- [ ] Sleep/wake handling (pause timers during display sleep)

## License

MIT
