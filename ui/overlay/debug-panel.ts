/**
 * debug-panel.ts — Live diagnostic overlay for multi-monitor debugging.
 *
 * Reads the lead window's broadcast from localStorage (nagents:charFrame) and
 * renders a draggable debug panel on any display showing:
 *   - This display's identity + bounds
 *   - Global cursor position
 *   - All chars sorted by mode (follow → roam → revolve → +N hidden)
 *   - Per-char: name, mode, virtual position, display region, distance from cursor
 *   - Periodic snapshots (1/sec rolling buffer) for anomaly detection
 *
 * Also patches a small distance badge onto each char element on the lead window.
 */

import {
  cursor, chars, isPerDisplay, isLeadWindow,
  displayOriginX, displayOriginY, displayWidth, displayHeight,
  virtualOriginX, virtualOriginY, canvasW, canvasH,
  displayRects, type DisplayRectInfo,
  latestFollowerFrame,
} from "./overlay-state";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CharSnapshot {
  id: string;
  name: string;
  mode: string;
  x: number;
  y: number;
  dist: number;
  display: string;
  charId: string;
  event: string;
}

interface FrameSnapshot {
  ts: number;
  cx: number;
  cy: number;
  chars: CharSnapshot[];
}

// ─── State ──────────────────────────────────────────────────────────────────

const SNAPSHOT_INTERVAL = 1000;
const MAX_SNAPSHOTS = 30;
const snapshots: FrameSnapshot[] = [];
let lastSnapshotTs = 0;
let panelEl: HTMLElement | null = null;

// ─── Display name helper ────────────────────────────────────────────────────

function displayLabel(dx: number, dy: number, dw: number, dh: number): string {
  if (dx === 0 && dy === 0) return `Primary ${dw}×${dh}`;
  const side = dx < 0 ? "Left" : dx > 0 ? "Right" : "Center";
  return `${side} ${dw}×${dh} @(${dx},${dy})`;
}

function findDisplay(x: number, y: number, rects: DisplayRectInfo[]): string {
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      return displayLabel(r.x, r.y, r.w, r.h);
    }
  }
  return "off-screen";
}

// ─── Mode sort order ────────────────────────────────────────────────────────

const MODE_ORDER: Record<string, number> = { follow: 0, roam: 1, revolve: 2, hidden: 3 };
const MODE_COLOR: Record<string, string> = {
  follow: "#4ade80", roam: "#60a5fa", revolve: "#a78bfa", hidden: "#666",
};

// ─── Init ───────────────────────────────────────────────────────────────────

export function initDebugPanel(): void {
  // Togglable via settings (localStorage). Default: off.
  if (localStorage.getItem("nagents:setting:debug_panel") !== "true") return;

  panelEl = document.createElement("div");
  panelEl.id = "nagents-debug";
  panelEl.style.cssText = `
    position: fixed; top: 8px; left: 8px; z-index: 99999;
    font: 500 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e8e8f0; background: rgba(10, 10, 30, 0.88);
    border: 1px solid rgba(167, 139, 250, 0.3); border-radius: 8px;
    padding: 8px 12px; pointer-events: auto; cursor: move;
    max-width: 420px; max-height: 600px; overflow-y: auto;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    user-select: text; -webkit-user-select: text;
  `;
  document.body.appendChild(panelEl);
  makeDraggable(panelEl);

  // Update at ~4fps (enough for reading, not wasteful)
  setInterval(updatePanel, 250);
}

// ─── Draggable ──────────────────────────────────────────────────────────────

