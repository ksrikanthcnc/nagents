/**
 * dom.ts — DOM element creation, action text formatting, and geometry helpers.
 */

import type { Session } from "../shared/types";
import { getCharacter } from "../characters/registry";
import { cfg, CHAR_SIZE } from "./overlay-state";
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

// ─── Geometry Helpers ───────────────────────────────────────────────────────

export function randomRoamTarget(): { x: number; y: number } {
  return { x: 50 + Math.random() * (window.innerWidth - 100), y: 50 + Math.random() * (window.innerHeight - 100) };
}

export function randomEdgePosition(): { x: number; y: number } {
  const edge = Math.floor(Math.random() * 4);
  switch (edge) {
    case 0: return { x: Math.random() * window.innerWidth, y: -CHAR_SIZE };
    case 1: return { x: window.innerWidth + CHAR_SIZE, y: Math.random() * window.innerHeight };
    case 2: return { x: Math.random() * window.innerWidth, y: window.innerHeight + CHAR_SIZE };
    case 3: return { x: -CHAR_SIZE, y: Math.random() * window.innerHeight };
    default: return { x: -CHAR_SIZE, y: window.innerHeight / 2 };
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
