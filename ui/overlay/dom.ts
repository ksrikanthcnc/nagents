/**
 * dom.ts — DOM element creation, action text formatting, and geometry helpers.
 */

import type { Session } from "../shared/types";
import { getCharacter } from "../characters/registry";
import { cfg, CHAR_SIZE, canvasW, canvasH, virtualOriginX, virtualOriginY, isPerDisplay, seededRandom } from "./overlay-state";
import type { OverlayChar } from "./overlay-state";

// ─── Character Element Creation ─────────────────────────────────────────────

export function createCharElement(session: Session): HTMLElement {
  const overrides: Record<string, string> = JSON.parse(localStorage.getItem("nagents:charOverrides") || "{}");
  const charId = overrides[session.id] || session.character || "ghost";
  const charDef = getCharacter(charId);
  const el = document.createElement("div");
  el.className = "overlay-char";
  el.dataset.sessionId = session.id;
  el.dataset.group = session.group;
  el.dataset.source = session.source;
  el.dataset.char = charId;
  const groupLabel = session.group || session.source;
  const icon = getToolIcon(session.tool, session.event);
  const text = getActionText(session);
  el.innerHTML = `
    <div class="overlay-char-group" style="font-size:${cfg.font_size_group}px">${groupLabel}</div>
    <div class="overlay-char-title" style="font-size:${cfg.font_size_title}px">${session.name}</div>
    <div class="overlay-char-svg char-slot-idle" data-char="${charId}">${charDef.svg}</div>
    <div class="overlay-char-action" style="font-size:${cfg.font_size_action}px">${icon ? `<span class="action-icon">${icon}</span>` : ""}${text}</div>
    <div class="overlay-char-timer" style="font-size:${cfg.font_size_action}px;display:none"></div>
    <div class="overlay-char-badge">${session.pinned ? "📌" : session.muted ? "🔇" : ""}</div>
  `;
  el.style.position = "absolute";
  el.style.width = `${CHAR_SIZE}px`;
  el.style.pointerEvents = "none";
  return el;
}

// ─── Tool Icons ─────────────────────────────────────────────────────────────

export function getToolIcon(tool: string | null, event: string | null): string {
  if (tool) {
    const map: Record<string, string> = {
      fs_write: "\u270F\uFE0F", str_replace: "\u270F\uFE0F",
      read_file: "\uD83D\uDCD6", read_files: "\uD83D\uDCD6", read_code: "\uD83D\uDCD6",
      execute_bash: "\u26A1", grep_search: "\uD83D\uDD0D", file_search: "\uD83D\uDD0D",
      list_directory: "\uD83D\uDCC2", web_fetch: "\uD83C\uDF10", remote_web_search: "\uD83C\uDF10",
      invoke_sub_agent: "\uD83E\uDD16", update_session_information: "\uD83D\uDCCB", todo_list: "\u2611\uFE0F",
    };
    return map[tool] || "\uD83D\uDD27";
  }
  if (event) {
    const map: Record<string, string> = { idle: "", running: "\u2699\uFE0F", approval: "\u2753", stuck: "\uD83D\uDEA8", tool: "\uD83D\uDD27" };
    return map[event] || "";
  }
  return "";
}

// ─── Action Text ────────────────────────────────────────────────────────────

export function getActionText(session: Session): string {
  if (session.tool) {
    switch (session.tool) {
      case "read_file": case "read_files": case "read_code":
        return session.file ? basename(session.file) : "reading";
      case "fs_write": case "str_replace":
        return session.file ? basename(session.file) : "writing";
      case "execute_bash":
        return session.file ? session.file.slice(0, 25) : "bash";
      case "grep_search": case "file_search": return "searching";
      case "list_directory": return session.file ? basename(session.file) : "listing";
      case "invoke_sub_agent": return "sub-agent";
      case "update_session_information": return "status";
      case "todo_list": return "todo";
      default: return session.tool.length > 15 ? session.tool.slice(0, 14) + "\u2026" : session.tool;
    }
  }
  if (session.event === "idle") {
    if ((session as any).action_text) return (session as any).action_text;
    const desc = session.description?.trimEnd();
    if (desc) {
      const lastChar = desc[desc.length - 1];
      const icon = lastChar === "?" ? "?" : "\u2713";
      const truncated = desc.length > 22 ? desc.slice(0, 21) + "\u2026" : desc;
      return `${icon} ${truncated}`;
    }
    if (session.prompt) {
      const truncated = session.prompt.length > 20 ? session.prompt.slice(0, 19) + "\u2026" : session.prompt;
      return `\u2713 ${truncated}`;
    }
    return "\u2713 done";
  }
  if (session.event === "approval") return "? approval";
  if (session.event === "stuck") return "stuck";
  return session.event || "";
}

function basename(path: string): string { return path.split("/").pop() || path; }

// ─── Elapsed Timer ──────────────────────────────────────────────────────────

/** Seconds a running tool must exceed before it's shown as "stuck" (shake/pulse). */
export const STUCK_THRESHOLD_SEC = 30;

