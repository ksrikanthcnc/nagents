# Nagents (nagents)

A desktop overlay that visualizes AI agent sessions as animated characters. Characters follow your cursor, roam your screen, orbit as dots, or hide — all based on which agents need your attention and which are happily working away.

Built for monitoring multiple Kiro IDE, CLI, and Crew sessions simultaneously without context-switching to check their status.

**Tested on:** macOS (primary), Kiro IDE v1+. Cross-platform via Tauri 2 (Windows/Linux should work but untested).

**[Live Demo](https://ksrikanthcnc.github.io/nagents/)** — try the overlay in your browser, no install needed.

---

## How It Works

Nagents sits between your Kiro agents and your attention. It watches every running session — IDE windows, CLI conversations, Crew tasks — and represents each as an animated character on your desktop. The characters *behave* based on what the agents are doing:

- Agents that need you → characters **follow your cursor** (with a pulsing attention ring)
- Agents actively working → characters **roam freely** in corners of your screen
- Overflow → characters **orbit as tiny dots** around your cursor
- Too many → characters **hide** (badge shows count)
- You pinned one → it **always follows**, exempt from all limits
- You muted one → it's **always hidden**, out of the way

---

## Core Features

### Priority Waterfall

Every session is ranked in an 8-level priority system that determines *where* its character appears:

1. **Waiting on user** (agent explicitly asked you something) → follows cursor
2. **Approval needed** (tool stuck >30s, probably waiting for click) → follows cursor
3. **Stuck** (running >120s without progress) → follows cursor
4. **Idle with attention** (finished with a question mark) → follows cursor
5. **Idle** (done, available for next task) → roam or dot
6. **Default** (just appeared, no events yet) → roam or dot
7. **Working** (running tools, writing files) → roam (exempt from follow)
8. **Muted** (user said "go away") → always hidden

Characters fill zones top-down: top N get **follow** slots (near cursor), next M get **roam** (free on screen), next K get **revolve** (orbiting dots), rest are **hidden**.

### Attention Pulsing

When a character needs your attention, it gets a glowing pulse ring. The ring **accelerates over time** — starts slow (2.5s period), speeds up as the agent waits longer (down to 0.6s after 5 minutes). Visual urgency matches actual urgency.

The attention system is time-based:
- Tool running >30s without completion → "needs approval" (probably stuck on a permission dialog)
- Agent running >120s without any tool use → "stuck" (might be in a loop)
- Agent declares `waiting_on_user` status → immediate attention
- Events older than 1 hour stop triggering (abandoned sessions don't haunt you)

### Physics Engine

Characters aren't static icons — they have **spring-based physics**:

- **Following**: Pull toward cursor with configurable strength. When dots exist, followers stay outside the dot ring. Velocity-based with damping (0.8).
- **Roaming**: Pull toward random screen targets that change every ~4 seconds. Softer springs, lower max speed. Damping 0.88.
- **Orbiting (dots)**: Lerp to positions on a circle around the cursor. No velocity — pure interpolation for smooth orbital motion.
- **Collision**: Characters push apart when overlapping (O(n²) pairwise, fine for ~10 visible chars).
- **Ring exclusion**: Non-dot characters are pushed *outside* the dot orbit ring so they don't overlap.
- **Eye tracking**: Character eyes follow your cursor direction. SVG `.eye` elements get a 2px offset toward cursor.
- **Facing**: Characters flip horizontally based on movement direction (follow: toward cursor, roam: toward velocity).

All physics parameters are tunable in real-time via config hot-reload.

### Walk-Off Animations

When a session ends (agent closes, tab removed), its character doesn't just vanish:
1. 3-second debounce (in case it comes right back)
2. Character walks toward the **nearest screen edge**
3. Fades out as it leaves
4. Removed from DOM after 10s or when off-screen

New characters spawn at a random screen edge and slide in.

### Sub-Agent Satellites

When an agent spawns sub-agents (e.g., `invoke_sub_agent` for context-gathering, code review, etc.), the parent character gets **orbiting satellite dots**:

- Each worker gets a tiny character (40% size) orbiting the parent
- Worker type maps to a specific character visual (context-gatherer → wisp, task-exec → spark, reviewer → orb, etc.)
- Satellites appear on spawn, disappear on completion
- Shows truncated task description (14 chars)

### Connection Lines

Optionally, characters from the same group can be connected by **SVG dashed lines** — a minimum spanning tree of positions, drawn every 3rd frame for performance. Shows at a glance which characters belong together.

### Battery Saver Mode

Three overlay modes for different energy needs:

- **Full** — All features: multiple followers, roamers, dots, physics at 60fps, satellites, connections
- **Lite** — Single follower, slow cursor tracking (1fps poll), no roam/dots, 30fps physics, no connectors
- **Off** — Overlay hidden entirely, replaced by a compact **Battery Saver Box (BSB)** window

The BSB is a small, always-on-top, draggable window showing a grid of characters grouped by state (NEEDS YOU, WORKING, DONE). Auto-resizes to content. Fully transparent background (configurable opacity). Shows the same character visuals but statically arranged.

### Pluggable Character System

Characters are self-contained plugins. Each is a folder with:
- **SVG artwork** (viewBox 64×64, semantic class names on parts: `.eye`, `.body`, `.tail`)
- **CSS animations** (keyframes per action: idle, walk, talk, alert, sleep, celebrate, think, wave, disappear)
- **Manifest** (TypeScript interface: id, name, description, action→CSS mappings)

To add a new character: create the folder, write the SVG, add animations, register it. No core code changes needed. The panel's right-click character picker auto-discovers all registered characters.

Animation layers stack:
1. **Character CSS** — artistic animations on SVG parts (per-character)
2. **System CSS** — mode transitions, attention pulse, satellite orbits (global)
3. **JS Physics** — position, facing, eye tracking (per-frame)

### Panel (Control Center)

A native macOS window listing all sessions with:
- **Grouped display** — organized by source (IDE/CLI/Crew), sub-grouped by workspace or custom group
- **Zone indicators** — shows which characters are FOLLOWING, ROAMING, DOT, HIDDEN
- **State grouping** — NEEDS YOU / WORKING / DONE sections
- **Quick actions** — Click to pin, Shift+click to mute, right-click for character picker
- **Token health bar** — visual progress of context window usage (green → amber → red)
- **Group actions** — Pin all / Mute all buttons per sub-group
- **Theme support** — Dark, Midnight, Light, Contrast
- **Smart re-rendering** — Only updates changed elements (no full re-render on state poll)

### Hot-Reload Configuration

Edit `config.yaml` and changes apply **instantly** — no restart needed. A file watcher in the Rust backend detects changes, re-merges config, and broadcasts to all windows. Physics params, zone limits, cursor speed, font sizes, BSB layout — all live-tunable.

Local overrides via `config.local.yaml` (gitignored) merge on top of base config. Settings UI auto-generates a form from the schema and writes to the local file.

### Working Mode

Working sessions (actively running tools, writing files) can behave differently:
- **Roam mode** (default): Working chars skip the follow queue entirely — they go straight to roam. They don't consume follower slots, so attention chars always get priority.
- **Queue mode**: Working chars enter the normal waterfall. If there are free follow slots, they'll follow too.

Working chars also get special CSS classes (`char-working`) so they can have distinct visual styling.

### Group Merging

When `group_as_one` is enabled, same-group sessions merge into a single visual unit:
- **Cluster mode**: One center character (rotates every N seconds), others orbit it as smaller satellites
- **Single mode**: Only the highest-priority member is visible, rest hidden (badge shows count)

Useful when you have 5 IDE sessions in the same workspace — you don't need 5 separate characters.

### Follower Ordering

When multiple sessions deserve follow slots, tie-breaking determines who gets priority:
- **LIFO** — Most recent interaction follows (default: what you just talked to stays close)
- **FIFO** — Oldest interaction follows (first come first served)
- **LRU** — Least recently interacted follows (the neglected one nags you)
- **Frequency** — Most-interacted follows (exponential decay with configurable half-life)
- **Round Robin** — Rotates every N seconds (everyone gets a turn)
- **Chained** — Combine multiple: `"priority,lifo"` sorts by priority first, then LIFO for ties

### Manual Session Naming

Type `nagents:session_prefix:group:title` in any Kiro prompt to set a custom name/group on any session. Persisted across restarts. Useful for organizing sessions by project or task.

### Persistence & Recovery

- **Pinned/muted/titles** survive app restarts (stored in `data/sessions.json`)
- **Scanners are source of truth** — on startup, only scanners determine which sessions exist. Metadata (pin/mute/title) is applied 3s after start once scanners have reported.
- **No stale state** — the app never loads old sessions blindly. Clean start every time.

### Multi-Source Architecture

Four session sources run in parallel:
- **Kiro IDE** — Scans open windows via Kiro's internal SQLite + storage.json (60s interval)
- **Kiro CLI v3** — Discovers conversations from `.history` files + SQLite (5s interval)
- **Kiro CLI v2** — Reads session JSON files (5s interval)
- **Kiro Crew** — Reads context snapshots (60s interval)

Each source has independent scanners (periodic discovery) and hooks (real-time event push). Scanners provide session existence; hooks provide state transitions. Neither overwrites the other's fields.

### Hook Event Enrichment

Real-time hooks capture rich data from every agent action:
- **Tool usage**: Which tool is running, what file/path/query it targets
- **Bash exit codes**: Did the command succeed or fail?
- **Todo progress**: "3/5: Fix stale tool bug" extracted from task lists
- **Agent self-description**: From `update_session_information` — what the agent says it's doing
- **Sub-agent lifecycle**: Who spawned, what they're doing, when they finish
- **User prompts**: Full text of what you asked (for context in panel)

### System Tray

Since the app runs as a macOS Accessory (no Dock icon, shows over fullscreen), it lives in the menu bar:
- Double-click tray → toggle panel visibility
- Right-click → Show Panel / Settings / Quit
- Overlay is hidden from screen share/screenshots (`content_protected`)

### Sleep/Wake Handling

Detects macOS sleep (>10s gap between frames) and pauses the overlay for a configurable delay on wake. Prevents jarring immediate character movement when you open your laptop.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Kiro IDE / CLI / Crew (agent sessions)                     │
│  └─ Hook events (PreToolUse, PostToolUse, Stop, etc.)       │
└────────────────────┬────────────────────────────────────────┘
                     │ stdin JSON → hook-dispatch.py → source/hook.py
                     │ → kiro_translate.py → HTTP POST /event
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Rust Backend (Tauri 2 + tiny_http)                          │
│  ├─ server.rs     HTTP API (12 endpoints)                    │
│  ├─ state.rs      In-memory session store (Arc<Mutex>)       │
│  ├─ scanner.rs    Periodic session discovery (1 thread/src)  │
│  ├─ attention.rs  Attention computation (every 5s)           │
│  ├─ config.rs     YAML config + hot-reload (notify watcher)  │
│  ├─ overlay.rs    Transparent window management              │
│  └─ cursor.rs     Native cursor position (CoreGraphics FFI)  │
└────────────────────┬────────────────────────────────────────┘
                     │ Tauri events + HTTP polling
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  TypeScript Frontend (Vite 5, zero runtime deps)             │
│  ├─ Panel         Control center (grouped session list)      │
│  ├─ Overlay       Physics engine + animated characters       │
│  ├─ BSB           Battery Saver Box (compact grid)           │
│  └─ Settings      Auto-generated config form                 │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust, Tauri 2, tiny_http, serde, notify, core-graphics |
| Frontend | Vanilla TypeScript (no framework), Vite 5 |
| Hooks/Scanners | Python 3 |
| Build | Cargo + Vite + Tauri CLI |
| Tests | Vitest (unit + integration) |

Zero runtime JS dependencies. Only `@tauri-apps/api`, TypeScript, Vite, and Vitest as dev deps.

---

## Quick Start

### Prerequisites

- macOS, Windows, or Linux (tested on macOS)
- Rust toolchain (`rustup`)
- Node.js 18+ with npm
- Python 3.10+
- Tauri CLI (`cargo install tauri-cli`)

### Development

```bash
npm install                # Install JS deps (first time only)
./start.sh                 # Start everything in tmux
./start.sh status          # Check if running
./start.sh stop            # Kill everything
./start.sh logs            # Attach to tmux (see Rust + Vite logs)
```

`start.sh` launches three processes in a tmux session:
- **Vite** dev server on `:5180` (hot-reload for TypeScript/CSS changes — instant)
- **Cargo** builds and runs the Rust backend (HTTP server on `:3335`, scanners, attention loop)
- **Tauri** creates native windows (panel, overlay, BSB) connected to Vite

**Workflow:**
- Edit `ui/**/*.ts` or `*.css` → Vite hot-reloads the frontend instantly (no restart)
- Edit `config.yaml` → Rust detects change, emits event, all windows update in <1s
- Edit `src-tauri/src/*.rs` → Cargo recompiles (~5s), Tauri restarts the app
- Edit `sources/*.py` → Takes effect on next scanner interval (or trigger a hook manually)

**Useful during development:**
```bash
# Force all scanners to run now (don't wait for interval)
curl http://127.0.0.1:3335/scan

# Push a fake test session
curl http://127.0.0.1:3335/test/start

# Clear test sessions
curl http://127.0.0.1:3335/test/clear

# Check current state
curl http://127.0.0.1:3335/state | python3 -m json.tool

# Push a manual event
curl -X POST http://127.0.0.1:3335/event \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-001","event":"tool","tool":"execute_bash"}'
```

### Build

```bash
npm run tauri:build    # .dmg/.app in src-tauri/target/release/bundle/
```

### Testing

```bash
npm test                  # 136 tests (modes, priority, waterfall, groups, freq, transitions)
npm run test:watch        # Watch mode

# Integration (requires running server)
npx vitest --run tests/integration.test.ts

# Manual overlay simulation
python3 test-flow.py      # Automated state assertions
python3 test-overlay.py   # Visual simulation (subcommands: follow, roam, approval, zones)
python3 test-lifecycle.py # Full lifecycle demo (7 sessions, all transitions)
```

Test files cover: priority levels, waterfall placement, working mode, tie-breaking (all 6 strategies), pin/mute behavior, group merging (single + cluster), state transitions, and live server integration.

**Writing new tests:** Tests live in `tests/`. Import `makeChar`, `makeConfig`, `makeSession` from `tests/helpers.ts` for factory functions. The mode system is pure logic (no DOM) so it's straightforward to unit test.

---

## Extending

### Configuring Hooks

Nagents receives real-time events via Kiro hooks. Place a hook file at `~/.kiro/hooks/nagents.json`:

```json
{
  "version": "v1",
  "hooks": [
    {
      "name": "nagents: user prompt",
      "trigger": "UserPromptSubmit",
      "action": { "type": "command", "command": "python3 /path/to/nagents/sources/hook-dispatch.py" },
      "timeout": 5
    },
    {
      "name": "nagents: tool start",
      "trigger": "PreToolUse",
      "action": { "type": "command", "command": "python3 /path/to/nagents/sources/hook-dispatch.py" },
      "timeout": 5
    },
    {
      "name": "nagents: tool done",
      "trigger": "PostToolUse",
      "action": { "type": "command", "command": "python3 /path/to/nagents/sources/hook-dispatch.py" },
      "timeout": 5
    },
    {
      "name": "nagents: agent done",
      "trigger": "Stop",
      "action": { "type": "command", "command": "python3 /path/to/nagents/sources/hook-dispatch.py" },
      "timeout": 5
    }
  ]
}
```

Replace `/path/to/nagents/` with the actual project path. All four triggers go to the same dispatcher — it classifies the session and routes internally.

### Adding a New Source

A **source** is any executable that discovers agent sessions. Write it in any language.

**Step 1: Create the scanner** — `sources/<name>/scan.py`

The scanner runs periodically and prints a JSON array of sessions to stdout:

```python
#!/usr/bin/env python3
import json

sessions = [
    {
        "id": "mysrc-abc12345",      # Unique, prefixed by source
        "source": "my-source",       # Must match config key
        "name": "My Session",        # Display name (max 50 chars)
        "workspace": "~/project",    # Workspace path
        "group": "project",          # Panel grouping
        "active": True,              # Session exists?
        "tokens": 50000,             # Context usage
        "maxTokens": 200000,         # Max context window
        "mtime": 1723987200.5,       # Last activity (epoch)
    }
]
print(json.dumps(sessions))
```

**Step 2: Add to config.yaml**

```yaml
sources:
  my-source:
    scanner: "python3 sources/my-source/scan.py"
    interval_sec: 30        # How often to scan
    hook: true              # Does this source also push hooks?
    enabled: true
```

**Step 3 (optional): Create a hook handler** — `sources/<name>/hook.py`

If your source also pushes real-time events (not just periodic scans):

```python
#!/usr/bin/env python3
import json, sys, urllib.request
sys.path.insert(0, str(Path(__file__).parent.parent))
from kiro_translate import translate

payload = json.loads(sys.stdin.read())
trigger = payload.get("hook_event_name", "")
session_id = f"mysrc-{payload['session_id'][:8]}"

update = translate(trigger, payload, session_id)
if update:
    data = json.dumps(update).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:3335/event",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=3)
```

**Step 4: Assign characters**

```yaml
characters:
  my-source: ghost,robot,cat    # Comma-separated pool
```

New sessions from this source get a random character from its pool.

See [docs/SOURCE_CONTRACT.md](docs/SOURCE_CONTRACT.md) for the full schema (all fields, field ownership, GC behavior).

Also see:
- [sources/README.md](sources/README.md) — Overview of all source scanners
- [sources/kiro-ide/README.md](sources/kiro-ide/README.md) — IDE source implementation details
- [sources/kiro-crew/README.md](sources/kiro-crew/README.md) — Crew source implementation details

### Adding a New Character

Characters are self-contained plugins — no core code changes needed.

**Step 1: Create the folder**

```
ui/characters/<id>/
├── <id>.svg          # Artwork (viewBox 64x64)
├── manifest.ts       # CharacterDef implementation
└── animations.css    # CSS keyframes per action
```

**Step 2: Write the SVG**

- ViewBox: `0 0 64 64` (or up to 56x72)
- Add class names on parts to animate: `.eye`, `.body`, `.tail`, `.mouth`
- No external deps (`<use>`, linked images, etc.)
- Keep simple — renders at 28-44px

**Step 3: Create manifest.ts**

```typescript
import type { CharacterDef } from "../types";
import svg from "./<id>.svg?raw";

export const <id>: CharacterDef = {
  id: "<id>",
  name: "Display Name",
  description: "Short description for panel tooltip.",
  svg,
  actions: {
    idle:      { cssClass: "<id>-idle" },
    walk:      { cssClass: "<id>-walk" },
    alert:     { cssClass: "<id>-alert" },
    think:     { cssClass: "<id>-think" },
    sleep:     { cssClass: "<id>-sleep" },
    celebrate: { cssClass: "<id>-celebrate", loop: false },
  },
};
```

**Step 4: Write animations.css**

```css
/* idle — subtle breathing */
.<id>-idle .body {
  animation: <id>-breathe 3s ease-in-out infinite;
}
@keyframes <id>-breathe {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(1.03); }
}

/* alert — shake */
.<id>-alert .body {
  animation: <id>-shake 0.4s ease-in-out infinite;
}
@keyframes <id>-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}
```

**Step 5: Register**

In `ui/characters/registry.ts`:

```typescript
import { mychar } from "./mychar/manifest";

const CHARACTERS: CharacterDef[] = [
  // ... existing chars ...
  mychar,
];
```

That's it. The panel character picker and overlay renderer auto-discover all registered characters.

See [docs/CHARACTER_CONTRACT.md](docs/CHARACTER_CONTRACT.md) for full SVG conventions and all available actions.

---

## Documentation

| Doc | Content |
|-----|---------|
| [docs/API.md](docs/API.md) | Full HTTP API + Tauri IPC reference |
| [docs/FLOWS.md](docs/FLOWS.md) | Data flow diagrams (9 pipelines) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design deep-dive |
| [docs/SOURCE_CONTRACT.md](docs/SOURCE_CONTRACT.md) | Scanner/hook interface spec |
| [docs/CHARACTER_CONTRACT.md](docs/CHARACTER_CONTRACT.md) | Character plugin guide |
| [docs/OVERLAY_BEHAVIOR.md](docs/OVERLAY_BEHAVIOR.md) | Zone system + physics design |
| [BUGS.md](BUGS.md) | Known issues + dead code + test gaps |

---

## Known Issues

See [BUGS.md](BUGS.md) for the full list. Key notes:

- **Platform**: Tested on macOS. Windows/Linux should work via Tauri 2 but untested. Linux cursor falls back to xdotool (no Wayland yet).
- **Test gaps**: Mode system well-tested; scanner/hook/attention/physics rely on manual testing.
- **Dead code**: Minimal — mostly deprecated functions explicitly marked.

---

## License

Private project.

---

Built with [Kiro](https://kiro.dev).
