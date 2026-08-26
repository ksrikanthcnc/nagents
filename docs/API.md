# API Reference

Complete reference for the nagents HTTP API and Tauri IPC interface.

## HTTP API

Base URL: `http://127.0.0.1:{http_port}` (default port: 3335, configured in config.yaml)

All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

---

### GET /health

Liveness check.

**Response:**
```json
{"status": "ok"}
```

---

### GET /state

Full state snapshot of all tracked sessions.

**Response:**
```json
{
  "sessions": [
    {
      "id": "ide-abc12345",
      "source": "kiro-ide",
      "name": "Fix login bug",
      "workspace": "~/work/git/my-project",
      "group": "my-project",
      "active": true,
      "event": "running",
      "attention": false,
      "attention_reason": null,
      "tool": null,
      "file": null,
      "tokens": 45000,
      "maxTokens": 200000,
      "mtime": 1723987200.5,
      "character": "ghost",
      "attention_since": null,
      "on_overlay": true,
      "pinned": false,
      "muted": false,
      "tool_ok": true,
      "tool_result": "3/5: Fix stale tool bug",
      "prompt": "fix the overlay rendering",
      "description": "Working on overlay physics",
      "status": "in_progress",
      "priority": null,
      "action_text": "Working on overlay physics",
      "sub_agents": 2,
      "workers": ["cg:analyze code", "task:run tests"],
      "last_user_ts": 1723987100.0,
      "interaction_count": 5
    }
  ],
  "count": 1,
  "timestamp": 1723987300.5
}
```

---

### GET /config

Current merged configuration (base + local).

**Response:** Full `Config` object (see config.yaml for schema).

---

### GET /cursor

Current mouse cursor position (screen coordinates, macOS).

**Response:**
```json
{"x": 1234.0, "y": 567.0}
```

**Notes:**
- macOS: CoreGraphics `CGEventGetLocation`
- Windows: `GetCursorPos` WinAPI
- Linux: `xdotool getmouselocation` (returns 0,0 if unavailable)

---

### GET /scan

Force all scanners to run immediately (useful after config changes).

**Response:**
```json
{"ok": true, "scanned": 7}
```

`scanned` = total number of sessions discovered across all sources.

---

### POST /sessions

Push a batch of sessions from a scanner. Used internally by scanner.rs, but also available for external tools.

**Request body:** JSON array of Session objects (see [SOURCE_CONTRACT.md](SOURCE_CONTRACT.md)).

```json
[
  {
    "id": "ide-abc12345",
    "source": "kiro-ide",
    "name": "My Session",
    "workspace": "~/project",
    "group": "project",
    "active": true,
    "tokens": 50000,
    "maxTokens": 200000,
    "mtime": 1723987200.5
  }
]
```

**Response:**
```json
{"ok": true}
```

**Side effects:**
- Updates meta fields on existing sessions
- Creates new sessions (assigns random character)
- GC: removes sessions from this source not in the batch

---

### POST /event

Push a partial event update for a session. Primary integration point for hooks.

**Request body:**
```json
{
  "session_id": "ide-abc12345",
  "event": "tool",
  "tool": "execute_bash",
  "file": "src/main.ts",
  "mtime": 1723987300.5
}
```

**All fields except `session_id` are optional.** Rules:
- `null` or absent → don't touch the field
- `""` (empty string) → clear the field to None
- `"value"` → set the field

**Available fields:**

| Field | Type | Description |
|-------|------|-------------|
| session_id | string (required) | Target session (exact or prefix match) |
| event | string | "tool", "running", "idle", "approval", "stuck" |
| tool | string | Current tool name (clear with "") |
| file | string | Current file/target (clear with "") |
| mtime | float | Event timestamp (epoch seconds) |
| tool_ok | boolean | Last tool success/failure |
| tool_result | string | Short result text |
| prompt | string | User's latest prompt |
| description | string | Agent self-summary |
| status | string | "in_progress", "completed", "waiting_on_user", "idle" |
| priority | string | "high", "normal", "low" |
| action_text | string | Pre-formatted display text |
| worker | string | "+name" to spawn, "-name" to complete |
| pinned | boolean | Pin/unpin session |
| muted | boolean | Mute/unmute session |

**Response:**
```json
{"ok": true}
```

**Side effects:**
- Persists event to `data/events/{session_id}.jsonl`
- If pinned/muted changed, persists to `data/sessions.json`
- Emits `state-changed` Tauri event to all windows

---

### POST /title

Set a session's display title.

**Request body:**
```json
{
  "session_id": "ide-abc12345",
  "title": "Deploy Monitor"
}
```

**Response:**
```json
{"ok": true}
```

**Side effects:**
- Updates in-memory session name
- Persists to `data/sessions.json`

---

### POST /character

Override a session's character.

**Request body:**
```json
{
  "session_id": "ide-abc12345",
  "character": "cat"
}
```

**Response:**
```json
{"ok": true}
```

---

### POST /config

