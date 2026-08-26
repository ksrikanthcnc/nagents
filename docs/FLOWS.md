# Data Flows

Detailed documentation of all data pipelines in the nagents system.

## 1. Hook Event Pipeline (Real-Time)

The primary path for real-time session updates. Triggered on every Kiro agent action.

```
Kiro Agent Action
(PreToolUse / PostToolUse / Stop / UserPromptSubmit)
        │
        │ Hook fires (stdin JSON)
        ▼
┌─────────────────────────────────────────────┐
│ hook-dispatch.py                              │
│                                               │
│ Reads JSON from stdin                         │
│ Classifies session_id:                        │
│   - .json file in cli/ → cli-v2              │
│   - .history file → cli-v3                   │
│   - SQLite conversations_v2 row → cli-v3     │
│   - Default → ide                            │
│                                               │
│ Spawns handler subprocess (5s timeout)        │
└──────────────────────┬──────────────────────┘
                       │ stdin passthrough
                       ▼
┌─────────────────────────────────────────────┐
│ <source>/hook.py                              │
│                                               │
│ Validates session belongs to this source      │
│ Generates short ID: ide-{uuid[:8]}            │
│   or cli3-{uuid[:8]}, cli2-{uuid[:8]}        │
│                                               │
│ Calls kiro_translate.translate(trigger,       │
│                                payload,       │
│                                session_id)    │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ kiro_translate.py — translate()               │
│                                               │
│ PreToolUse:                                   │
│   event: "tool"                               │
│   tool: <tool_name>                           │
│   file: <extracted display info>              │
│   worker: "+shortname:desc" (sub-agent spawn) │
│                                               │
│ PostToolUse:                                  │
│   event: "running"                            │
│   tool: "" (clear)                            │
│   file: "" (clear)                            │
│   worker: "-shortname" (sub-agent done)       │
│   tool_ok: true/false (bash exit code)        │
│   tool_result: "3/5: Fix bug" (todo)          │
│   description: <agent self-summary>           │
│   status: "in_progress" / "completed" / etc   │
│   action_text: "? question" / "✓ done"       │
│                                               │
│ Stop:                                         │
│   event: "idle"                               │
│   priority: "low"                             │
│   Clears: tool, file, tool_result, action_text│
│                                               │
│ UserPromptSubmit:                             │
│   event: "running"                            │
│   prompt: <full user text>                    │
│   Clears: all stale fields                    │
│   Special: parses nagents: commands           │
└──────────────────────┬──────────────────────┘
                       │ HTTP POST http://127.0.0.1:3335/event
                       ▼
┌─────────────────────────────────────────────┐
│ server.rs — handle_event()                    │
│                                               │
│ Deserializes EventUpdate from JSON body       │
│ Persists to data/events/{session_id}.jsonl    │
│ Calls store.push_event(update)                │
│ If pinned/muted changed → persist_session_meta│
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ state.rs — push_event()                       │
│                                               │
│ Finds session by exact ID or prefix match     │
│ If unknown → creates minimal entry            │
│ Partial merge:                                │
│   None → don't touch field                    │
│   Some("") → clear to None                    │
│   Some(value) → set field                     │
│ Worker lifecycle:                             │
│   "+name" → add to workers[], sub_agents++    │
│   "-name" → remove from workers[], sub_agents-│
│ Updates mtime, last_user_ts, interaction_count│
│ Calls emit_state_changed()                    │
└──────────────────────┬──────────────────────┘
                       │ Tauri event "state-changed"
                       ▼
┌─────────────────────────────────────────────┐
│ All frontend windows receive event            │
│ → Fetch fresh state via GET /state            │
│ → Re-render (panel updates list, overlay      │
│   re-syncs characters and modes)              │
└─────────────────────────────────────────────┘
```

## 2. Scanner Pipeline (Periodic Discovery)

Discovers sessions by reading Kiro's internal state files. Runs periodically per source.

