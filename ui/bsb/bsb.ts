/**
 * BSB — Battery Saver Box.
 * Reads config from Tauri IPC. Re-reads every 2s for hot-reload changes.
 * Shows sessions grouped by state, ordered by waterfall.
 */

import type { Session, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log, onConfigChanged, onStateChanged } from "../shared/bridge";
import { renderCharHtml } from "../shared/char-template";
import { getStringSetting, getNumberSetting } from "../shared/settings";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;
let prevHtml = "";
let prevLayout = "";
let prevSessionIds: Set<string> = new Set();

export async function initBsb(el: HTMLElement): Promise<void> {
  container = el;

  cfg = (await getConfig()).overlay;
  log("bsb", `config: max=${cfg.bsb_max_chars} layout=${cfg.bsb_layout} charSize=${cfg.char_size}`);

  // Drag
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    el.addEventListener("mousedown", (e) => {
      if (e.button === 0) win.startDragging().catch(() => {});
    });
  } catch {}

  // Listen for config changes (instant via Tauri events)
  onConfigChanged((fresh) => {
    if (fresh.overlay) cfg = fresh.overlay;
  });

  // Listen for state changes (event-based from Rust)
  onStateChanged(async (state) => {
    render(state.sessions.filter(s => s.active));
  });
}

function render(sessions: Session[]): void {
  if (!container || !cfg) return;

  // Unified settings: localStorage (panel live changes) → config (baseline)
  const maxChars = getNumberSetting("bsb_max_chars", cfg, 5);
  const layout = getStringSetting("bsb_layout", cfg, "grid");
  const charSize = getNumberSetting("char_size", cfg, 44);
  const charWidth = charSize + 16;

  container.dataset.layout = layout;

  // Apply background opacity (0 = fully transparent, 1 = opaque dark)
  const opacity = getNumberSetting("bsb_opacity", cfg, 0);
  container.style.background = opacity > 0
    ? `rgba(20, 20, 35, ${opacity})`
    : "transparent";

  // If layout changed, force re-render + resize even if HTML is same
  const layoutChanged = layout !== prevLayout;
  if (layoutChanged) prevLayout = layout;

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

  if (html !== prevHtml || layoutChanged) {
    // Detect disappearing sessions — animate out before replacing
    const currentIds = new Set(sessions.map(s => s.id));
    const leaving = [...prevSessionIds].filter(id => !currentIds.has(id));

    if (leaving.length > 0 && container.children.length > 0) {
      // Mark leaving chars with animation class
      for (const id of leaving) {
        const el = container.querySelector(`[data-session-id="${id}"]`);
        if (el) el.classList.add("bsb-leaving");
      }
      // Wait for leave animation, then replace content
      setTimeout(() => {
        if (!container) return;
        applyNewContent(container, html, layoutChanged);
        prevSessionIds = currentIds;
      }, 200);
    } else {
      applyNewContent(container, html, layoutChanged);
      prevSessionIds = currentIds;
    }

    prevHtml = html;
  }
}

function applyNewContent(el: HTMLElement, html: string, layoutChanged: boolean): void {
  el.innerHTML = html;

  // Trigger layout shift animation on container
  if (layoutChanged) {
    el.classList.remove("bsb-layout-shift");
    void el.offsetWidth;
    el.classList.add("bsb-layout-shift");
  }

  // Subtle border pulse to draw attention on any state change
  el.classList.remove("bsb-pulse");
  void el.offsetWidth;
  el.classList.add("bsb-pulse");

  resizeWindow();
}

async function resizeWindow(): Promise<void> {
  if (!container) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    // Temporarily unconstrain so scrollWidth/Height reflect natural content size
    const prevWidth = container.style.width;
    const prevHeight = container.style.height;
    container.style.width = "max-content";
    container.style.height = "max-content";
    const w = Math.max(150, container.scrollWidth + 20);
    const h = Math.max(80, container.scrollHeight + 20);
    container.style.width = prevWidth;
    container.style.height = prevHeight;
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  } catch {}
}
