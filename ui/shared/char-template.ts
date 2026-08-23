/**
 * Shared character rendering template.
 * Used by overlay, panel, and BSB for consistent char display.
 *
 * Structure: group → title → SVG → action/state
 */

import type { Session } from "./types";
import { getCharacter } from "../characters/registry";

export interface CharRenderOptions {
  /** Character size in px */
  charSize: number;
  /** Font size for group label */
  fontGroup: number;
  /** Font size for title */
  fontTitle: number;
  /** Font size for action/state text */
  fontAction: number;
  /** CSS class prefix for source hue */
  srcClassPrefix?: string;
}

const DEFAULT_OPTS: CharRenderOptions = {
  charSize: 44,
  fontGroup: 9,
  fontTitle: 10,
  fontAction: 10,
  srcClassPrefix: "bsb-src-",
};

/** Get action/state display text for a session */
export function getActionText(s: Session): string {
  if (s.tool) {
    const toolMap: Record<string, string> = {
      read_file: "reading", read_files: "reading", read_code: "reading",
      fs_write: "writing", str_replace: "editing",
      execute_bash: "bash", grep_search: "searching", file_search: "searching",
      list_directory: "listing", invoke_sub_agent: "sub-agent",
      update_session_information: "status", todo_list: "todo",
    };
    const toolText = toolMap[s.tool] || (s.tool.length > 14 ? s.tool.slice(0, 13) + "\u2026" : s.tool);
    const fileHint = s.file ? ` ${s.file.split("/").pop()}` : "";
    return `\uD83D\uDD27 ${toolText}${fileHint}`;
  }
  if (s.event === "idle") {
    if (s.description) {
      const desc = s.description.trimEnd();
      return desc.length > 22 ? desc.slice(0, 21) + "\u2026" : desc;
    }
    return "\u2713 done";
  }
  if (s.event === "running") return "\u2699\uFE0F working";
  if (s.event === "approval") return "? approval";
  if (s.event === "stuck") return "\u26A0 stuck";
  return "";
}

/** Render a single session char as HTML string */
export function renderCharHtml(s: Session, opts?: Partial<CharRenderOptions>): string {
  const o = { ...DEFAULT_OPTS, ...opts };
  const charId = s.character || "ghost";
  const charDef = getCharacter(charId);
  const group = s.group || s.source;
  const srcClass = `${o.srcClassPrefix}${s.source.replace(/[^a-z0-9]/g, "")}`;
  const action = getActionText(s);

  return `<div class="char-tpl ${srcClass}" style="width:${o.charSize}px">
    <div class="char-tpl-group" style="font-size:${o.fontGroup}px">${group}</div>
    <div class="char-tpl-title" style="font-size:${o.fontTitle}px">${s.name}</div>
    <div class="char-tpl-svg" style="width:${o.charSize}px;height:${o.charSize}px">${charDef.svg}</div>
    ${action ? `<div class="char-tpl-action" style="font-size:${o.fontAction}px">${action}</div>` : ""}
  </div>`;
}
