# Nagents (nagents)

A macOS desktop overlay that visualizes AI agent sessions as animated characters. Characters follow your cursor, roam your screen, orbit as dots, or hide — all based on which agents need your attention and which are happily working away.

Built for monitoring multiple Kiro IDE, CLI, and Crew sessions simultaneously without context-switching to check their status.

## What It Does

- **Monitors** all active Kiro agent sessions (IDE windows, CLI conversations, Crew tasks)
- **Visualizes** each session as an animated character on a transparent desktop overlay
- **Alerts** you when agents need attention (stuck on approvals, waiting for input, running too long)
- **Prioritizes** what to look at — attention-needing agents follow your cursor, working ones roam freely
- **Persists** state across restarts — pinned/muted preferences, titles, last known session states

## Screenshots

The overlay renders characters directly on your desktop. Agents needing attention follow your cursor (with a pulsing ring), working agents roam in corners, and overflow becomes orbiting dots.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Kiro IDE / CLI / Crew (agent sessions)                     │
│  └─ Hook events (PreToolUse, PostToolUse, Stop, etc.)       │
└────────────────────┬────────────────────────────────────────┘
                     │ stdin (JSON)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  hook-dispatch.py                                            │
│  Classifies session → routes to IDE/CLI-v2/CLI-v3 handler   │
└────────────────────┬────────────────────────────────────────┘
                     │ subprocess
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  <source>/hook.py + kiro_translate.py                        │
│  Translates hook events → EventUpdate dict                   │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP POST /event
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Rust Backend (Tauri 2 + tiny_http)                          │
│  ├─ server.rs     HTTP API (state queries + hook pushes)     │
│  ├─ state.rs      In-memory session store                    │
│  ├─ scanner.rs    Periodic session discovery                 │
│  ├─ attention.rs  Attention computation (every 5s)           │
│  ├─ config.rs     YAML config + hot-reload                   │
│  ├─ overlay.rs    Transparent window management              │
│  └─ cursor.rs     Native cursor position (CoreGraphics)      │
└────────────────────┬────────────────────────────────────────┘
                     │ Tauri events + HTTP
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  TypeScript Frontend (Vite, zero runtime deps)               │
│  ├─ Panel         Control center (session list, actions)     │
│  ├─ Overlay       Animated characters + physics engine       │
│  ├─ BSB           Battery Saver Box (compact view)           │
│  └─ Settings      Auto-generated config UI                   │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust, Tauri 2, tiny_http, serde, notify, core-graphics |
| Frontend | Vanilla TypeScript (no framework), Vite 5 |
| Hooks/Scanners | Python 3 |
| Build | Cargo + Vite + Tauri CLI |
| Tests | Vitest (unit + integration) |

Zero runtime JS dependencies — only Tauri APIs, TypeScript, Vite, and Vitest as dev dependencies.

## Features

### Session Monitoring

- **Multi-source discovery**: Monitors Kiro IDE, CLI v2, CLI v3, and Crew sessions simultaneously
- **Dual input modes**: Scanner (periodic discovery from Kiro internal state) + Hook (real-time event push via HTTP)
- **Enriched events**: Tool names, file paths, bash exit codes, todo progress, sub-agent tracking, agent self-description
- **Worker tracking**: Sub-agents spawn as satellite dots orbiting their parent character

### Attention System

- **Time-based escalation**: Tool waiting >30s → "approval" attention; Running >120s → "stuck" attention
- **Status awareness**: `waiting_on_user` and `waiting_for_approval` statuses trigger immediate attention
- **Visual priority**: 8-level priority waterfall determines which characters are most visible
- **1-hour timeout**: Stale events (>1hr) stop triggering attention (abandoned sessions)

### Overlay Rendering

- **Physics engine**: Spring-based follow, random roam targets, orbital revolve for dots
- **Zone system**: Characters placed into follow (cursor), roam (screen), revolve (orbit), or hidden zones
- **Collision detection**: Characters push apart to avoid overlapping (configurable distance)
- **Eye tracking**: Character eyes follow cursor direction
- **Connection lines**: Optional SVG connections between grouped characters
- **Satellites**: Sub-agent workers orbit parent characters as smaller dots
- **Walk-off animations**: Removed characters walk toward nearest edge before cleanup