function makeDraggable(el: HTMLElement): void {
  let ox = 0, oy = 0, sx = 0, sy = 0;
  el.addEventListener("mousedown", (e) => {
    // Allow text selection on the panel content
    if ((e.target as HTMLElement).tagName === "SPAN") return;
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const onMove = (e: MouseEvent) => {
      ox = e.clientX - sx; oy = e.clientY - sy;
      sx = e.clientX; sy = e.clientY;
      el.style.top = `${el.offsetTop + oy}px`;
      el.style.left = `${el.offsetLeft + ox}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ─── Update ─────────────────────────────────────────────────────────────────

function updatePanel(): void {
  if (!panelEl) return;

  const now = Date.now();

  // Cursor is always the shared cursor object (each window updates it from /cursor poll).
  const cx = Math.round(cursor.x);
  const cy = Math.round(cursor.y);

  // Build char list from lead's live state (if we ARE the lead) or from
  // the localStorage broadcast (if follower). Lead has direct access to chars.
  const charList = buildCharList(cx, cy);

  // Sort by mode (waterfall order)
  charList.sort((a, b) => (MODE_ORDER[a.mode] ?? 9) - (MODE_ORDER[b.mode] ?? 9));

  // Periodic snapshot
  if (now - lastSnapshotTs > SNAPSHOT_INTERVAL) {
    lastSnapshotTs = now;
    snapshots.push({ ts: now, cx, cy, chars: charList });
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  }

  // This display info
  const thisDisplay = isPerDisplay
    ? displayLabel(displayOriginX, displayOriginY, displayWidth, displayHeight)
    : `Single ${Math.round(canvasW())}×${Math.round(canvasH())}`;
  const role = isLeadWindow ? "🟢 Lead" : "🔵 Follower";

  // Cursor display
  const cursorDisp = findDisplay(cx, cy, displayRects);

  // Render
  const visible = charList.filter(c => c.mode !== "hidden");
  const hidden = charList.filter(c => c.mode === "hidden");

  let html = `<div style="margin-bottom:6px">
    <b>${role} ${thisDisplay}</b><br>
    <span style="color:#a78bfa">cursor:</span> (${cx}, ${cy}) → ${cursorDisp}<br>
    <span style="color:#a78bfa">chars:</span> ${charList.length} total, ${visible.length} visible, +${hidden.length} hidden
  </div>`;

  // Visible chars (sorted by mode)
  if (visible.length > 0) {
    html += `<div style="border-top:1px solid rgba(167,139,250,0.2);padding-top:4px">`;
    for (const c of visible) {
      const color = MODE_COLOR[c.mode] || "#888";
      html += `<div style="font-size:9px;margin:1px 0">
        <span style="color:${color};font-weight:700">${c.mode.toUpperCase().padEnd(7)}</span>
        <span style="color:#fff">${esc(c.name.slice(0, 16))}</span>
        <span style="color:#888"> (${c.x},${c.y})</span>
        <span style="color:#f59e0b"> d=${c.dist}</span>
        <span style="color:#666"> ${c.display}</span>
      </div>`;
    }
    html += `</div>`;
  }

  // Hidden chars (collapsed)
  if (hidden.length > 0) {
    html += `<details style="margin-top:4px;font-size:9px;color:#666"><summary>+${hidden.length} hidden</summary>`;
    for (const c of hidden) {
      html += `<div>${esc(c.name.slice(0, 16))} (${c.x},${c.y}) d=${c.dist} ${c.display}</div>`;
    }
    html += `</details>`;
  }

  // Snapshot anomalies (last 5)
  if (snapshots.length > 2) {
    const recent = snapshots.slice(-5);
    const anomalies: string[] = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      // Detect: char count changed, cursor jumped far, or a char teleported
      if (prev.chars.length !== curr.chars.length) {
        anomalies.push(`t=${Math.round((curr.ts - recent[0].ts) / 1000)}s: count ${prev.chars.length}→${curr.chars.length}`);
      }
      for (const cc of curr.chars) {
        const pc = prev.chars.find(p => p.id === cc.id);
        if (pc && Math.abs(cc.x - pc.x) > 500) {
          anomalies.push(`t=${Math.round((curr.ts - recent[0].ts) / 1000)}s: ${cc.name.slice(0,10)} jumped ${Math.abs(cc.x - pc.x)}px`);
        }
      }
    }
    if (anomalies.length > 0) {
      html += `<div style="margin-top:4px;border-top:1px solid rgba(239,68,68,0.3);padding-top:4px;color:#f87171;font-size:9px">
        <b>⚠ anomalies:</b><br>${anomalies.join("<br>")}
      </div>`;
    }
  }

  panelEl.innerHTML = html;
}

function buildCharList(cx: number, cy: number): CharSnapshot[] {
  const list: CharSnapshot[] = [];

  if (isLeadWindow && chars.size > 0) {
    // Lead: read from live physics state.
    for (const [id, char] of chars) {
      const dist = Math.round(Math.sqrt((char.x - cx) ** 2 + (char.y - cy) ** 2));
      list.push({
        id, name: char.session.name, mode: char.mode,
        x: Math.round(char.x), y: Math.round(char.y), dist,
        display: findDisplay(char.x, char.y, displayRects),
        charId: char.el.dataset.char || "ghost",
        event: char.session.event || "",
      });
    }
  } else {
    // Follower: read from latest broadcast frame.
    for (const [id, data] of Object.entries(latestFollowerFrame)) {
      const [x, y, mode, charId, name, _group, ev] = data;
      const dist = Math.round(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2));
      list.push({ id, name, mode, x, y, dist, display: findDisplay(x, y, displayRects), charId, event: ev });
    }
  }
  return list;
}

// ─── Per-char distance badge (lead window only) ─────────────────────────────
// Shows the distance from cursor on each char's timer element.

export function updateCharDistanceBadges(): void {
  if (!isLeadWindow) return;
  const cx = cursor.x;
  const cy = cursor.y;
  for (const [, char] of chars) {
    const dist = Math.round(Math.sqrt((char.x - cx) ** 2 + (char.y - cy) ** 2));
    let badge = char.el.querySelector(".debug-dist") as HTMLElement | null;
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "debug-dist";
      badge.style.cssText = "font:600 7px/1 monospace;color:#f59e0b;text-align:center;pointer-events:none;margin-top:1px;";
      char.el.appendChild(badge);
    }
    badge.textContent = `d=${dist}`;
  }
}

function esc(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
