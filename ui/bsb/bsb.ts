/**
 * BSB — Battery Saver Box.
 * Uses shared char template for consistent rendering.
 */

import type { Session, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { renderCharHtml } from "../shared/char-template";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;
let prevHtml = "";

export async function initBsb(el: HTMLElement): Promise<void> {
  container = el;

  try {
    const appConfig = await getConfig();
    cfg = appConfig.overlay;
  } catch {}

  // Drag: pre-import window API, call startDragging on mousedown
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    document.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        win.startDragging().catch(() => {});
      }
    });
    log("bsb", "drag enabled via startDragging");
  } catch (e) {
    log("bsb", `drag setup failed: ${e}`);
  }

  pollState((state) => {
    render(state.sessions.filter(s => s.active));
  }, 2000);
}

function render(sessions: Session[]): void {
  if (!container || !cfg) return;

  const maxChars = (cfg as any).bsb_max_chars ?? 5;
  const layout: string = (cfg as any).bsb_layout ?? "horizontal";

  // Stable sort: pinned first, then newest, then ID
  const sorted = [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aTs = a.last_user_ts || a.mtime || 0;
    const bTs = b.last_user_ts || b.mtime || 0;
    const diff = bTs - aTs;
    if (Math.abs(diff) > 0.01) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const shown = sorted.slice(0, maxChars);
  container.dataset.layout = layout;

  const opts = {
    charSize: (cfg as any).char_size ?? 44,
    fontGroup: cfg.font_size_group ?? 9,
    fontTitle: cfg.font_size_title ?? 10,
    fontAction: cfg.font_size_action ?? 10,
  };

  let html = "";
  let prevSource = "";
  for (const s of shown) {
    if (prevSource && s.source !== prevSource) {
      html += `<div class="bsb-divider"></div>`;
    }
    prevSource = s.source;
    html += renderCharHtml(s, opts);
  }

  const overflow = sessions.length - shown.length;
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
    await getCurrentWindow().setSize(
      new LogicalSize(
        Math.max(100, document.body.scrollWidth + 8),
        Math.max(60, document.body.scrollHeight + 8)
      )
    );
  } catch {}
}