### Character System

- **13 characters**: Ghost, Cat, Skeleton, Robot, Owl, Mushroom, Flame, Crystal, Cloud, Blob, Wisp, Spark, Orb
- **Plugin architecture**: Each character is SVG + CSS animations + manifest (self-contained)
- **Per-source pools**: Different sources get different character pools (configurable)
- **Per-session override**: Right-click any session in panel to pick a different character

### Panel (Control Center)

- **Grouped display**: Sessions organized by source, then by workspace/group
- **Zone indicators**: Shows which sessions are following, roaming, dotted, or hidden
- **Quick actions**: Click to pin (always visible), Shift+click to mute (always hidden)
- **Token health**: Visual progress bar showing context window usage
- **Theme support**: Dark, Midnight, Light, Contrast themes

### Configuration

- **Hot-reload**: Edit `config.yaml` → changes apply instantly (no restart for most settings)
- **Local overrides**: `config.local.yaml` merges on top (gitignored, personal preferences)
- **40+ settings**: Physics params, zone limits, follower ordering, font sizes, BSB layout, etc.
- **Settings UI**: Auto-generated form with live persistence

### Battery Saver Mode

- **BSB Window**: Small always-on-top window showing session grid (draggable)
- **Compact view**: Groups by state (NEEDS YOU, WORKING, DONE), configurable max chars
- **Overlay modes**: "full" (all features), "lite" (1 char, slow), "off" (BSB only)

### Persistence

- **Session metadata**: Pinned/muted/title state survives restarts (`data/sessions.json`)
- **Event cache**: Recent events replayed on startup (if downtime < 1 hour)
- **Manual titles**: `nagents:session_id:group:title` command in any prompt

## Quick Start

### Prerequisites

- macOS (primary platform; Windows/Linux partial support)
- Rust toolchain (`rustup`)
- Node.js 18+ with npm
- Python 3.10+
- Tauri CLI (`cargo install tauri-cli`)

### Development

```bash
# Install JS dependencies
npm install

# Start in development mode (Vite dev server + Tauri app)
npm run tauri:dev

# Or use the start script
./start.sh
```

### Build for Production

```bash
npm run tauri:build
```

The `.dmg` / `.app` bundle will be in `src-tauri/target/release/bundle/`.

### Configuration

Copy and edit the config:

```bash
# Base config (committed, shared defaults)
cat config.yaml

# Local overrides (gitignored, your preferences)
cp config.yaml config.local.yaml
# Edit config.local.yaml with your preferred settings
```

Key settings to tune:

```yaml
overlay:
  max_followers: 2        # Chars following cursor
  max_roamers: 3          # Free-roaming chars
  max_dots: 5             # Orbiting dots
  working_mode: roam      # Working sessions go to roam (not follow)
  follower_mode: "lifo"   # Most recent interaction follows
  overlay_mode: full      # full | lite | off
```

### Hook Setup

The app needs a Kiro hook to receive real-time events. Install the global hook:

```bash
# The hook config should be at ~/.kiro/hooks/nagents.json
# It triggers hook-dispatch.py on PreToolUse, PostToolUse, Stop, UserPromptSubmit
```

Example hook config:
```json
{
  "version": "v1",
  "hooks": [{
    "name": "nagents",
    "trigger": "PreToolUse",
    "action": { "type": "command", "command": "python3 /path/to/nagents/sources/hook-dispatch.py" }
  }]
}
```

## Project Structure

