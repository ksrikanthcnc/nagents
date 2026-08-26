# Architecture

Comprehensive technical documentation of the nagents (nagents) system design.

## System Overview

nagents is a Tauri 2 desktop application that monitors AI agent sessions and visualizes them as animated characters on a transparent desktop overlay.

**Tech stack:**
- Backend: Rust (Tauri 2, tiny_http, serde, notify, core-graphics)
- Frontend: Vanilla TypeScript (no framework), Vite 5
- Hooks/Scanners: Python 3
- Build: Cargo + Vite + Tauri CLI

**Zero runtime JS dependencies** — only Tauri APIs, TypeScript, Vite, and Vitest.

---

## Data Flow

### Complete Event Pipeline

```
Kiro IDE/CLI agent session
        │
        ▼
┌─────────────────────┐
│ Kiro Hook Trigger    │  PreToolUse / PostToolUse / Stop / UserPromptSubmit
│ (stdin → JSON)       │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ hook-dispatch.py     │  Classifies session_id → source
│                      │  Checks: .json file? .history file? SQLite entry?
│                      │  Routes to: kiro-ide | kiro-cli-v2 | kiro-cli-v3
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ <source>/hook.py     │  Makes session ID (e.g. "ide-{uuid[:8]}")
│                      │  Calls kiro_translate.translate()
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ kiro_translate.py    │  Event enrichment:
│   translate()        │  - PreToolUse → event:"tool", tool, file, worker spawn
│                      │  - PostToolUse → event:"running", tool_ok, tool_result
│                      │  - Stop → event:"idle", clear all transients
│                      │  - UserPromptSubmit → event:"running", prompt capture
└────────┬────────────┘
         │
         ▼  HTTP POST http://127.0.0.1:3335/event
┌─────────────────────┐
│ server.rs            │  Deserializes EventUpdate
│  handle_event()      │  Persists to data/events/{session_id}.jsonl
│                      │  Calls store.push_event(update)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ state.rs             │  Partial-merge into in-memory HashMap:
│  push_event()        │  - None → don't touch field
│                      │  - Some("") → clear to None
│                      │  - Some(value) → set field
│                      │  Manages worker lifecycle (+name/-name)
└────────┬────────────┘
         │
         ▼  (every 5 seconds)
┌─────────────────────┐
│ attention.rs         │  Computes attention flags per session:
│  compute()           │  - Source-explicit attention (priority 1)
│                      │  - Tool stuck >30s → "approval" (priority 2)
│                      │  - Running >120s → "stuck" (priority 2)
│                      │  - Status in waiting_statuses (priority 2)
└────────┬────────────┘
         │
         ▼  Frontend polls GET /state every 1000ms
┌─────────────────────┐
│ overlay.ts           │  Receives StateSnapshot (all sessions)
│  syncChars()         │  Creates/updates/removes character elements
│  applyModes()        │  Delegates to modes.ts for zone assignment
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ modes.ts             │  Pure function: sessions → mode assignments
│  computeModes()      │  Waterfall: pinned → sorted by priority → fill zones
│                      │  Outputs: Map<sessionId, {mode, clusteredTo?}>
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Physics Loop         │  requestAnimationFrame at physics_fps (60):
│  updatePhysics()     │  - Follow: spring toward cursor
│                      │  - Roam: spring toward random target
│                      │  - Revolve: lerp on orbit circle
│                      │  - Collision detection + resolution
│                      │  - Eye tracking, facing, animations
└─────────────────────┘
```

### Scanner Pipeline (parallel to hooks)

```
┌─────────────────────┐
│ scanner.rs           │  Every interval_sec per source:
│  start()             │  Spawns: sh -c "python3 sources/<src>/scan.py"
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ <source>/scan.py     │  Reads Kiro state files:
│                      │  - IDE: .kiro/sessions/*.json (metadata files)
│                      │  - CLI v2: ~/.kiro/sessions/cli/*.json
│                      │  - CLI v3: conversations_v2 SQLite table
│                      │  - Crew: kiro-crew process/log detection
│                      │  Outputs: JSON array of Session objects to stdout
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ state.rs             │  push_sessions():
│                      │  - Updates meta fields on existing sessions
│                      │  - Creates new sessions (hook fields empty)
│                      │  - GCs sessions no longer reported by this source
│                      │  - Assigns random character from source pool
└─────────────────────┘
```