/** Format elapsed seconds as "M:SS" (e.g. 83 → "1:23"). Caps display at 99:59. */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mins = Math.min(99, Math.floor(s / 60));
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Update the elapsed-time badge + stuck animation on a char.
 * Timer shows for actively-working events (running/tool/approval/stuck).
 * mtime is epoch seconds of the last event → elapsed = now - mtime.
 */
export function updateCharTimer(el: HTMLElement, session: Session, nowSec: number): void {
  const timerEl = el.querySelector(".overlay-char-timer") as HTMLElement | null;
  if (!timerEl) return;

  const ev = session.event;
  const isTiming = ev === "running" || ev === "tool" || ev === "approval" || ev === "stuck";
  if (!isTiming || !session.mtime) {
    if (timerEl.style.display !== "none") {
      timerEl.style.display = "none";
      timerEl.textContent = "";
    }
    if (el.classList.contains("char-stuck")) el.classList.remove("char-stuck");
    return;
  }

  const elapsed = nowSec - session.mtime;
  const text = formatElapsed(elapsed);
  if (timerEl.textContent !== text) timerEl.textContent = text;
  if (timerEl.style.display === "none") timerEl.style.display = "";

  // Stuck: escalated event, or timing out past threshold → shake/red pulse.
  const stuck = ev === "stuck" || ev === "approval" || elapsed > STUCK_THRESHOLD_SEC;
  el.classList.toggle("char-stuck", stuck);
}

// ─── Geometry Helpers ───────────────────────────────────────────────────────

export function randomRoamTarget(sessionId = "", counter = 0): { x: number; y: number } {
  const ox = isPerDisplay ? virtualOriginX : 0;
  const oy = isPerDisplay ? virtualOriginY : 0;
  const r1 = sessionId ? seededRandom(sessionId, counter * 2) : Math.random();
  const r2 = sessionId ? seededRandom(sessionId, counter * 2 + 1) : Math.random();
  return {
    x: ox + 50 + r1 * (canvasW() - 100),
    y: oy + 50 + r2 * (canvasH() - 100),
  };
}

/**
 * A roam target biased toward the display the cursor is currently on.
 * Used when multi_screen is on: a roamer drifts to the cursor's screen, then
 * keeps roaming within it. `cursorPos` is window-local; `displaySize` is the
 * approximate per-display extent (so we roam within one screen, not the span).
 */
export function roamTargetNearCursor(
  cursorPos: { x: number; y: number },
  displayW: number,
  displayH: number,
  sessionId = "",
  counter = 0,
): { x: number; y: number } {
  const vox = isPerDisplay ? virtualOriginX : 0;
  const voy = isPerDisplay ? virtualOriginY : 0;
  const cx = cursorPos.x;
  const cy = cursorPos.y;
  const halfW = Math.min(displayW, canvasW()) / 2;
  const halfH = Math.min(displayH, canvasH()) / 2;
  const r1 = sessionId ? seededRandom(sessionId, counter * 2 + 200) : Math.random();
  const r2 = sessionId ? seededRandom(sessionId, counter * 2 + 201) : Math.random();
  const x = cx - halfW + r1 * (halfW * 2);
  const y = cy - halfH + r2 * (halfH * 2);
  return {
    x: Math.max(vox + 50, Math.min(vox + canvasW() - 50, x)),
    y: Math.max(voy + 50, Math.min(voy + canvasH() - 50, y)),
  };
}

export function randomEdgePosition(sessionId = ""): { x: number; y: number } {
  const ox = isPerDisplay ? virtualOriginX : 0;
  const oy = isPerDisplay ? virtualOriginY : 0;
  const w = canvasW();
  const h = canvasH();
  const r1 = sessionId ? seededRandom(sessionId, 9999) : Math.random();
  const r2 = sessionId ? seededRandom(sessionId, 9998) : Math.random();
  const edge = Math.floor(r1 * 4);
  switch (edge) {
    case 0: return { x: ox + r2 * w, y: oy - CHAR_SIZE };
    case 1: return { x: ox + w + CHAR_SIZE, y: oy + r2 * h };
    case 2: return { x: ox + r2 * w, y: oy + h + CHAR_SIZE };
    case 3: return { x: ox - CHAR_SIZE, y: oy + r2 * h };
    default: return { x: ox - CHAR_SIZE, y: oy + h / 2 };
  }
}

/** Update the "+N" hidden badge element. Caller passes the element ref. */
export function updateHiddenBadge(badgeEl: HTMLElement | null, count: number): void {
  if (!badgeEl) return;
  if (count > 0) {
    badgeEl.textContent = `+${count}`;
    badgeEl.style.display = "";
  } else {
    badgeEl.style.display = "none";
  }
}

export function distTo(char: OverlayChar, target: { x: number; y: number }): number {
  const dx = char.x - target.x;
  const dy = char.y - target.y;
  return Math.sqrt(dx * dx + dy * dy);
}