```
nagents/
├── src-tauri/              # Rust backend (Tauri 2)
│   └── src/
│       ├── main.rs         # Entry point
│       ├── lib.rs          # App orchestrator (setup, persistence, Tauri commands)
│       ├── server.rs       # HTTP API (tiny_http)
│       ├── state.rs        # Session store (Arc<Mutex<HashMap>>)
│       ├── config.rs       # YAML config + hot-reload (notify)
│       ├── attention.rs    # Attention computation loop
│       ├── scanner.rs      # External scanner orchestrator
│       ├── overlay.rs      # Window management
│       └── cursor.rs       # Platform cursor position
├── ui/                     # TypeScript frontend
│   ├── main.ts             # Panel entry
│   ├── overlay-entry.ts    # Overlay entry
│   ├── overlay/            # Physics, modes, rendering, connections, satellites
│   ├── panel/              # Control center UI
│   ├── bsb/               # Battery Saver Box
│   ├── settings/           # Auto-generated settings UI
│   ├── shared/             # Bridge, types, config-schema, settings
│   └── characters/         # 13 character plugins (SVG + CSS + manifest)
├── sources/                # Python hooks and scanners
│   ├── hook-dispatch.py    # Central hook router
│   ├── kiro_translate.py   # Shared event translation
│   ├── kiro-ide/           # IDE scanner + hook
│   ├── kiro-cli-v3/        # CLI v3 scanner + hook
│   ├── kiro-cli-v2/        # CLI v2 scanner + hook
│   └── kiro-crew/          # Crew scanner
├── data/                   # Runtime state (gitignored contents)
│   ├── sessions.json       # Persisted session metadata
│   └── events/             # Event JSONL per session
├── docs/                   # Architecture and contracts
├── tests/                  # Vitest unit + integration tests
├── config.yaml             # Base configuration
├── config.local.yaml       # Local overrides (gitignored)
└── demo/                   # Static demo (GitHub Pages)
```

## Testing

```bash
# Unit tests (mode system, priority, waterfall, groups, transitions)
npm test

# Watch mode
npm run test:watch

# Integration tests (requires running nagents server)
npx vitest --run tests/integration.test.ts

# Manual overlay testing
python3 test-flow.py      # Automated state flow assertions
python3 test-overlay.py   # Visual overlay simulation
python3 test-lifecycle.py # Full lifecycle demo
```

## API Reference

See [docs/API.md](docs/API.md) for the complete HTTP API and Tauri IPC reference.

## Data Flow

See [docs/FLOWS.md](docs/FLOWS.md) for detailed event pipeline and state management documentation.

## Adding a New Source

1. Create `sources/<source-name>/scan.py` — outputs JSON array of sessions to stdout
2. Optionally create `sources/<source-name>/hook.py` — receives stdin JSON, POSTs to `/event`
3. Add entry to `config.yaml` under `sources:`
4. Characters are auto-assigned from the source's pool (configure in `characters:` section)

See [docs/SOURCE_CONTRACT.md](docs/SOURCE_CONTRACT.md) for the full interface specification.

## Adding a New Character

1. Create `ui/characters/<name>/`
2. Add SVG file (64x64 viewbox, semantic class names on animated parts)
3. Add `animations.css` with keyframes per action (idle, walk, talk, alert, sleep, etc.)
4. Add `manifest.ts` exporting a `CharacterDef` object
5. Register in `ui/characters/registry.ts`

See [docs/CHARACTER_CONTRACT.md](docs/CHARACTER_CONTRACT.md) for conventions.

## Known Issues

See [BUGS.md](BUGS.md) for active and parked issues.

### Code Health Notes

- **Port configuration**: `config.rs` defaults to 3334, but `config.yaml` sets 3335 and CSP allows 3335. The yaml value wins at runtime — the Rust default is only a fallback.
- **Dead code**: `start_cursor_broadcast()` in overlay.rs (deprecated, replaced by HTTP polling), `RenderRequest` type (defined but unused), `clean_description()` has unreachable duplicate body.
- **Test coverage gaps**: No unit tests for scanner pipeline, hook translation, attention computation, or overlay physics (manual visual testing only).
- **Platform support**: macOS fully functional. Windows cursor works but not tested end-to-end. Linux falls back to xdotool (no Wayland support).

## License

Private project.
