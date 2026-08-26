# nagents (nagents)

A desktop companion app that visualizes AI agent sessions as animated characters on your screen. Characters follow your cursor, roam freely, orbit as dots, and "nag" you when agents need attention — all in a transparent overlay window.

Built with Tauri 2 (Rust backend) + vanilla TypeScript frontend + Vite.

## What It Does

nagents monitors your running Kiro IDE, CLI, and Crew sessions and represents each as an animated character on a transparent desktop overlay. Characters respond to agent state in real time:

- **Following cursor** — high-priority sessions (pinned, needing attention) physically follow your mouse
- **Roaming** — working sessions wander the screen independently
- **Orbiting as dots** — overflow sessions orbit the cursor as scaled-down dots
- **Hidden** — remaining sessions show as a "+N" badge

When an agent needs your attention (stuck tool, waiting for approval, idle too long), its character gets a pulsing alert ring and moves to follow your cursor — literally nagging you.

## Features

### Overlay (transparent fullscreen)
- Physics-based character movement with spring dynamics and collision detection
- Priority waterfall: pinned → attention → idle-question → free-idle → working
- Configurable zone limits (max followers, roamers, dots)
- SVG connection lines between same-group characters
- Eye tracking (characters look at your cursor)
- Character facing (flip direction based on movement)
- Sub-agent satellites (mini characters orbit parents when workers spawn)
- Poof-in/poof-out appear/disappear animations
- Walk-off animation when sessions end (character exits to nearest edge)
- Battery saver mode (single char, slow physics, or BSB-only)

