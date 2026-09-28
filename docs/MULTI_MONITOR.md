# Multi-Monitor Support

## Overview
nagents renders animated overlay characters across multiple displays. Each monitor
gets its own transparent overlay window. A lead/follower architecture ensures one
physics engine drives all displays with consistent trajectories.

## Architecture

### Why per-display windows
macOS WindowServer does not render a single window's content on secondary displays,
even when the window frame spans the virtual desktop. Each monitor needs its own
overlay window.

### Lead/Follower model
- **Lead** (primary display): runs full physics — cursor polling, mode assignment,
  velocity/collision, position updates. Broadcasts char positions to followers via
  Tauri events (`emit("nagents:charPositions")`).
- **Followers** (secondary displays): pure renderers. Receive broadcast positions,
  create/remove DOM elements, position via `transform: translate()` (GPU-composited).
  No physics, no cursor polling, no mode assignment.

### Display bounds delivery
Each overlay window calls `invoke("get_overlay_display_info")` on init. The Rust
backend returns `WindowDisplayInfo` with display origin, size, virtual desktop
bounds, and the `is_lead` flag. The Rust side populates `WINDOW_DISPLAY_MAP` before
calling `.build()` on the WebView to avoid a race condition.

## Coordinate System
- **Global/virtual space**: origin at top-left of primary display, Y down. Displays
  left/above primary have negative x/y. All physics runs in this space.
- **Per-display local space**: origin (0,0) at top-left of that display's window.
  `local = virtual - displayOrigin`. Used for CSS positioning on each window.

## Broadcast
The lead broadcasts every physics frame (no throttle). Payload:
```
{ chars: { sessionId: [x, y, mode, charId, name, group, event] }, cx, cy, hiddenCount }
```
Positions are in global/virtual space. Each follower maps to local coords.

Hidden (mode-assigned overflow) and leaving (walk-off) chars are excluded from
the broadcast — followers don't know how to animate them, so they'd appear as
frozen artifacts.

## Performance
- Physics runs at `physics_fps` (default 60, auto-bumped to match the display's
  refresh rate if higher).
- Off-display chars on the lead run physics-only (position/velocity updates) but
  skip all DOM operations (classList, style writes, querySelector, rendering helpers).
  This eliminates ~14K wasted DOM ops/sec for off-display chars.
- Follower positioning uses `transform: translate()` with `will-change: transform`
  for GPU-composited rendering (prevents ghost trail artifacts on transparent windows).
- Collision uses `mode === "hidden"` check instead of DOM property reads.

## Config
```yaml
overlay:
  multi_screen: false           # All chars use every display
  attention_cross_screen: true  # Attention sessions follow cursor cross-display
  hide_from_capture: true       # Hide overlay from screenshots/screen share
  physics_fps: 60               # Set to max monitor Hz for smoothest multi-monitor
```
Either `multi_screen` or `attention_cross_screen` on → per-display overlay mode.
Both off → single primary display (original behavior).

## Roamer behavior
Roamers stick to whichever display the cursor is on. When the cursor moves to a
different display, roamers immediately redirect (cancel walk to old display, pick
new target on the cursor's display). Target picking uses a deterministic PRNG
(murmur3 finalizer on session ID + pick counter) for reproducible but well-distributed
positions.