---

## State Management

### Session Field Ownership

The store merges updates by session_id with strict field ownership:

| Owner | Fields |
|-------|--------|
| Scanner | id, source, name, workspace, group, tokens, max_tokens, active |
| Hooks | event, attention_source, tool, file, prompt, description, status, priority, action_text, workers |
| Both | mtime (most recent wins) |
| User (panel) | pinned, muted, character (persisted to data/sessions.json) |
| Attention loop | attention, attention_reason, attention_since |

### Session Lifecycle States

```
                    ┌──────────┐
       new session  │  (none)  │  Scanner discovers, hook not yet received
                    └────┬─────┘
                         │ UserPromptSubmit
                         ▼
                    ┌──────────┐
                    │ running  │  Agent processing user request
                    └────┬─────┘
                         │ PreToolUse
                         ▼
                    ┌──────────┐
                    │   tool   │  Agent using a specific tool
                    └────┬─────┘
                         │ PostToolUse
                         ▼
                    ┌──────────┐
                    │ running  │  Between tools, still working
                    └────┬─────┘
                         │ (cycle: PreToolUse → tool → PostToolUse → running)
                         │
                         │ Stop trigger
                         ▼
                    ┌──────────┐
                    │   idle   │  Agent turn complete
                    └──────────┘

  Attention mutations (by attention.rs):
    tool + age > 30s  →  event mutated to "approval"
    running + age > 120s  →  event mutated to "stuck"
```

### Frontend State Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Rust Backend                         │
│  SessionStore (Arc<Mutex<HashMap<String, Session>>>) │
│  Single source of truth, all state in memory         │
└───────────────────────┬─────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │  Panel    │  │  Overlay  │  │   BSB     │
  │ polls 3s  │  │ polls 1s  │  │ polls 2s  │
  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
        │               │               │
        └───────────────┼───────────────┘
                        ▼
              ┌─────────────────┐
              │  localStorage   │  Cross-window communication:
              │  (browser bus)  │  - mode_assignments
              │                 │  - battery_saver
              │                 │  - charOverrides
              │                 │  - settings values
              └─────────────────┘
```

Each window is an independent Tauri webview with its own poll loop. They communicate via:
1. **Backend state** (polled independently)
2. **localStorage** (shared within the app, used for live settings and mode data)
3. **Tauri events** (config-changed event from Rust fs watcher)

---

## Overlay Physics System

### Mode Assignment (modes.ts)

Pure function with no DOM dependencies. Runs every state poll cycle (~1s).

**Priority levels (highest first):**
1. Pinned (user-set or priority:"high") — always follow
2. Attention (approval/stuck) — priority 4
3. Idle + waiting/normal priority — priority 3 (agent asked something)
4. Idle + low priority — priority 2 (task done, no urgency)
5. Working (running/tool) — priority 1

**Zone placement waterfall:**
```
sorted sessions → [ follow slots ] → [ roam slots ] → [ dot slots ] → [ hidden ]
                   (max_followers)    (max_roamers)    (max_dots)      (rest)
```

**Special behaviors:**
- Muted sessions: skip follow, go to roam/dot/hidden
- Working sessions (working_mode="roam"): skip follow, always roam
- Group clustering (group_as_one): center rotates, others orbit

### Physics Engine (overlay.ts)

Single `requestAnimationFrame` loop at configurable FPS:

```
tick(now):
  1. Lerp cursor toward polled target (smoothing)
  2. For each visible char:
     - Follow: target = cursor (offset by dot ring if dots exist)
       Force = (target - pos) * follow_strength
       Damping = 0.80
     - Roam: target = random point (changes every ~240 frames)
       Force = (target - pos) * roam_strength
       Max speed = roam_max_speed, Damping = 0.88
     - Revolve: lerp to orbit position (no velocity)
       angle = globalAngle + (2π * index / count)
       Position = cursor + (cos(angle), sin(angle)) * radius
  3. Collision detection (pairwise):
     - Followers ↔ Followers: push apart
     - Followers ↔ Roamers: push apart
     - Dots ↔ anything: no collision
     - Same cluster: skip
  4. Ring exclusion: non-dot chars pushed outside dot orbit
  5. Apply position to DOM (skip if unchanged)
  6. Apply facing, eye tracking, animations
  7. Render satellites (sub-agent orbit)
  8. Draw connections (every 3 frames, if enabled)