Patch overlay configuration. Writes to `config.local.yaml` (triggers hot-reload).

**Request body:**
```json
{
  "overlay": {
    "max_followers": 3,
    "working_mode": "queue"
  }
}
```

**Response:**
```json
{"ok": true}
```

**Side effects:**
- Deep-merges patch into existing `config.local.yaml`
- File watcher triggers config hot-reload
- `config-changed` event propagates to all windows

---

### GET /test/start

Create a test session (for development/debugging).

**Response:**
```json
{"ok": true, "action": "start"}
```

Creates a session with ID `test-001`, source `kiro-ide`, name `Test Session`.

---

### GET /test/clear

Remove all test sessions.

**Response:**
```json
{"ok": true, "action": "clear"}
```

---

## Tauri IPC Commands

Commands invokable from TypeScript frontend via `@tauri-apps/api/core` `invoke()`.

---

### get_state

Get full state snapshot.

```typescript
const state: StateSnapshot = await invoke("get_state");
```

**Returns:** Same structure as `GET /state`.

---

### get_config

Get current config.

```typescript
const config: Config = await invoke("get_config");
```

---

### toggle_overlay

Show or hide the overlay window. Syncs `on_overlay` flags on sessions.

```typescript
const isVisible: boolean = await invoke("toggle_overlay");
```

---

### create_overlay

Create (or recreate) the transparent overlay window.

```typescript
await invoke("create_overlay");
```

**Notes:** Destroys existing overlay first (fresh WebKit instance, no cache issues).

---

### hide_overlay

Hide the overlay window.

```typescript
await invoke("hide_overlay");
```

---

### set_overlay_clickthrough

Toggle mouse event passthrough on the overlay.

```typescript
await invoke("set_overlay_clickthrough", { ignore: true }); // Click-through
await invoke("set_overlay_clickthrough", { ignore: false }); // Interactive
```

---

### show_bsb_window / hide_bsb_window

Show or hide the Battery Saver Box window.

```typescript
await invoke("show_bsb_window");
await invoke("hide_bsb_window");
```

---

### show_settings_window

Open the settings window (creates if not exists, focuses if exists).

```typescript
await invoke("show_settings_window");
```

---

## Tauri Events

Events emitted from the Rust backend to all frontend windows.

### state-changed

Emitted on every state mutation (session push, event push, attention update).

```typescript
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen("state-changed", async () => {
  const state = await invoke("get_state");
  // Re-render with fresh state
});
```

**Payload:** None (frontend fetches fresh state after receiving event).

---

### config-changed

Emitted when config files change (hot-reload via fs watcher).

```typescript
const unlisten = await listen("config-changed", async () => {
  const config = await getConfig();
  // Apply new settings
});
```

**Payload:** None.

---

## Frontend Bridge (ui/shared/bridge.ts)

Abstraction layer that handles Tauri vs. browser mode transparently.

```typescript
import { getState, getConfig, onStateChanged, onConfigChanged, pollState, log } from "./bridge";

// Reactive state (Tauri events with HTTP fallback)
const cleanup = await onStateChanged((state) => {
  // Called immediately + on every state change
});

// Config reactivity
const cleanup2 = await onConfigChanged((config) => {
  // Called immediately + on every config change
});

// Direct fetch
const state = await getState();
const config = await getConfig();

// Polling fallback (for browser-only mode)
const stopPoll = pollState((state) => { ... }, 1500);
```

**Detection logic:** Checks `"__TAURI__" in window`. If true, uses Tauri IPC. If false, falls back to HTTP polling (useful for standalone browser dev).

---

## Worker Lifecycle Protocol

Sub-agents (workers) are tracked via the `worker` field in event updates:

```
Spawn: POST /event { "session_id": "ide-abc", "worker": "+cg:analyze code" }
  → workers becomes ["cg:analyze code"], sub_agents becomes 1

Done:  POST /event { "session_id": "ide-abc", "worker": "-cg" }
  → workers removes first entry matching "cg", sub_agents decremented

Format: "+shortname:description" (spawn) or "-shortname" (done)
```

Worker name prefixes map to satellite characters:
| Prefix | Character |
|--------|-----------|
| cg, context-gatherer | wisp |
| task, general-task | spark |
| creator, custom-agent | flame |
| reviewer, semantic | orb |
| knowledge | owl |
| lite | blob |
| introspect | crystal |

---

## nagents: Command Protocol

Users can set session titles/groups by typing `nagents:` commands in any prompt:

```
Format: nagents:<session_id_prefix>:<group>:<title>

Examples:
  nagents:abc12345:k8s:deploy-monitor    → group=k8s, title=deploy-monitor
  nagents:abc12345::my-title             → no group change, just title
  nagents:abc12345::                     → reset (remove manual title)
```

Parsed by `kiro_translate.py` during `UserPromptSubmit` events. The hook POSTs to `/title` for all possible source prefixes (`ide-`, `cli3-`, `cli2-`) and persists to `data/sessions.json`.
