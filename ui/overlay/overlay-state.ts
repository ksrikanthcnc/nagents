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
  spawnedAt: number;
  /** Timestamp when mode was last changed */
  modeSetAt: number;
  /** If set, this char is clustered to the given session (targets its position, scales down) */
  clusteredTo: string | null;
}

// ─── Shared Mutable State ───────────────────────────────────────────────────

export const cursor: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
export const cursorTarget: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
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