```

### Cursor Tracking

```
Overlay JS → HTTP GET /cursor → Rust → CGEventGetLocation (macOS) → {x, y}
```

- Poll rate: `cursor_fps` (default 10hz)
- Smoothing: lerp with `cursor_smoothing` factor (default 0.12)
- Menu bar offset: y - 38px (macOS)
- Optimization: pauses when all chars hidden or battery saver on

---

## Character Plugin System

### Interface

```typescript
interface CharacterDef {
  id: string;           // "ghost", "cat", etc.
  name: string;         // Display name
  description: string;  // Short description
  svg: string;          // Raw SVG (via ?raw import)
  defaultSource?: string;
  actions: Partial<Record<CharacterAction, ActionDef>>;
  customActions?: Record<string, ActionDef>;
}

interface ActionDef {
  cssClass: string;     // Applied to container on this action
  duration?: number;    // Animation duration hint (ms)
  randomOffset?: boolean; // Stagger animations across instances
  loop?: boolean;       // Default true
}

type CharacterAction =
  "idle" | "walk" | "talk" | "alert" | "sleep" |
  "celebrate" | "think" | "wave" | "disappear";
```

### SVG Conventions

- ViewBox: 64×64
- Semantic class names on animated parts: `.eye`, `.body`, `.tail`, `.mouth`, `.blush`
- Parts targeted by CSS selectors: `[data-char="ghost"].char-slot-idle svg .eye`
- No external assets — everything inline

### Animation Layers

1. **Character CSS** (per-character `animations.css`): Artistic animations on SVG parts
2. **System CSS** (`overlay.css`): Mode styles, transitions, satellite orbits
3. **JS Physics**: Position, facing, eye tracking (per-frame)

---

## Configuration System

### Layering

```
config.yaml (base, committed)
  + config.local.yaml (local overrides, gitignored)
  = merged Config (served by Rust)
    → frontend reads via GET /config or Tauri IPC
      → localStorage overrides (live panel changes, highest priority in UI)
```

### Hot-Reload Flow

```
User edits config.yaml or config.local.yaml
  → notify crate fs watcher fires
    → ConfigHandle reloads + merges both files
      → Emits "config-changed" Tauri event
        → All windows receive event, re-fetch config
          → Overlay applies new physics params immediately
```

### Key Config Sections

| Section | Purpose | Hot-reload |
|---------|---------|------------|
| `http_port` | API server port | No (requires restart) |
| `sources` | Scanner definitions | Yes (new intervals applied) |
| `attention_rules` | When to trigger attention | Yes |
| `overlay` | Physics, zones, FPS, modes | Yes (immediate) |
| `characters` | Source → character pool mapping | Yes |
| `panel_order` | Group display order | Yes |

---

## Multi-Agent Development (comms/)

The codebase is developed collaboratively by multiple Kiro agents:

| Agent | Owns | Responsibility |
|-------|------|----------------|
| app-agent | src-tauri/, ui/overlay/ (logic), ui/shared/, config.yaml | Backend, state, physics, config |
| anim-agent | ui/characters/, ui/panel/panel.css, ui/overlay/overlay.css | Visuals, animations, characters |
| data-agent | sources/ | Scanners, hooks, event enrichment |
| test-agent | tests/ | QA, battle-testing, unit tests |

### Communication Protocol

```
comms/<agent>/
  inbox/    ← unread messages (NNN-<slug>.md)
  done/     ← processed messages
  contracts/ ← interface specs (currently unused)
  session.md ← stable state
  wip.md     ← active work
  journal.md ← session log
```

Rules:
- Never touch another agent's files
- All communication via `comms send` / `comms done`
- Message format: From/Date/Ref headers + markdown body
- Reply: sent to original sender's inbox with `re-` prefix

---

## Persistence & Recovery

### Shutdown Sequence

```
Main window close
  → persist_sessions(): write all Session objects to data/sessions.json
  → write_close_timestamp(): write epoch to data/app_closed_at
  → exit
