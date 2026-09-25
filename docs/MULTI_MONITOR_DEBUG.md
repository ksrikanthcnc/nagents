# Multi-Monitor Overlay — Architecture & Debug Guide

## Problem Statement
nagents needs to show animated overlay characters across multiple macOS displays.
Characters should follow the cursor onto any screen, with one physics engine
controlling positions and multiple per-display windows rendering.

## Architecture

### Why per-display windows (not a single spanning window)
macOS WindowServer does NOT render a single window's content on secondary displays,
even when the window frame spans the virtual desktop. Tested with both plain NSWindow
and NSPanel — the content only paints on the display the window "belongs" to. This is
a macOS WindowServer limitation, not a Tauri/WKWebView issue.

### Per-display window setup
- **Rust (`overlay.rs`)**: `create_per_display_overlays()` creates one overlay window
  per monitor, each positioned and sized to its display in logical (point) coordinates.
- Each window loads `overlay.html?dx=<x>&dy=<y>&dw=<w>&dh=<h>&vox=<vo_x>&voy=<vo_y>&vw=<total_w>&vh=<total_h>&dpr=<scale>&lead=<0|1>`
- Windows are transparent, borderless, always-on-top, click-through, all-workspaces.
- On macOS, the lead (primary) window is swizzled to NSPanel (via tauri-nspanel) for
  AltTab exclusion; follower windows get lighter collectionBehavior+level treatment.

### Lead/Follower model
**The core design**: one "lead" window runs the full physics simulation; all other
windows are pure renderers that read positions from localStorage.

- **Lead window** (primary display, `dx=0 && dy=0`):
  - Runs the full overlay: cursor polling, state sync, mode assignment, physics, rendering.
  - Every ~4 frames, writes char positions to `localStorage["nagents:charFrame"]`.
  - Also writes cursor position to `localStorage["nagents:cursorPos"]`.
  - Renders chars on its own display using `toDisplayLocal()` clipping.

- **Follower windows** (secondary displays, `dx !== 0 || dy !== 0`):
  - Do NOT run physics, cursor polling, mode assignment, or state sync.
  - On each `requestAnimationFrame`, read `nagents:charFrame` from localStorage.
  - Create/update DOM elements at the broadcast positions, mapped through `toDisplayLocal()`
    for their display region.
  - Pure renderers — zero independent state, zero divergence.

### Why this model
3 independent JS VMs running independent physics **will always diverge** over time,
because:
1. Frame-timing jitter: `requestAnimationFrame` fires at slightly different real-time
   moments on each window → velocity integration diverges.
2. Cursor lerp timing: `cursor.x += (target - cursor.x) * 0.12` with different frame
   times → different interpolated positions.
3. Random values: even seeded PRNG diverges if the seed counter (roamTimer) advances at
   different rates per window.
4. State-change timing: `onStateChanged` events arrive at different moments per window.

The lead/follower model eliminates all of these by having exactly ONE physics engine.

## Coordinate System

### Global / Virtual space
- `CGEventGetLocation` (macOS) returns cursor position in **global screen coordinates**,
  origin at the **top-left of the primary display**, Y increasing downward.
- Displays to the LEFT or ABOVE the primary have **negative** x and/or y.
- Example 3-display setup:
  ```
  Left Dell:  origin (-1920, 0), size 1920×1080
  Primary:    origin (0, 0),     size 1800×1169
  Right Dell: origin (1800, 0),  size 1920×1080
  Virtual desktop: origin (-1920, 0), size 5640×1169
  ```

### Window-local space
- Each per-display window's content is in CSS pixels, origin (0,0) at its top-left.
- `toDisplayLocal(vx, vy)` maps virtual → this display's local:
  `local = (vx - displayOriginX, vy - displayOriginY)`.
- Returns `null` if the position is outside this display ± DISPLAY_MARGIN (500px).

### Lead window physics
- `cursor` and `cursorTarget` are in **global/virtual** space (raw from /cursor).
- `char.x` / `char.y` are in **virtual** space.
- Clamp: `Math.max(vox - 50, Math.min(vox + canvasW + 50, char.x))`.
- DOM rendering: `toDisplayLocal()` maps to this display's local space before writing
  `el.style.left/top`.

### Follower rendering
- Reads `[x, y]` from localStorage (virtual space, as broadcast by lead).
- Maps `lx = vx - dx; ly = vy - dy` where `dx/dy` is this display's origin.
- Only shows chars where `lx` is within `[-MARGIN, dw + MARGIN]`.

## /cursor Endpoint
`GET http://127.0.0.1:3335/cursor` returns:
```json
{
  "x": -697.26,       // global cursor X (can be negative)
  "y": 565.03,        // global cursor Y
  "ox": -1920,        // virtual desktop origin X
  "oy": 0,            // virtual desktop origin Y
  "vw": 5640,         // virtual desktop width
  "vh": 1169,         // virtual desktop height
  "displays": [       // per-display rects (logical coords)
    {"x": 0, "y": 0, "w": 1800, "h": 1169},
    {"x": -1920, "y": 0, "w": 1920, "h": 1080},
    {"x": 1800, "y": 0, "w": 1920, "h": 1080}
  ]
}
```

