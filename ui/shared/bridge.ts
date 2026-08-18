/**
 * Bridge — communication layer between frontend and Rust backend.
 *
 * Uses Tauri's invoke (commands) and listen (events) APIs.
 * Falls back to HTTP polling when not running in Tauri (dev/browser mode).
 */

import type { StateSnapshot, Config, CursorPosition } from "./types";

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

async function tauriListen(event: string, handler: (payload: any) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen(event, (e) => handler(e.payload));
  return unlisten;
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
  if (isTauri()) {
    return tauriInvoke<Config>("get_config");
  }
  // No HTTP fallback for config — return defaults
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
    http_port: 3334,
    log_level: "info",
  };
}

// ─── Overlay Commands ───────────────────────────────────────────────────────

export async function createOverlay(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("create_overlay");
  }
}

export async function hideOverlay(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("hide_overlay");
  }
}

export async function toggleOverlay(): Promise<boolean> {
  if (isTauri()) {
    return tauriInvoke<boolean>("toggle_overlay");
  }
  return false;
}

export async function setOverlayClickthrough(ignore: boolean): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("set_overlay_clickthrough", { ignore });
  }
}

// ─── Event Subscriptions ────────────────────────────────────────────────────

/** Subscribe to cursor position updates (overlay window). */
export async function onCursorMove(
  handler: (pos: CursorPosition) => void
): Promise<() => void> {
  if (isTauri()) {
    try {
      return await tauriListen("nagents:cursor", handler);
    } catch (e) {
      console.warn("[bridge] Tauri cursor listen failed, using HTTP fallback:", e);
    }
  }
  // Fallback: poll /cursor via HTTP
  let active = true;
  const poll = async () => {
    while (active) {
      try {
        const resp = await fetch(`${HTTP_BASE}/cursor`);
        if (resp.ok) {
          const pos = await resp.json();
          handler(pos);
        }
      } catch {
        // server not ready yet, retry
      }
      await new Promise((r) => setTimeout(r, 33));
    }
  };
  poll();
  return () => {
    active = false;
  };
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