```

### Startup Sequence

```
1. Load config.yaml + config.local.yaml (merged)
2. Start fs watcher on both config files
3. Create SessionStore, set character pools from config
4. If downtime < 1 hour:
   a. Load data/sessions.json (full session state)
   b. Overlay recent events from data/events/*.jsonl
5. Clear stale attention (sessions stuck in non-idle with attention=true)
6. Restore pinned/muted/title meta from data/sessions.json
7. Start HTTP server on :3335
8. Start scanner orchestrator (spawns Python per source interval)
9. Start attention loop (compute every 5s)
10. Create overlay window (after 5s delay for Vite dev server)
11. Register Tauri managed state + invoke handlers
```

### Event Cache (data/events/)

```
data/events/ide-abc12345.jsonl   ← one file per session
data/events/cli2-def67890.jsonl  ← append-only, one JSON object per line
```

Each line is a full EventUpdate with timestamp. On startup, recent events (within 1 hour of close) are replayed to restore hook-owned fields. Files are append-only during runtime.

---

## API Reference

### POST /event (EventUpdate)

```json
{
  "session_id": "ide-abc12345",
  "event": "tool",
  "tool": "read_file",
  "file": "src/main.ts",
  "mtime": 1724500000.0,
  "worker": "+cg:Investigating auth flow"
}
```

**Semantics:**
- `null` field → don't change
- `""` string → clear to None
- Value → set field

**Worker lifecycle:**
- `"+name:description"` → spawn (increments sub_agents, appends to workers)
- `"-name"` → done (decrements sub_agents, removes from workers)

### GET /state (StateSnapshot)

```json
{
  "sessions": [
    {
      "id": "ide-abc12345",
      "source": "kiro-ide",
      "name": "Session Title",
      "workspace": "~/project",
      "group": "kiro-ide",
      "active": true,
      "event": "tool",
      "attention": false,
      "tool": "read_file",
      "file": "src/main.ts",
      "tokens": 45000,
      "maxTokens": 200000,
      "character": "ghost",
      "pinned": false,
      "muted": false,
      "sub_agents": 1,
      "workers": ["cg:Investigating auth"]
    }
  ],
  "count": 12,
  "timestamp": 1724500000.0
}
```

### POST /config (partial patch)

```json
{
  "overlay": {
    "max_followers": 3,
    "physics_fps": 30
  }
}
```

Deep-merges into `config.local.yaml`, triggering hot-reload via fs watcher.

---

## Performance Considerations

### CPU Optimization
- Physics loop: pure math, no DOM reads. Skips when all chars hidden.
- DOM writes: cached position comparison (`_lastLeft`/`_lastTop`), skip if unchanged.
- Connections: redrawn every 3 frames (not every frame).
- localStorage: cached reads refreshed every 60 frames (~1s).
- Cursor poll: pauses when no visible chars or battery saver on.
- Battery saver: drops to 15fps, hides overlay, shows compact BSB instead.

### Memory
- No framework overhead (vanilla TS, ~zero allocations in render loop).
- Satellite elements reused (keyed by `parentId-index`).
- Character SVGs: raw strings, injected once per element creation.
- Event cache: append-only JSONL files, loaded once on startup.

### Network
- All HTTP is localhost (127.0.0.1:3335) — no network latency.
- Cursor poll: 1 request per `cursor_fps` interval (default: every 100ms).
- State poll: 1 request per 1000ms (overlay) / 3000ms (panel) / 2000ms (BSB).
- Hooks: fire on tool use (may be rapid during agent work).

---

## Dead Code & Technical Debt

Identified during codebase audit (August 2024):

| Issue | Location | Impact |
|-------|----------|--------|
| `source_as_group` field | types.ts, config.rs, overlay.ts | Defined in config/types, never used in logic (modes.ts has no reference) |
| Panel poll log | panel.ts:47 | Says "1.5s" but actual interval is 3000ms |
| `#overlay-edit-btn` handler | panel.ts:315 | Handler exists but button not rendered in panel HTML |
| `sub_agent_names` type field | types.ts:61 | Dead — overlay uses `(session as any).workers` instead |
| Duplicate character POST | panel.ts:405-415 | POSTs to both `/character` and `/event` for same change |
| `animFrameId` unused | overlay.ts:41 | Assigned but never used to `cancelAnimationFrame` |
| Legacy CSS aliases | overlay.css | `.char-appearing`/`.char-hiding` alongside `.char-poof-in`/`.char-poof-out` |
| `renderBsbBox()` in overlay | overlay.ts:928 | Inline BSB rendering — partially dead since BSB has its own window, but still used as fallback |