### Panel (control center window)
- All sessions grouped by source (CLI, Crew, IDE) with collapsible hierarchy
- Left-click to pin/unpin, Shift+click to mute/unmute
- Right-click for character picker (swap any session's character)
- Health bar showing context token usage
- Activity indicators with tool/event status
- Tooltips with full session details on hover
- Hide overlay for 5min / 1hr / forever

### Battery Saver Box (BSB)
- Compact draggable window as alternative to full overlay
- Shows sessions grouped by state (NEEDS YOU, WORKING, DONE)
- Configurable layout (horizontal, vertical, grid)
- Transparent background with configurable opacity

### Settings Window
- Schema-driven auto-generated UI
- Mode selector (full / lite / off)
- All physics parameters tunable live
- Changes are hot-reloaded (no restart)

### Character System (plugin architecture)
- 13 characters: ghost, cat, skeleton, robot, owl, mushroom, flame, crystal, cloud, blob, wisp, spark, orb
- Each character is self-contained (SVG + CSS animations + manifest)
- Per-source character pools (configurable in config.yaml)
- Per-session override via right-click in panel
- Actions: idle, walk, talk, alert, sleep, celebrate, think, wave, disappear

### Hook Integration (IDE event pipeline)
- Captures PreToolUse, PostToolUse, Stop, UserPromptSubmit from Kiro
- Enriches events with file paths, tool status, task progress, worker lifecycle
- Classifies sessions by source (IDE, CLI v2, CLI v3, Crew)
- Formats action text with emoji icons per tool type

### Attention System
- Source-explicit attention (hooks set directly)
- Core rules: tool stuck >30s → approval needed, running >120s → stuck
- Waiting statuses trigger attention (waiting_on_user, waiting_for_approval)
- Attention-since timestamps for recency ordering

### State Persistence
- Sessions survive app restarts (if downtime < 1 hour)
- Pin/mute/title preferences persisted to data/sessions.json
- Event cache in JSONL for recovery
- Config hot-reload via filesystem watcher

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Tauri Desktop App                         │
├──────────────────────┬──────────────────────────────────────┤
│   Rust Backend       │   TypeScript Frontend (Vite)          │
│                      │                                       │
│  ┌─────────────┐    │   ┌──────────┐  ┌─────────────────┐  │
│  │ HTTP Server │◄───┼───│  Panel   │  │    Overlay       │  │
│  │  :3335      │    │   │ (control)│  │ (transparent)    │  │
│  └──────┬──────┘    │   └──────────┘  │  ┌───────────┐  │  │
│         │           │                  │  │  Physics   │  │  │
│  ┌──────▼──────┐    │   ┌──────────┐  │  │  Engine    │  │  │
│  │Session Store│    │   │   BSB    │  │  └───────────┘  │  │
│  │ (in-memory) │    │   │(compact) │  │  ┌───────────┐  │  │
│  └──────┬──────┘    │   └──────────┘  │  │ Characters │  │  │
│         │           │                  │  │  (13 SVG)  │  │  │
│  ┌──────▼──────┐    │   ┌──────────┐  │  └───────────┘  │  │
│  │  Attention  │    │   │ Settings │  └─────────────────┘  │
│  │   Loop (5s) │    │   └──────────┘                       │
│  └─────────────┘    │                                       │
│                      │                                       │
│  ┌─────────────┐    │                                       │
│  │  Scanners   │    │                                       │
│  │ (Python)    │    │                                       │
│  └─────────────┘    │                                       │
│                      │                                       │
│  ┌─────────────┐    │                                       │
│  │Config Watch │    │                                       │
│  │(hot-reload) │    │                                       │
│  └─────────────┘    │                                       │
├──────────────────────┴──────────────────────────────────────┤
│                External: Kiro IDE Hooks                       │
│  PreToolUse → PostToolUse → Stop → UserPromptSubmit          │
│       ↓ hook-dispatch.py → translate → POST /event           │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
nagents/
├── src-tauri/src/           # Rust backend
│   ├── lib.rs               # App entry, Tauri setup, persistence
│   ├── server.rs            # HTTP API (POST /event, GET /state, etc.)
│   ├── state.rs             # SessionStore (in-memory, thread-safe)
│   ├── scanner.rs           # Scanner orchestrator (spawns Python scripts)
│   ├── attention.rs         # Attention computation loop (every 5s)
│   ├── config.rs            # Config loading + hot-reload via notify
│   ├── overlay.rs           # Overlay window management (Tauri)
│   └── cursor.rs            # macOS cursor position (CoreGraphics)
├── ui/                      # TypeScript frontend
│   ├── main.ts              # Panel entry point
│   ├── overlay-entry.ts     # Overlay entry point
│   ├── panel/               # Control center
│   │   ├── panel.ts         # Session list, grouping, interactions
│   │   └── panel.css        # Panel styling (dark theme)
│   ├── overlay/             # Transparent overlay
│   │   ├── overlay.ts       # Physics engine, rendering, sync
│   │   ├── overlay.css      # Mode styles, transitions, satellites
│   │   └── modes.ts         # Priority waterfall, zone assignment
│   ├── bsb/                 # Battery Saver Box
│   │   ├── bsb.ts           # Compact session display
│   │   └── bsb.css          # BSB styling
│   ├── settings/            # Settings window
│   │   ├── settings-ui.ts   # Schema-driven form generation
│   │   └── settings.css     # Settings styling
│   ├── characters/          # 13 character plugins
│   │   ├── registry.ts      # Character lookup by ID
│   │   ├── types.ts         # CharacterDef interface
│   │   └── <id>/            # Per-character folder
│   │       ├── manifest.ts  # Actions, metadata, SVG import
│   │       ├── <id>.svg     # Character artwork
│   │       └── animations.css # Keyframes per action
│   └── shared/              # Cross-window utilities
│       ├── types.ts         # Session, Config, StateSnapshot interfaces
│       ├── bridge.ts        # Tauri IPC + HTTP fallback
│       ├── settings.ts      # localStorage → config priority cascade
│       ├── config-schema.ts # Settings schema definitions
│       └── char-template.ts # Shared character HTML renderer
├── sources/                 # Session discovery + event hooks
│   ├── hook-dispatch.py     # Routes hooks to correct source handler
│   ├── kiro_translate.py    # Shared event enrichment logic
│   ├── kiro-ide/            # IDE session scanner + hook handler
│   ├── kiro-crew/           # Crew session scanner
│   ├── kiro-cli-v2/         # CLI v2 scanner + hook
│   └── kiro-cli-v3/         # CLI v3 scanner + hook
├── demo/                    # Standalone demo (GitHub Pages)
│   ├── index.html           # Demo entry point
│   └── demo.ts              # Simulated overlay with mock data
├── tests/                   # Vitest tests
├── data/                    # Runtime state (gitignored)
│   ├── sessions.json        # Persisted pin/mute/title state
│   ├── events/              # JSONL event cache per session
│   └── app_closed_at        # Shutdown timestamp
├── comms/                   # Multi-agent collaboration
│   ├── app-agent/           # Core logic agent
│   ├── anim-agent/          # Visual/animation agent
│   ├── data-agent/          # Data sources agent
│   └── test-agent/          # QA/testing agent
├── config.yaml              # Main configuration (hot-reloaded)
├── config.local.yaml        # Local overrides (gitignored)
├── vite.config.ts           # Vite build config (normal + demo mode)
├── package.json             # Dependencies and scripts
├── start.sh                 # tmux-based app launcher
└── .github/workflows/       # GitHub Pages demo deployment
```

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) 20+
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/) prerequisites (Xcode tools on macOS)

### Development

```bash
# Install JS dependencies
npm install

# Run full app (Rust + Vite + native windows)
npm run tauri:dev

# Or use the tmux launcher
./start.sh start

# Run frontend only (browser mode, no Tauri)
npm run dev

# Run demo mode
npm run demo:dev
```

### Build

```bash
# Production app bundle
npm run tauri:build

# Demo for GitHub Pages
npm run demo:build
```

### Testing

```bash
npm test              # Run tests once
npm run test:watch    # Watch mode
```

## Configuration

Edit `config.yaml` (changes are hot-reloaded):

```yaml
# HTTP server port
http_port: 3335

# Sources: scanner commands + intervals
sources:
  kiro-ide:
    scanner: "python3 sources/kiro-ide/scan.py"
    interval_sec: 60
    hook: true
    enabled: true

# Attention rules
attention_rules:
  idle_threshold_sec: 30
  tool_stuck_sec: 30
  running_stuck_sec: 120
  waiting_statuses:
    - waiting_on_user
    - waiting_for_approval

# Overlay physics and behavior
overlay:
  overlay_mode: full          # full | lite | off
  max_followers: 2
  max_roamers: 3
  max_dots: 5
  follow_strength: 0.008
  physics_fps: 60
  char_size: 44
  working_mode: roam          # roam | queue

# Character pools per source
characters:
  kiro-crew: ghost,flame,crystal
  kiro-cli-v2: cat,skeleton,owl
  kiro-ide: ghost,robot,mushroom,cloud
```

Local overrides go in `config.local.yaml` (gitignored, deep-merged on top).

## HTTP API

The Rust backend exposes a local HTTP API on port 3335:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Liveness check |
| GET | `/state` | Full state snapshot (all sessions) |
| GET | `/config` | Current merged config |
| GET | `/cursor` | Current cursor position (macOS) |
| POST | `/event` | Push event update for a session |
| POST | `/sessions` | Scanner pushes session batch |
| POST | `/title` | Set session display title |
| POST | `/character` | Set session character |
| POST | `/config` | Patch config.local.yaml |

## Hook Setup

Install the Kiro hook to enable real-time event tracking:

```json
{
  "version": "v1",
  "hooks": [
    { "name": "nagents: tool start", "trigger": "PreToolUse",
      "action": { "type": "command", "command": "python3 <path>/sources/kiro-ide/hook.py" } },
    { "name": "nagents: tool end", "trigger": "PostToolUse",
      "action": { "type": "command", "command": "python3 <path>/sources/kiro-ide/hook.py" } },
    { "name": "nagents: session stop", "trigger": "Stop",
      "action": { "type": "command", "command": "python3 <path>/sources/kiro-ide/hook.py" } },
    { "name": "nagents: user prompt", "trigger": "UserPromptSubmit",
      "action": { "type": "command", "command": "python3 <path>/sources/kiro-ide/hook.py" } }
  ]
}
```

## Adding a Character

1. Create `ui/characters/<id>/` with:
   - `manifest.ts` implementing `CharacterDef` (actions map, SVG import)
   - `<id>.svg` (64×64 viewBox, semantic class names for animated parts)
   - `animations.css` (keyframes for idle, walk, alert, think, etc.)
2. Register in `ui/characters/registry.ts`
3. Import CSS in `ui/main.ts` and `ui/overlay-entry.ts`

## Overlay Modes

| Mode | Behavior |
|------|----------|
| **full** | All features: follow, roam, dots, connections, collisions |
| **lite** | Single follower, no roam/dots, 30fps, slow cursor tracking |
| **off** | Overlay hidden, BSB window shown instead |

## Known Issues

See [BUGS.md](./BUGS.md) for tracked issues. Summary of code-level concerns:

- `source_as_group` config field exists in types but has no behavioral implementation
- Panel log message says "1.5s" but actual poll interval is 3000ms
- `#overlay-edit-btn` handler code exists but the button is not rendered in panel HTML
- `sub_agent_names` field in types.ts is dead — overlay uses `workers` via type assertion
- Duplicate HTTP POST when changing character (posts to both `/character` and `/event`)
- `animFrameId` is never used to cancel the animation loop (minor cleanup issue)
- Legacy CSS class aliases (`.char-appearing`/`.char-hiding`) coexist with newer `.char-poof-in`/`.char-poof-out`

## License

Private — not published.
