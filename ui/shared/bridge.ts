/**
 * Bridge — communication layer between frontend and Rust backend.
 *
 * Uses Tauri's invoke (commands) and listen (events) APIs.
 * Falls back to HTTP polling when not running in Tauri (dev/browser mode).
 */

import type { StateSnapshot, Config } from "./types";

// ─── Detection ──────────────────────────────────────────────────────────────

/** Are we running inside a Tauri webview? */
function isTauri(): boolean {
  return "__TAURI__" in window;
}

// ─── Tauri Imports (dynamic to avoid errors in browser) ─────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ─── State ──────────────────────────────────────────────────────────────────

const HTTP_BASE = "http://127.0.0.1:3335";

/** Fetch full state snapshot. */
export async function getState(): Promise<StateSnapshot> {
  if (isTauri()) {
    return tauriInvoke<StateSnapshot>("get_state");
  }
  // Fallback: HTTP
  const resp = await fetch(`${HTTP_BASE}/state`);
  return resp.json();
}

/** Fetch config. */
export async function getConfig(): Promise<Config> {
  // Use HTTP endpoint (works for all windows, always fresh from Rust config cache)
  try {
    const resp = await fetch(`${HTTP_BASE}/config`);
    if (resp.ok) return resp.json();
  } catch {}
  // Fallback: Tauri IPC
  if (isTauri()) {
    return tauriInvoke<Config>("get_config");
  }
  // Final fallback: defaults
  return {
    sources: {},
    attention_rules: {
      idle_threshold_sec: 30,
      tool_stuck_sec: 30,
      running_stuck_sec: 120,
      waiting_statuses: ["waiting_on_user", "waiting_for_approval", "idle"],
    },
    panel_order: ["on-screen", "kiro-cli", "crew", "kiro-ide"],
    characters: {},
    overlay: {
      follow_strength: 0.04,
      roam_strength: 0.008,
      roam_max_speed: 3,
      follow_max_speed: 6,
      min_cursor_distance: 80,
      collision_distance: 70,
      revolve_radius: 50,
      revolve_speed: 0.015,
      shrink_after_min: 15,
      dot_scale: 0.5,
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
    },
    http_port: 3335,
    log_level: "info",
  };
}

// ─── Overlay Commands ───────────────────────────────────────────────────────

export async function setOverlayClickthrough(ignore: boolean): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("set_overlay_clickthrough", { ignore });
  }
}

// ─── State Polling ──────────────────────────────────────────────────────────

/**
 * Start polling state at the given interval.
 * Returns a cleanup function to stop polling.
 */
export function pollState(
  handler: (state: StateSnapshot) => void,
  intervalMs = 1500
): () => void {
  let active = true;

  const poll = async () => {
    while (active) {
      try {
        const state = await getState();
        handler(state);
      } catch (e) {
        console.warn("[bridge] poll error:", e);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  poll();
  return () => {
    active = false;
  };
}

// ─── Logging ────────────────────────────────────────────────────────────────

/** Structured frontend log (always prints to console). */
export function log(module: string, msg: string, data?: unknown): void {
  const ts = new Date().toLocaleTimeString();
  if (data !== undefined) {
    console.log(`[${ts}] [${module}]`, msg, data);
  } else {
    console.log(`[${ts}] [${module}]`, msg);
  }
}

// ─── State Change Listener ──────────────────────────────────────────────────

/**
 * Listen for state-changed events from Rust (emitted on every session/event push).
 * Calls handler immediately with current state, then on every change.
 * Falls back to polling if Tauri events unavailable (browser mode).
 */
export async function onStateChanged(
  handler: (state: StateSnapshot) => void,
  fallbackIntervalMs = 1500
): Promise<() => void> {
  // Immediate call
  try {
    const state = await getState();
    handler(state);
  } catch {}

  if (isTauri()) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen("state-changed", async () => {
        try {
          const state = await getState();
          handler(state);
        } catch {}
      });
      return unlisten;
    } catch {}
  }

  // Fallback: poll (browser mode)
  let active = true;
  (async () => {
    while (active) {
      await new Promise(r => setTimeout(r, fallbackIntervalMs));
      if (!active) break;
      try {
        const state = await getState();
        handler(state);
      } catch {}
    }
  })();
  return () => { active = false; };
}


/**
 * Listen for config-changed events from Rust fs watcher.
 * Calls handler immediately with current config, then on every change.
 * Returns a cleanup function.
 */
export async function onConfigChanged(handler: (config: Config) => void): Promise<() => void> {
  // Immediate call with current config
  try {
    const cfg = await getConfig();
    handler(cfg);
  } catch {}

  // Listen for Tauri events
  if (isTauri()) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen("config-changed", async () => {
        try {
          const cfg = await getConfig();
          handler(cfg);
        } catch {}
      });
      return unlisten;
    } catch {}
  }

  // Fallback: poll every 3s (browser mode / non-Tauri)
  let active = true;
  (async () => {
    while (active) {
      await new Promise(r => setTimeout(r, 3000));
      if (!active) break;
      try {
        const cfg = await getConfig();
        handler(cfg);
      } catch {}
    }
  })();
  return () => { active = false; };
}