```
┌─────────────────────────────────────────────┐
│ scanner.rs — start()                          │
│                                               │
│ For each enabled source with a scanner cmd:   │
│ Spawns a background thread that:              │
│   1. Runs scanner immediately at startup      │
│   2. Then loops: sleep(interval_sec) → run    │
└──────────────────────┬──────────────────────┘
                       │ sh -c "<scanner_command>" (CWD = project root)
                       ▼
┌─────────────────────────────────────────────┐
│ kiro-ide/scan.py (example)                    │
│                                               │
│ Reads Kiro App Support files:                 │
│   - globalStorage/storage.json (open windows) │
│   - workspaceStorage/*/workspace.json         │
│   - state.vscdb SQLite (session tabs)         │
│   - ~/.kiro/sessions/*/session.json (mtime)   │
│                                               │
│ Outputs JSON array to stdout:                 │
│ [                                             │
│   { id: "ide-abc12345",                       │
│     source: "kiro-ide",                       │
│     name: "Fix login bug",                    │
│     workspace: "~/work/project",              │
│     group: "project",                         │
│     active: true, tokens: 45000, ... }        │
│ ]                                             │
└──────────────────────┬──────────────────────┘
                       │ stdout parsed as JSON
                       ▼
┌─────────────────────────────────────────────┐
│ state.rs — push_sessions()                    │
│                                               │
│ 1. Update meta fields on existing sessions    │
│    (name, workspace, group, tokens, active)   │
│    Never touches hook-owned fields!           │
│                                               │
│ 2. Create new sessions                        │
│    - Hook fields start empty (None)           │
│    - Assign random character from pool        │
│    - Set mtime to now (if scanner sends 0)    │
│                                               │
│ 3. Garbage collect dead sessions              │
│    Sessions from this source not in report    │
│    are removed (source closed the session)    │
│                                               │
│ 4. emit_state_changed()                       │
└─────────────────────────────────────────────┘
```

### Source Scanner Intervals

| Source | Scanner Command | Interval |
|--------|----------------|----------|
| kiro-ide | `python3 sources/kiro-ide/scan.py` | 60s |
| kiro-crew | `python3 sources/kiro-crew/scan.py` | 60s |
| kiro-cli-v2 | `python3 sources/kiro-cli-v2/scan.py` | 5s |
| kiro-cli-v3 | `python3 sources/kiro-cli-v3/scan.py` | 5s |

## 3. Attention Computation

Background loop determining which sessions need user attention.

```
┌─────────────────────────────────────────────┐
│ attention.rs — compute() [every 5 seconds]    │
│                                               │
│ For each active session:                      │
│                                               │
│ IF event="tool" AND age > 30s AND age < 1hr   │
│   → attention=true, event="approval"          │
│   → reason: "tool waiting {age}s"             │
│                                               │
│ ELIF event="running" AND age > 120s AND <1hr  │
│   → attention=true, event="stuck"             │
│   → reason: "running {age}s"                  │
│                                               │
│ ELIF event="approval"                         │
│   → maintain attention (already escalated)    │
│                                               │
│ ELIF event="stuck"                            │
│   → maintain attention (already escalated)    │
│                                               │
│ ELIF status in waiting_statuses               │
│   → attention=true                            │
│   → reason: "status: {status}"               │
│                                               │
│ ELSE                                          │
│   → attention=false, clear reason+since       │
│                                               │
│ Track attention_since (first time set)        │
└─────────────────────────────────────────────┘
```

### Attention Lifecycle

```
New event arrives (hook)     event="tool", mtime=now
        │
        │ (30 seconds pass, no new events)
        ▼
Attention loop fires         age = now - mtime > tool_stuck_sec
        │                    → attention=true, event="approval"
        │
        │ (User approves tool / sends new prompt)
        ▼
New hook event               event="running", mtime=now
        │                    → attention cleared (running, fresh mtime)
        │
        │ (Agent finishes work)
        ▼
Stop hook                    event="idle", priority="low"
                             → no attention (idle, fresh)
```

## 4. Overlay Rendering Pipeline

Per-frame character rendering at 60fps (configurable).

