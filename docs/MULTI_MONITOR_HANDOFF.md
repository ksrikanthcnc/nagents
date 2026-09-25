# Multi-Monitor Handoff — Bug Fix Guide for Next Agent

## Context
nagents is a Tauri v2 desktop overlay app (macOS/Windows/Linux) that renders
animated characters on screen following the user's cursor. Multi-monitor support
was implemented but has remaining bugs. The single-display overlay works correctly.

**Working directory:** `~/work/tasks/kiro-crew/projects/nagents`
**Dev:** `./start.sh` (cargo tauri dev, vite dev server on :5180, HTTP API on :3335)
**Build:** `./start.sh build` (release .app bundle)
**Journal:** `~/work/tasks/kiro-ide/journal/nagents-publish.md`

## Architecture Summary

### Single-display mode (working)
One overlay window (label "overlay") covers the primary monitor. Full physics
(cursor following, roaming, mode assignment) runs in one JS context. Characters
are positioned in window-local CSS pixels. Cursor from `GET /cursor` (global
macOS coords) is offset by -38px Y.

### Multi-display mode (buggy)
When `attention_cross_screen: true` or `multi_screen: true` in config.yaml:
- Rust creates one overlay window per monitor (labels "overlay-0", "overlay-1", ...)
- Each positioned/sized to its display in logical coords
- Primary display (overlay-0, dx=0/dy=0) is the "lead" — runs full physics
- Secondary displays are "followers" — pure renderers receiving positions

### Lead/Follower model
- **Lead** (primary): runs cursor polling, state sync, mode assignment, physics.
  Positions are in GLOBAL/VIRTUAL space (matching CGEventGetLocation coords).
  Broadcasts char positions to followers via Tauri `emit("nagents:charPositions")`.
- **Followers**: listen via Tauri `listen("nagents:charPositions")`. Receive
  `{chars: {id: [x,y,mode,charId,name,group,event]}, cx, cy}`. Map virtual→local
  via `toDisplayLocal(vx - dx, vy - dy)`. Only render chars on their display.

### Display bounds delivery
Each window calls `invoke("get_overlay_display_info")` on init. The Rust command
returns `WindowDisplayInfo {dx, dy, dw, dh, vox, voy, vw, vh, is_lead, displays[]}`.
The map (`WINDOW_DISPLAY_MAP`) is populated BEFORE `WebviewWindowBuilder::build()`
to avoid a race condition (build starts JS immediately).

## Known Bugs to Fix

### Bug 1: Artifacts (frozen chars on secondary displays)
**Symptom:** Chars appear stuck at edges of secondary displays, not moving or
following the cursor. They persist even when sessions go inactive.

**Likely causes (investigate in order):**
1. **Tauri event delivery**: `emit("nagents:charPositions")` from the lead may not
   reliably reach follower windows. Tauri events go through the Rust IPC bridge —
   verify they actually arrive. Add logging in the follower's `listen` callback.
2. **Follower not entering follower mode**: If `get_overlay_display_info` returns
   null (race condition, though supposedly fixed by moving map insert before build),
   the window falls through to full independent physics → runs its own chars → artifacts.
   Check the Rust log for "get_overlay_display_info called by 'overlay-N' → found/NOT FOUND".
3. **HMR interference**: Vite HMR page reloads during dev can reset the overlay's
   JS state (isPerDisplay, isLeadWindow revert to defaults). After HMR, the window
   may revert to independent mode. Consider: on HMR, re-call get_overlay_display_info.

**Debug approach:**
- Check Rust logs: `grep "get_overlay_display_info" .nagents.log` — all should say "found"
- Check debug panel: primary should show 🟢 Lead, others 🔵 Follower
- If all show Lead → follower detection failed (IPC returned null or flag not set)
- Add `console.log` at key points in initOverlay and startFollowerRenderer

### Bug 2: App crashes (SIGABRT / foreign exception)
**Symptom:** App dies with "Rust cannot catch foreign exceptions, aborting" or
"Must only be used from the main thread."

**Root cause:** Any AppKit/NSWindow operation (setCollectionBehavior, setStyleMask,
setLevel, to_panel) that runs off the main thread or during a HMR page reload
triggers an ObjC exception that Rust can't catch → abort.

