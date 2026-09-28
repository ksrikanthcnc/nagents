/**
 * overlay-state.ts — Shared mutable state for the overlay system.
 *
 * All overlay modules import state from here to avoid circular deps.
 * State is module-level (singleton) — safe because overlay runs in a single window.
 */

import type { Session, CursorPosition, OverlayConfig } from "../shared/types";
import type { CharMode } from "./modes";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OverlayChar {
  session: Session;
  el: HTMLElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: CharMode;
  roamTarget: { x: number; y: number };
  roamTimer: number;
  /** Monotonic counter incremented on each roam target pick. Used as the
   *  seededRandom counter so each pick produces a different position. */
  roamPickCount: number;
  spawnedAt: number;
  /** Timestamp when mode was last changed */
  modeSetAt: number;
  /** If set, this char is clustered to the given session (targets its position, scales down) */
  clusteredTo: string | null;
  /** Cluster anchor (the sun that owns the group's waterfall slot). */
  clusterAnchor?: boolean;
  /** Cluster center seat (carousel): currently rendered at the bright center. */
  clusterCenter?: boolean;
}

// ─── Shared Mutable State ───────────────────────────────────────────────────

// Cursor is initialized to center of the window. In per-display mode this gets
// overwritten immediately by the first /cursor poll (global coords); the init
// value only matters for the brief moment before that first poll.
export const cursor: CursorPosition = { x: 0, y: 0 };
export const cursorTarget: CursorPosition = { x: 0, y: 0 };
export const chars: Map<string, OverlayChar> = new Map();

export let container: HTMLElement | null = null;
export function setContainer(el: HTMLElement | null): void { container = el; }

export let animFrameId: number | null = null;
export function setAnimFrameId(id: number | null): void { animFrameId = id; }

export let globalRevolveAngle = 0;
export function advanceRevolveAngle(delta: number): void { globalRevolveAngle += delta; }

export let cursorReady = false;
export function setCursorReady(v: boolean): void { cursorReady = v; }

export let lastSummaryLog = 0;
export function setLastSummaryLog(v: number): void { lastSummaryLog = v; }

export let hiddenBadgeEl: HTMLElement | null = null;
export function setHiddenBadgeEl(el: HTMLElement | null): void { hiddenBadgeEl = el; }

export let allCharsHidden = false;
export function setAllCharsHidden(v: boolean): void { allCharsHidden = v; }

export let frameInterval = 1000 / 60;
export function setFrameInterval(v: number): void { frameInterval = v; }

export let CHAR_SIZE = 44;
export function setCharSize(v: number): void { CHAR_SIZE = v; }

// ─── Virtual desktop bounds (multi-monitor) ─────────────────────────────────
// The overlay window's logical size. When spanning multiple displays this is
// the virtual-desktop size; otherwise it matches the single display. Char
// positions are clamped to this (falls back to window.innerWidth/Height until
// the first /cursor response populates it). Origin subtraction is done in the
// cursor poll, so these are window-LOCAL bounds (0,0 top-left of the window).
export let vWidth = 0;
export let vHeight = 0;
export function setVirtualBounds(w: number, h: number): void { vWidth = w; vHeight = h; }
/** Effective canvas width/height — virtual bounds if known, else window inner. */
export function canvasW(): number { return vWidth > 0 ? vWidth : window.innerWidth; }
export function canvasH(): number { return vHeight > 0 ? vHeight : window.innerHeight; }

// ─── Deterministic PRNG (shared trajectory across per-display windows) ──────
// All windows must compute identical positions for the same char. Math.random()
// diverges across windows. This simple hash-based PRNG takes a session id + a
// counter and returns a deterministic [0,1) float. Every window seeding the
// same (id, counter) gets the same value → trajectories converge.

/** Simple hash (djb2) of a string → 32-bit unsigned int. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministic random [0,1) for a session id + counter.
 *  Uses djb2 of the session id as a base, then mixes the counter in with
 *  a murmur-style finalizer so consecutive counters produce well-distributed
 *  values (the old approach of appending `:counter` as a string only changed
 *  the last byte of the hash → same float for counters 0-9). */