```
┌─────────────────────────────────────────────┐
│ State Change Event                            │
│ (or initial load)                             │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ overlay.ts — syncChars(sessions)              │
│                                               │
│ 1. Remove gone chars (3s debounce → walk-off) │
│ 2. Add new chars (spawn at random screen edge)│
│ 3. Update existing char session data          │
│ 4. Update SVG if character ID changed         │
│ 5. Update group/title/action labels           │
│ 6. Call applyModes()                          │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ modes.ts — computeModes(charStates, config)   │
│                                               │
│ 1. Separate pinned/attention (always follow)  │
│ 2. If group_as_one: merge groups              │
│    - "single": one representative, rest hidden│
│    - "cluster": center rotates, others orbit  │
│ 3. Sort by priority waterfall                 │
│ 4. Tie-break by follower_mode                 │
│    (lifo/fifo/lru/freq/round_robin/priority)  │
│ 5. Place into zones:                          │
│    - Working + working_mode=roam → roam       │
│    - Top N → follow (cursor)                  │
│    - Next M → roam (screen)                   │
│    - Next K → revolve (orbit)                 │
│    - Rest → hidden                            │
│ 6. Clustered chars inherit center's mode      │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ Render Loop (requestAnimationFrame)           │
│                                               │
│ Every frame (16.6ms at 60fps):                │
│                                               │
│ 1. Lerp cursor toward polled target           │
│ 2. For each visible char:                     │
│    - Follow: spring toward cursor             │
│    - Roam: spring toward random target        │
│    - Revolve: lerp to orbit position          │
│    - Cluster: fixed orbit around center       │
│ 3. Apply velocity + damping                   │
│ 4. Ring exclusion (non-dots outside ring)     │
│ 5. Collision detection (O(n^2) pairs)         │
│ 6. Clamp to screen bounds                     │
│ 7. Update DOM position (skip if unchanged)    │
│ 8. Apply facing (SVG flip) + eye tracking     │
│ 9. Apply animation classes                    │
│ 10. Render satellites (sub-agent dots)        │
│ 11. Draw connections (every 3rd frame)        │
│ 12. Update hidden badge position + count      │
└─────────────────────────────────────────────┘
```

### Cursor Tracking

```
Overlay JS                 Rust Backend
    │                          │
    │  GET /cursor (5-10Hz)    │
    ├─────────────────────────▶│
    │                          │ CGEventGetLocation() [macOS]
    │  {x: 1234, y: 567}      │
    │◀─────────────────────────┤
    │                          │
    │  Lerp: cursor += (target - cursor) * smoothing
    │  (0.12 factor, at 60fps physics = ~7 frames to reach target)
    │
    ▼  Subtract 38px from Y (macOS menu bar offset)
```

## 5. Configuration Hot-Reload

```
User edits config.yaml (or config.local.yaml)
        │
        ▼
┌─────────────────────────────────────────────┐
│ config.rs — notify watcher detects change     │
│                                               │
│ 1. Read config.yaml (base)                    │
│ 2. Read config.local.yaml (overrides)         │
│ 3. Deep-merge (local keys win)                │
│ 4. Deserialize merged YAML → Config struct    │
│ 5. Replace inner Arc<Mutex<Config>>           │
│ 6. Emit "config-changed" Tauri event          │
└──────────────────────┬──────────────────────┘
                       │ event to all windows
                       ▼
┌─────────────────────────────────────────────┐
│ Frontend (each window):                       │
│                                               │
│ onConfigChanged() listener fires              │
│ → Fetches fresh config via GET /config        │
│ → Applies new physics params immediately      │
│ → Updates cursor poll rate, frame interval    │
│ → Triggers visual poof if working_mode changed│
└─────────────────────────────────────────────┘
```

## 6. Settings UI Flow

```
User opens Settings window (tray menu or panel button)
        │
        ▼
┌─────────────────────────────────────────────┐
│ settings-ui.ts                                │
│                                               │
│ Auto-generates form from CONFIG_SCHEMA        │
│ (40+ fields: numbers, selects, text)          │
└──────────────────────┬──────────────────────┘
                       │ User changes a value
                       ▼
┌─────────────────────────────────────────────┐
│ POST http://127.0.0.1:3335/config             │
│ Body: { overlay: { key: newValue } }          │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ server.rs — handle_config_patch()             │
│                                               │
│ 1. Read current config.local.yaml             │
│ 2. Deep-merge patch on top                    │
│ 3. Write back to config.local.yaml            │
│ 4. File watcher triggers → hot-reload         │
└─────────────────────────────────────────────┘
```