## localStorage Broadcast
Lead writes every ~4 physics frames (~15fps):

**`nagents:charFrame`** — char positions (virtual space):
```json
{
  "ide-abc123": [900, 500, "follow", "ghost", "my-session", "kiro-ide", "running"],
  ...
}
```
Tuple: `[x, y, mode, charId, name, group, event]`

**`nagents:cursorPos`** — cursor position (virtual space):
```json
{"x": 900, "y": 500}
```

## Debug Panel
- Draggable panel on each display showing: display identity, cursor position, cursor's
  display, all chars sorted by waterfall mode, per-char distance + display region.
- Anomaly detection: 1/sec snapshots, flags count changes and position jumps >500px.
- Lead window also shows `d=NNN` badge under each char element.

## Known Issues Being Investigated

### Bug: All windows show "Lead" instead of Follower
- **Symptom**: All 3 display debug panels show 🟢 Lead. Secondary displays should show
  🔵 Follower. Cursor shows (0,0) on secondary displays.
- **Root cause (suspected)**: The lead detection check `dx === 0 && dy === 0` may not be
  evaluating correctly in the webview — either the URL query params are being lost/cached
  by Tauri's App URL protocol, or the TypeScript module is being shared across windows
  (unlikely since each webview is a separate JS context).
- **Impact**: All 3 windows run independent physics → positions diverge over time → chars
  jump, freeze, or appear inconsistently across displays.
- **Debug approach**: Add a global keyboard shortcut (e.g. Ctrl+Shift+D) that captures
  and logs a full diagnostic snapshot to the Rust backend.

### Bug: App crashes intermittently
- **Symptom**: SIGABRT / "Rust cannot catch foreign exceptions" / abort() called.
- **Root cause**: tauri-nspanel's `to_panel()` swizzle (runtime class change from
  NSWindow to NSPanel) destabilizes the window lifecycle. When the event loop or vite HMR
  accesses the swizzled window, an ObjC exception fires that Rust can't catch → abort.
- **Mitigation**: NSPanel swizzle is now skipped in dev builds (`cfg!(debug_assertions)`).
  Only release builds get NSPanel for AltTab exclusion.

### Workaround: AltTab still shows overlay in dev
- The NSPanel swizzle (which hides from AltTab) is disabled in dev to prevent crashes.
- In release builds, only the lead window gets NSPanel; followers get collectionBehavior+level.
- User can also blacklist nagents in AltTab's preferences.

## Display Change Detection
- A background thread polls `available_monitors()` every 3s.
- On layout change (add/remove display, or config toggle), it calls `create_overlay()`
  which destroys all overlay windows and recreates them for the current layout.
- The monitor signature includes the cross-screen config flag, so toggling
  `multi_screen` / `attention_cross_screen` also triggers recreation.

## Config Toggles
```yaml
overlay:
  multi_screen: false           # All chars use every display (roamers drift to cursor's screen)
  attention_cross_screen: true  # Attention sessions follow cursor across displays (even if multi_screen off)
```
Either toggle on → per-display overlay mode (one window per monitor).
Both off → single-primary overlay (original behavior).

## Files
- `src-tauri/src/overlay.rs` — Window creation, NSPanel conversion, display bounds, monitor watch.
- `ui/overlay/overlay.ts` — Lead init, follower renderer, cursor polling, state sync.
- `ui/overlay/physics.ts` — Physics simulation (lead only), char broadcast, debug badges.
- `ui/overlay/overlay-state.ts` — Shared mutable state, virtual bounds, display rects, seeded PRNG.
- `ui/overlay/debug-panel.ts` — Draggable debug panel module.
- `ui/overlay/dom.ts` — Char DOM creation, roam targets, display-local mapping.
- `ui/overlay/modes.ts` — Mode assignment (waterfall).
- `src-tauri/src/cursor.rs` — Platform-specific cursor position reading.
- `src-tauri/src/server.rs` — HTTP endpoints including /cursor with display rects.

## Test Procedure for Debugging
1. Run `./start.sh` (dev mode, no NSPanel swizzle).
2. Wait for all 3 overlay windows to appear.
3. Check debug panel on each display:
   - Primary should show 🟢 Lead with real cursor coords.
   - Left/Right Dells should show 🔵 Follower with cursor from localStorage.
4. Move cursor to left Dell, observe:
   - Follower chars should track the same positions as lead's broadcast.
   - Chars should be visible on the Dell's overlay window via `toDisplayLocal()`.
5. If "all show Lead" → the lead detection is broken (the core bug).
6. Hit Ctrl+Shift+D → diagnostic snapshot logged to server (implementation pending).
