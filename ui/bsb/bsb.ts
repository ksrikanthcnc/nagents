/**
 * BSB — Battery Saver Box.
 *
 * Separate small window: shows agent chars in a static grid.
 * No physics, no cursor tracking. Just char SVGs + group/title + status dot.
 * Polls state, uses computeModes for ordering.
 */

import type { Session, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import { computeModes, MODE_DEFAULTS } from "../overlay/modes";
import type { CharState, ModeConfig } from "../overlay/modes";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;
let lastStateKey = "";

export async function initBsb(el: HTMLElement): Promise<void> {
  container = el;
  log("bsb", "initializing");

  try {
    const appConfig = await getConfig();
    cfg = appConfig.overlay;
  } catch {
    log("bsb", "config load failed");
  }

  pollState((state) => {
    render(state.sessions.filter(s => s.active));
  }, 2000);

  // Make window draggable by the body
  let dragging = false;
  let startX = 0, startY = 0;
  document.body.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.screenX;
    startY = e.screenY;
  });
  document.body.addEventListener("mousemove", async (e) => {
    if (!dragging) return;
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      startX = e.screenX;
      startY = e.screenY;
      // Move window via Tauri
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        await win.setPosition(new (await import("@tauri-apps/api/dpi")).PhysicalPosition(
          pos.x + dx, pos.y + dy
        ));
      } catch {}
    }
  });
  document.body.addEventListener("mouseup", () => { dragging = false; });
}

function render(sessions: Session[]): void {
  if (!container || !cfg) return;

  const maxChars = (cfg as any).bsb_max_chars ?? 5;
  const layout: string = (cfg as any).bsb_layout ?? "horizontal";
  const charSize = (cfg as any).char_size ?? 44;
  const fGroup = cfg.font_size_group ?? 9;
  const fTitle = cfg.font_size_title ?? 10;

  // Compute modes (same logic as overlay)
  const charStates: CharState[] = sessions.map(s => ({
    sessionId: s.id,
    session: s,
    currentMode: "hidden" as any,
    spawnedAt: s.mtime * 1000,
    lastUserTs: s.last_user_ts ?? (s.mtime * 1000),
    interactionCount: s.interaction_count ?? 0,
  }));

  const modeCfg: ModeConfig = {
    max_followers: cfg.max_followers ?? MODE_DEFAULTS.max_followers,
    max_roamers: cfg.max_roamers ?? MODE_DEFAULTS.max_roamers,
    max_dots: cfg.max_dots ?? MODE_DEFAULTS.max_dots,
    follower_mode: cfg.follower_mode ?? MODE_DEFAULTS.follower_mode,
    round_robin_sec: cfg.round_robin_sec ?? MODE_DEFAULTS.round_robin_sec,
    pin_counts_toward_max: cfg.pin_counts_toward_max ?? MODE_DEFAULTS.pin_counts_toward_max,
    group_as_one: cfg.group_as_one ?? MODE_DEFAULTS.group_as_one,
    group_display: (cfg as any).group_display || "cluster",
  };

  const assignments = computeModes(charStates, modeCfg);

  // Sort by mode priority (follow > roam > dot > hidden), then mtime
  const sorted = [...charStates].sort((a, b) => {
    const modeOrder: Record<string, number> = { follow: 0, roam: 1, revolve: 2, hidden: 3 };
    const aMode = assignments.get(a.sessionId)?.mode ?? "hidden";
    const bMode = assignments.get(b.sessionId)?.mode ?? "hidden";
    const modeDiff = (modeOrder[aMode] ?? 3) - (modeOrder[bMode] ?? 3);
    if (modeDiff !== 0) return modeDiff;
    return (b.session.mtime || 0) - (a.session.mtime || 0);
  });

  const shown = sorted.slice(0, maxChars);

  // State key for change detection
  const stateKey = shown.map(c => `${c.sessionId}:${c.session.event}:${c.session.attention}:${assignments.get(c.sessionId)?.mode}`).join("|");
  if (stateKey === lastStateKey) return;
  lastStateKey = stateKey;

  container.dataset.layout = layout;

  let html = "";
  for (const c of shown) {
    const s = c.session;
    const mode = assignments.get(c.sessionId)?.mode ?? "hidden";
    const charId = s.character || "ghost";
    const charDef = getCharacter(charId);
    const dot = s.attention ? "dot-amber" :
      (s.event === "running" || s.event === "tool") ? "dot-green" : "dot-gray";
    const group = s.group || s.source;
    const srcClass = `bsb-src-${s.source.replace(/[^a-z0-9]/g, "")}`;

    html += `<div class="bsb-char ${srcClass}" title="${s.name} [${mode}]" style="width:${charSize}px">
      <div class="bsb-group" style="font-size:${fGroup}px">${group}</div>
      <div class="bsb-svg" style="width:${charSize}px;height:${charSize}px">${charDef.svg}</div>
      <div class="bsb-dot ${dot}"></div>
      <div class="bsb-title" style="font-size:${fTitle}px">${s.name}</div>
    </div>`;
  }

  const overflow = sessions.length - shown.length;
  if (overflow > 0) {
    html += `<div class="bsb-overflow">+${overflow}</div>`;
  }

  container.innerHTML = html;
}
