/**
 * BSB — Battery Saver Box.
 * Reads config from Tauri IPC. Re-reads every 30s for hot-reload changes.
 * Shows sessions grouped by state, ordered by waterfall.
 */

import type { Session, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { renderCharHtml } from "../shared/char-template";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;
let prevHtml = "";

export async function initBsb(el: HTMLElement): Promise<void> {
  container = el;

  cfg = (await getConfig()).overlay;
  log("bsb", `config: max=${(cfg as any).bsb_max_chars} layout=${(cfg as any).bsb_layout} charSize=${(cfg as any).char_size}`);

  // Drag
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    el.addEventListener("mousedown", (e) => {
      if (e.button === 0) win.startDragging().catch(() => {});
    });
  } catch {}

  // Poll state + re-read config each cycle (config is cached in Rust memory, cheap)
  pollState(async (state) => {
    try { cfg = (await getConfig()).overlay; } catch {}
    render(state.sessions.filter(s => s.active));
  }, 2000);
}

function render(sessions: Session[]): void {
  if (!container || !cfg) return;

  // Read from localStorage (panel writes on change) → config fallback
  const maxChars = Number(localStorage.getItem("nagents:bsb_max_chars")) || (cfg as any).bsb_max_chars || 5;
  const layout = localStorage.getItem("nagents:bsb_layout") || (cfg as any).bsb_layout || "grid";
  const charSize = Number(localStorage.getItem("nagents:char_size")) || (cfg as any).char_size || 44;
  const charWidth = charSize + 16;

  container.dataset.layout = layout;

  const opts = {
    charSize,
    charWidth,
    fontGroup: cfg.font_size_group ?? 9,
    fontTitle: cfg.font_size_title ?? 10,
    fontAction: cfg.font_size_action ?? 9,
  };

  // Group by state (waterfall: attention > done > working > other)
  const needsYou = sessions.filter(s => s.attention || s.event === "approval" || s.event === "stuck");
  const done = sessions.filter(s => !s.attention && s.event === "idle");
  const working = sessions.filter(s => !s.attention && (s.event === "running" || s.event === "tool"));
  const other = sessions.filter(s => !needsYou.includes(s) && !done.includes(s) && !working.includes(s));

  const byTime = (a: Session, b: Session) => (b.last_user_ts || b.mtime || 0) - (a.last_user_ts || a.mtime || 0);
  needsYou.sort(byTime);
  done.sort(byTime);
  working.sort(byTime);
  other.sort(byTime);

  const groups = [
    { label: "NEEDS YOU", cls: "bsb-g-attention", items: needsYou },
    { label: "DONE", cls: "bsb-g-done", items: done },
    { label: "WORKING", cls: "bsb-g-working", items: working },
    { label: "OTHER", cls: "bsb-g-other", items: other },
  ].filter(g => g.items.length > 0);

  let total = 0;
  let html = "";
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const shown = g.items.slice(0, Math.max(1, maxChars - total));
    if (shown.length === 0) break;
    total += shown.length;

    if (gi > 0) html += `<div class="bsb-divider"></div>`;
    html += `<div class="bsb-section ${g.cls}">`;
    html += `<div class="bsb-label">${g.label}</div>`;
    html += `<div class="bsb-row">`;
    for (const s of shown) {
      html += renderCharHtml(s, { ...opts, srcClassPrefix: "bsb-src-" });
    }
    html += `</div></div>`;
    if (total >= maxChars) break;
  }

  const overflow = sessions.length - total;
  if (overflow > 0) html += `<div class="bsb-overflow">+${overflow}</div>`;

  if (html !== prevHtml) {
    prevHtml = html;
    container.innerHTML = html;
    resizeWindow();
  }
}

async function resizeWindow(): Promise<void> {
  if (!container) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    // Measure content's natural size (not constrained by window)
    const w = Math.max(150, container.scrollWidth + 20);
    const h = Math.max(80, container.scrollHeight + 20);
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  } catch {}
}