export function seededRandom(sessionId: string, counter: number): number {
  let h = djb2(sessionId);
  // Mix counter with murmur3 finalizer for good distribution.
  let k = counter >>> 0;
  k = Math.imul(k ^ (k >>> 16), 0x45d9f3b) >>> 0;
  k = Math.imul(k ^ (k >>> 13), 0x45d9f3b) >>> 0;
  k = (k ^ (k >>> 16)) >>> 0;
  h = (h ^ k) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0x7fffffff) / 0x80000000;
}

// ─── Per-display bounds (per-display overlay mode) ──────────────────────────
// In per-display mode, each overlay window covers one monitor. These fields
// describe THIS window's display region in the global/virtual coordinate space.
// In single-window mode (no query params), they default to (0,0, innerW, innerH).
//
// dx/dy = this display's logical origin in the virtual desktop.
// dw/dh = this display's logical size.
// vox/voy = the virtual desktop's origin (min x/y across all displays).
// The virtual position of a char = (local x + dx, local y + dy) in global space.
// A char is visible on this display if its virtual pos falls in [dx..dx+dw, dy..dy+dh].
export let displayOriginX = 0;
export let displayOriginY = 0;
export let displayWidth = 0;
export let displayHeight = 0;
export let virtualOriginX = 0;
export let virtualOriginY = 0;
export let isPerDisplay = false;
/** True on the primary overlay window that owns physics. False on follower
 * windows that are pure renderers reading positions from localStorage. */
export let isLeadWindow = true;
export function setIsLeadWindow(v: boolean): void { isLeadWindow = v; }

// Latest follower frame (set by BroadcastChannel onmessage in the follower renderer).
// Read by the debug panel to build char lists on follower windows.
export let latestFollowerFrame: Record<string, [number, number, string, string, string, string, string]> = {};
export function setLatestFollowerFrame(f: typeof latestFollowerFrame): void { latestFollowerFrame = f; }

export function setDisplayBounds(dx: number, dy: number, dw: number, dh: number, vox: number, voy: number): void {
  displayOriginX = dx;
  displayOriginY = dy;
  displayWidth = dw;
  displayHeight = dh;
  virtualOriginX = vox;
  virtualOriginY = voy;
  isPerDisplay = true;
}

// Display rects (all monitors) — populated from /cursor response by the lead.
// Used to determine which display the cursor is on (roamer sticking).
export interface DisplayRectInfo { x: number; y: number; w: number; h: number }
export let displayRects: DisplayRectInfo[] = [];
export function setDisplayRects(rects: DisplayRectInfo[]): void { displayRects = rects; }

/** Find which display rect contains a point (global coords). Returns the rect, or null. */
export function displayContaining(gx: number, gy: number): DisplayRectInfo | null {
  for (const r of displayRects) {
    if (gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h) return r;
  }
  return null;
}

// ─── Config (overlay-specific) ──────────────────────────────────────────────

export let cfg: OverlayConfig = {
  follow_strength: 0.04,
  roam_strength: 0.008,
  roam_max_speed: 3,
  follow_max_speed: 6,
  min_cursor_distance: 80,
  collision_distance: 100,
  revolve_radius: 50,
  revolve_speed: 0.015,
  shrink_after_min: 15,
  dot_scale: 0.55,
  cursor_fps: 5,
  cursor_smoothing: 0.07,
  physics_fps: 60,
  font_size_group: 9,
  font_size_title: 10,
  font_size_action: 10,
  max_followers: 2,
  max_dots: 5,
  max_roamers: 3,
  pin_counts_toward_max: false,
  group_as_one: false,
  source_as_group: false,
  follower_mode: "priority,lifo",
  round_robin_sec: 10,
};

export function setCfg(newCfg: OverlayConfig): void { cfg = newCfg; }

// ─── Constants ──────────────────────────────────────────────────────────────

export const DAMPING = 0.88;