## 7. Persistence & Recovery

### On Shutdown (main window closed)

```
1. Serialize all sessions to data/sessions.json
2. Write close timestamp to data/app_closed_at
3. std::process::exit(0)
```

### On Startup

```
1. Load config.yaml + config.local.yaml
2. Create empty SessionStore
3. Read data/sessions.json (last known sessions)
4. Check data/app_closed_at:
   - If downtime < 1 hour:
     - Overlay JSONL events from data/events/*.jsonl
     - Restore event/tool/file/attention fields
   - If downtime > 1 hour:
     - Only restore meta fields (pinned/muted/title)
     - Hook fields start fresh (old state is stale)
5. Clear stale attention (non-idle with attention = leftover)
6. Restore pinned IDs + muted IDs + titles
7. Start HTTP server + scanners + attention loop
8. Scanners immediately discover current sessions
9. Create overlay window (after 5s delay for Vite)
```

### Event Persistence (Debug/Cache)

Every `POST /event` appends to `data/events/{session_id}.jsonl`:
```json
{"session_id":"ide-abc123","event":"tool","tool":"execute_bash","mtime":1723987300.5}
{"session_id":"ide-abc123","event":"running","tool":"","mtime":1723987301.2}
```

These files grow unbounded (parked issue). Used for:
- Startup recovery (replay recent events)
- Debugging (inspect what happened to a session)

## 8. Cross-Window Communication

The four frontend windows (Panel, Overlay, BSB, Settings) share state through:

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Panel   │    │ Overlay  │    │   BSB    │    │ Settings │
└────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │               │
     │  Tauri events: "state-changed", "config-changed"
     │◀──────────────┼───────────────┼───────────────┤
     │               │               │               │
     │  localStorage (instant cross-window):         │
     │  - nagents:mode_assignments (overlay → panel)   │
     │  - nagents:battery_saver (panel → overlay)      │
     │  - nagents:overlay_hidden_until (panel → overlay)│
     │  - nagents:group_as_one, nagents:group_display    │
     │               │               │               │
     │  HTTP API (same backend):                     │
     │  GET /state, GET /config, POST /event         │
     ├───────────────┼───────────────┼───────────────┤
     │               │               │               │
     ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────┐
│ Rust Backend (single source of truth)                    │
│ SessionStore + ConfigHandle                              │
└─────────────────────────────────────────────────────────┘
```

## 9. Field Ownership Model

Critical to understanding state: different systems own different fields.

| Field | Owner | Updated By | Notes |
|-------|-------|-----------|-------|
| id, source, name | Scanner | push_sessions | Stable identifiers |
| workspace, group | Scanner | push_sessions | Derived from Kiro state files |
| tokens, max_tokens | Scanner | push_sessions | Context window usage |
| active | Scanner | push_sessions | Session exists in Kiro |
| event | Hook | push_event | "tool"/"running"/"idle"/"approval"/"stuck" |
| tool, file | Hook | push_event | Current tool + target |
| prompt, description | Hook | push_event | User prompt + agent summary |
| status, priority | Hook | push_event | Agent-declared state |
| action_text | Hook | push_event | Pre-formatted display text |
| workers, sub_agents | Hook | push_event | Worker lifecycle tracking |
| tool_ok, tool_result | Hook | push_event | Last tool outcome |
| attention | Attention loop | compute() | Derived from event age |
| attention_reason | Attention loop | compute() | Human-readable explanation |
| attention_since | Attention loop | compute() | Recency tracking |
| pinned, muted | User (panel) | push_event | Via panel right-click |
| character | User/Config | push_event | Per-session override or pool assignment |
| on_overlay | Backend | toggle_overlay | Tracks visibility |
| mtime | Both | Most recent wins | Last update timestamp |
| last_user_ts | Hook | UserPromptSubmit | For LRU/FIFO ordering |
| interaction_count | Hook | UserPromptSubmit | For frequency sorting |