**Current mitigation:** All macOS window modifications (NSPanel swizzle, light
exclusion) are SKIPPED in dev builds (`if !cfg!(debug_assertions)`). Release builds
still apply them. This means AltTab hiding doesn't work in dev — acceptable.

**To fix properly:** The `to_panel()` swizzle (tauri-nspanel) is the most fragile.
Consider: only swizzle in release builds, or find a way to make it HMR-safe.

### Bug 3: FPS degradation on follower displays
**Symptom:** Follower displays start smooth then get choppy, eventually freezing.

**Possible causes:**
- Tauri event delivery may batch/delay under load (33 chars × 15fps = 495 events/sec)
- The lead's `emit()` is async (dynamic import of @tauri-apps/api/event each call) —
  this creates import overhead. Cache the import.
- Follower's `listen` callback does DOM manipulation (createElement, remove) which
  can cause layout thrash if many chars update at once.

**Optimization ideas:**
- Cache `import("@tauri-apps/api/event")` — resolve once, reuse the emit function
- Reduce broadcast frequency to ~10fps (every 6 frames instead of 4)
- Batch DOM updates in the follower (documentFragment or requestAnimationFrame)

### Bug 4: Walk-off / hidden chars not cleaned up properly
**Symptom:** Chars that should walk off (session ended, went inactive) sometimes
stay visible as frozen artifacts on secondary displays.

**Root cause:** The lead's walk-off animation and char removal happen in its own
`syncChars` / physics. When a char is removed from the lead's `chars` Map, it
disappears from the next broadcast → the follower's cleanup loop (`activeIds` check)
should remove it. If the follower isn't receiving broadcasts (Bug 1), it never
gets the removal signal.

**Fix:** Ensure Bug 1 is fixed first. Then: the follower should also have a
timeout-based cleanup — if a char hasn't been updated in N seconds, remove it
(safety net for missed broadcasts).

## Key Files

| File | Role |
|------|------|
| `src-tauri/src/overlay.rs` | Window creation, per-display setup, NSPanel, display bounds IPC |
| `src-tauri/src/lib.rs` | App setup, Tauri command registration, overlay creation thread |
| `ui/overlay/overlay.ts` | Lead init, follower renderer, cursor polling, state sync |
| `ui/overlay/physics.ts` | Physics simulation, broadcastCharPositions, toDisplayLocal |
| `ui/overlay/overlay-state.ts` | Shared state: cursor, chars, display bounds, isLeadWindow |
| `ui/overlay/debug-panel.ts` | Draggable debug panel (shows on every display) |
| `ui/overlay/dom.ts` | Char DOM creation, roam targets, seeded PRNG |
| `ui/overlay/modes.ts` | Mode assignment waterfall |
| `src-tauri/src/cursor.rs` | Platform cursor position (CGEventGetLocation on macOS) |
| `src-tauri/src/server.rs` | HTTP API: /cursor (with display rects), /state, /event |
| `config.yaml` | `multi_screen`, `attention_cross_screen` toggles |

## Coordinate System
- Global/virtual: origin at top-left of primary display, Y down. Negative x/y for
  displays left/above primary. CGEventGetLocation points (logical).
- Per-display local: origin (0,0) at top-left of that display's window.
  `local = virtual - displayOrigin`
- `toDisplayLocal(vx, vy)` in physics.ts maps virtual → local, returns null if
  outside this display ± 500px margin.
- `canvasW()/canvasH()` = virtual desktop total size when per-display is active.

## Test Setup
User has: MacBook Pro (primary, 1800×1169 @2x) + 2× Dell P2425HE (1920×1080 @1x).
Left Dell at (-1920, 0), Right Dell at (1800, 0).

## Config
```yaml
overlay:
  multi_screen: true            # All chars on all displays
  attention_cross_screen: true  # Attention chars follow cursor cross-display
```

## What Works
- Single-display overlay: all features (attention-follows, timers, cluster, sleep/wake, etc.)
- Per-display window creation: windows are correctly positioned on all 3 monitors
- Display bounds IPC: all windows get correct bounds (verified in Rust logs)
- NSPanel AltTab exclusion (release builds only; dev skips to avoid crashes)
- Debug panel: shows on each display, Lead vs Follower correctly identified

## What Doesn't Work
- Chars following across screens (the main goal)
- Artifact cleanup on secondary displays
- Stable FPS on follower displays
- App stability during dev (HMR-triggered crashes)
