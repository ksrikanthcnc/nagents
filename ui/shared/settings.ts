/**
 * settings.ts — Unified settings bridge.
 *
 * Single source of truth for reading overlay settings across all windows.
 * Priority: localStorage (live panel changes) → config (persisted baseline).
 *
 * Panel writes to localStorage on every input change (instant reactivity).
 * Panel Save button writes to config.local.yaml (persistence across restarts).
 * On app start, localStorage is empty → config wins.
 * All windows poll this module to get the current effective value.
 */

import type { OverlayConfig } from "./types";

const LS_PREFIX = "nagents:";

/** All settings keys that the panel exposes, with their type hints. */
type SettingType = "number" | "string" | "boolean";

const SETTING_TYPES: Record<string, SettingType> = {
  overlay_mode: "string",
  connectors: "boolean",
  max_followers: "number",
  max_roamers: "number",
  max_dots: "number",
  revolve_radius: "number",
  dot_scale: "number",
  char_size: "number",
  collision_distance: "number",
  follow_strength: "number",
  roam_strength: "number",
  follower_mode: "string",
  panel_mode: "string",
  group_display: "string",
  round_robin_sec: "number",
  group_as_one: "boolean",
  bsb_max_chars: "number",
  bsb_layout: "string",
  bsb_opacity: "number",
  working_mode: "string",
};

/**
 * Get a setting value. Checks localStorage first (panel live changes),
 * falls back to config (Rust-served baseline).
 */
export function getSetting(key: string, cfg: OverlayConfig): unknown {
  const lsVal = localStorage.getItem(`${LS_PREFIX}${key}`);
  const cfgVal = (cfg as any)[key];
  const type = SETTING_TYPES[key] || "string";

  if (lsVal !== null) {
    switch (type) {
      case "number": return parseFloat(lsVal);
      case "boolean": return lsVal === "true";
      default: return lsVal;
    }
  }

  return cfgVal;
}

/** Get a string setting with a default. */
export function getStringSetting(key: string, cfg: OverlayConfig, fallback: string): string {
  const val = getSetting(key, cfg);
  return (val != null && val !== "") ? String(val) : fallback;
}

/** Get a number setting with a default. */
export function getNumberSetting(key: string, cfg: OverlayConfig, fallback: number): number {
  const val = getSetting(key, cfg);
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

/** Get a boolean setting with a default. */
export function getBoolSetting(key: string, cfg: OverlayConfig, fallback: boolean): boolean {
  const val = getSetting(key, cfg);
  if (val === true || val === false) return val;
  if (val === "true") return true;
  if (val === "false") return false;
  return fallback;
}

/**
 * Write a setting to localStorage (for live cross-window reactivity).
 * Called by panel on every input change.
 */
export function setSettingLive(key: string, value: unknown): void {
  localStorage.setItem(`${LS_PREFIX}${key}`, String(value));
}

/**
 * Collect all dirty settings (localStorage values that differ from config).
 * Used by panel Save to build the POST /config payload.
 */
export function getDirtySettings(cfg: OverlayConfig): Record<string, unknown> {
  const dirty: Record<string, unknown> = {};
  for (const key of Object.keys(SETTING_TYPES)) {
    const lsVal = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (lsVal === null) continue; // not touched
    const cfgVal = (cfg as any)[key];
    const type = SETTING_TYPES[key];
    let parsed: unknown;
    switch (type) {
      case "number": parsed = parseFloat(lsVal); break;
      case "boolean": parsed = lsVal === "true"; break;
      default: parsed = lsVal;
    }
    // Only include if different from config baseline
    if (String(parsed) !== String(cfgVal ?? "")) {
      dirty[key] = parsed;
    }
  }
  return dirty;
}

/**
 * Clear all settings from localStorage.
 * Called when config is freshly loaded (e.g. on window init) to avoid
 * stale values from previous sessions. Settings will be re-populated
 * by panel interactions.
 */
export function clearLiveSettings(): void {
  for (const key of Object.keys(SETTING_TYPES)) {
    localStorage.removeItem(`${LS_PREFIX}${key}`);
  }
}
