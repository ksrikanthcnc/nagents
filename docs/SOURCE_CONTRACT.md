# Source Contract

This document defines the interface between source plugins and the nagents backend.

## Overview

A **source** is any executable that discovers agent sessions. It can be written
in any language (Python, shell, Go, Rust, Node, etc.).

Two delivery modes:
1. **Scanner** — called periodically, outputs full state to stdout
2. **Hook** — pushes incremental events via HTTP POST

## Scanner Output Schema

The scanner must print a **JSON array** of sessions to stdout and exit 0.
Any logging goes to stderr (which nagents captures for debugging).

```json
[
  {
    "id": "ide-abc12345",
    "source": "kiro-ide",
    "name": "Fix login bug",
    "workspace": "~/work/git/my-project",
    "group": "my-project",
    "active": true,
    "event": null,
    "attention_source": null,
    "attention": false,
    "attention_reason": null,
    "tool": null,
    "file": null,
    "tokens": 45000,
    "maxTokens": 200000,
    "mtime": 1723987200.5,
    "character": null,
    "attention_since": null,
    "on_overlay": false
  }
]
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique session ID (prefix with source, e.g., `ide-abc12345`) |
| `source` | string | Must match the source key in config.yaml |
| `name` | string | Display name (truncate to 50 chars) |
| `active` | boolean | Is this session currently active? |
| `mtime` | float | Last modification time (epoch seconds) |

### Optional fields (scanner can set or leave null/default)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace` | string | `""` | Workspace path (display, use ~ prefix) |
| `group` | string | `""` | Group ID for panel grouping |
| `event` | string? | `null` | Current event state |
| `attention_source` | bool? | `null` | Explicit attention (null = let core rules decide) |
| `attention` | bool | `false` | Computed (backend sets this, ignored from scanner) |
| `attention_reason` | string? | `null` | Human-readable reason |
| `tool` | string? | `null` | Current tool being used |
| `file` | string? | `null` | Current file being modified |
| `tokens` | int | `0` | Tokens used in session |
| `maxTokens` | int | `200000` | Max context window |
| `character` | string? | `null` | Character override (null = use config default) |
| `attention_since` | float? | `null` | Backend-managed, ignored from scanner |
| `on_overlay` | bool | `false` | Backend-managed, ignored from scanner |

## Hook Push Schema

Hooks push incremental updates via HTTP:

```
POST http://127.0.0.1:3334/event
Content-Type: application/json

{
  "session_id": "ide-abc12345",
  "event": "tool",
  "attention": null,
  "tool": "execute_bash",
  "file": "src/main.ts",
  "mtime": 1723987300.5
}
```

### EventUpdate fields

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session to update (exact or prefix match) |
| `event` | string? | New event state (null = don't change) |
| `attention` | bool? | Set attention_source (null = don't change) |
| `tool` | string? | Tool name (null = don't change) |
| `file` | string? | File path (null = don't change) |
| `mtime` | float? | Override mtime (null = use current time) |

### Standard event values

| Event | Meaning |
|-------|---------|
| `running` | Agent is actively working |
| `tool` | Tool execution in progress (attention if >30s) |
| `idle` | Agent finished, waiting for user |
| `approval` | Set by core rules: tool stuck >30s |
| `stuck` | Set by core rules: running >120s |

## Field Ownership

| Field | Owner | Notes |
|-------|-------|-------|
| id, source, name, workspace, group, tokens, maxTokens | Scanner | Overwritten each scan cycle |
| event, tool, file, attention_source | Hook | Never overwritten by scanner |
| active, mtime | Both | Most recent wins |
| attention, attention_reason, attention_since, on_overlay | Backend | Computed by core rules |

## Garbage Collection

When a scanner reports sessions for a source, any sessions from that source
NOT included in the report are removed. This is automatic GC — if a session
closes, just stop reporting it.

## Error Handling

- Scanner exits non-zero → logged as warning, state unchanged
- Scanner outputs invalid JSON → logged as error, state unchanged
- Hook targets unknown session → minimal session created (scanner fills meta later)
- Scanner field doesn't match source ID → logged as error
