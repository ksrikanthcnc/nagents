/**
 * BSB — Battery Saver Box.
 * Small transparent window. Shows sessions grouped by state.
 * Uses same group names as panel (NEEDS YOU / WORKING / DONE).
 */

import type { Session, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { renderCharHtml, getActionText } from "../shared/char-template";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;
let prevHtml = "";

export async function initBsb(el: HTMLElement): Promise<void> {
  container = el;

  try {
    const appConfig = await getConfig();
    cfg = appConfig.overlay;
  } catch {}

  // Drag via startDragging (works on small non-fullscreen transparent windows)
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    el.addEventListener("mousedown", (e) => {
      if (e.button === 0) win.startDragging().catch(() => {});
    });
  } catch {}

  pollState((state) => {
    render(state.sessions.filter(s => s.active));
  }, 2000);
}

function render(sessions: Session[]): void {
  if (!container || !cfg) return;

  const maxChars = (cfg as any).bsb_max_chars ?? 8;
  const charSize = (cfg as any).char_size ?? 44;
  // Wider than char to fit text
  const charWidth = charSize + 20;

  const opts = {
    charSize,
    fontGroup: cfg.font_size_group ?? 9,
    fontTitle: cfg.font_size_title ?? 10,
    fontAction: cfg.font_size_action ?? 9,
    charWidth,
  };

  // Group by state (same as panel)
  const needsYou = sessions.filter(s => s.attention || s.event === "approval" || s.event === "stuck");
  const working = sessions.filter(s => !s.attention && (s.event === "running" || s.event === "tool"));
  const done = sessions.filter(s => !s.attention && s.event === "idle");
  const other = sessions.filter(s => !needsYou.includes(s) && !working.includes(s) && !done.includes(s));

  // Sort each group by time
  const byTime = (a: Session, b: Session) => {
    const aTs = a.last_user_ts || a.mtime || 0;
    const bTs = b.last_user_ts || b.mtime || 0;
    return bTs - aTs;
  };
  needsYou.sort(byTime);
  working.sort(byTime);
  done.sort(byTime);
  other.sort(byTime);

  const groups = [
    { label: "NEEDS YOU", items: needsYou },
    { label: "WORKING", items: working },
    { label: "DONE", items: done },
    { label: "OTHER", items: other },
  ].filter(g => g.items.length > 0);

  let total = 0;
  let html = "";
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const shown = g.items.slice(0, Math.max(1, maxChars - total));
    if (shown.length === 0) break;
    total += shown.length;

    // Divider between groups
    if (gi > 0) html += `<div class="bsb-divider"></div>`;

    // Section label
    html += `<div class="bsb-section">`;
    html += `<div class="bsb-label">${g.label}</div>`;
    html += `<div class="bsb-row">`;
    for (const s of shown) {
      html += renderCharHtml(s, { ...opts, srcClassPrefix: "bsb-src-" });
    }
    html += `</div></div>`;

    if (total >= maxChars) break;
  }

  const overflow = sessions.length - total;
  if (overflow > 0) {
    html += `<div class="bsb-overflow">+${overflow}</div>`;
  }

  if (html !== prevHtml) {
    prevHtml = html;
    container.innerHTML = html;
    resizeWindow();
  }
}

async function resizeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const w = Math.max(150, document.body.scrollWidth + 4);
    const h = Math.max(80, document.body.scrollHeight + 4);
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  } catch {}
}
