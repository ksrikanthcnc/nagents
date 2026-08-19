/**
 * Panel — Control center.
 *
 * Shows all sessions grouped by source/workspace.
 * On-screen (overlay) chars shown at top.
 * Each char shows event/tool/action below its name.
 */

import type { Session, SessionGroup, StateSnapshot, Config } from "../shared/types";
import { pollState, getConfig, setOverlayClickthrough, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import type { CharacterAction } from "../characters/types";

// ─── State ──────────────────────────────────────────────────────────────────

let currentState: StateSnapshot | null = null;
let config: Config | null = null;
let container: HTMLElement | null = null;
let overlayInteractive = false;

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initPanel(el: HTMLElement): Promise<void> {
  container = el;
  log("panel", "initializing");

  config = await getConfig();
  log("panel", "config loaded", config);

  pollState((state) => {
    currentState = state;
    render();
  }, 1500);

  log("panel", "polling started (1.5s)");
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  if (!container || !currentState || !config) return;

  const groups = groupSessions(currentState.sessions, config.panel_order);

  // Header: just count + edit button (title bar already says "nagents")
  let html = `<header class="panel-header">
    <span class="session-count">${currentState.count} sessions</span>
    <button class="overlay-edit-btn ${overlayInteractive ? "active" : ""}" id="overlay-edit-btn" title="Edit overlay (move/drag chars)">
      ${overlayInteractive ? "✋" : "👆"}
    </button>
  </header>`;

  html += `<div class="panel-groups">`;

  for (const group of groups) {
    const attentionCount = group.sessions.filter((s) => s.attention).length;
    const attentionBadge = attentionCount > 0
      ? `<span class="attention-badge">${attentionCount}!</span>`
      : "";

    html += `<div class="group" data-group="${group.id}">
      <div class="group-header">
        <span class="group-label">${group.label}</span>
        ${attentionBadge}
        <span class="group-count">${group.sessions.length}</span>
      </div>
      <div class="group-sessions">`;

    for (const session of group.sessions) {
      html += renderSession(session);
    }

    html += `</div></div>`;
  }

  html += `</div>`;

  container.innerHTML = html;

  // Attach overlay edit toggle handler
  const editBtn = container.querySelector("#overlay-edit-btn");
  if (editBtn) {
    editBtn.addEventListener("click", async () => {
      overlayInteractive = !overlayInteractive;
      try {
        await setOverlayClickthrough(!overlayInteractive);
        log("panel", `overlay interactive: ${overlayInteractive}`);
        render();
      } catch (e) {
        log("panel", `overlay edit toggle error: ${e}`);
      }
    });
  }
}

function renderSession(session: Session): string {
  const charId = session.character ?? "ghost";
  const char = getCharacter(charId);
  const attentionClass = session.attention ? "session-attention" : "";

  const action = sessionToAction(session);
  const actionDef = char.actions[action];
  const animClass = actionDef?.cssClass ?? "";

  // Name (truncated with ellipsis via CSS)
  const name = session.name;

  // Activity indicator dot (priority: red > amber > green > gray > none)
  const indicator = getIndicator(session);

  // Tooltip content
  const tooltipParts: string[] = [];
  tooltipParts.push(`<div class="tooltip-title">${session.name}</div>`);
  if (session.workspace) tooltipParts.push(`<div class="tooltip-row">${session.workspace}</div>`);
  if (session.event) tooltipParts.push(`<div class="tooltip-row">event: <span>${session.event}</span></div>`);
  if (session.tool) tooltipParts.push(`<div class="tooltip-row">tool: <span>${session.tool}</span></div>`);
  if (session.file) tooltipParts.push(`<div class="tooltip-row">file: <span>${session.file}</span></div>`);
  if (session.attention_reason) tooltipParts.push(`<div class="tooltip-row">attention: <span>${session.attention_reason}</span></div>`);
  if (session.tokens > 0) tooltipParts.push(`<div class="tooltip-row">tokens: <span>${(session.tokens / 1000).toFixed(0)}k/${(session.maxTokens / 1000).toFixed(0)}k</span></div>`);

  // Health bar (context usage)
  const pct = session.maxTokens > 0 ? Math.min(100, Math.round((session.tokens / session.maxTokens) * 100)) : 0;
  const barColor = pct > 80 ? "#ef4444" : pct > 50 ? "#f59e0b" : "#4ade80";
  const healthBar = session.tokens > 0
    ? `<div class="session-health"><div class="session-health-fill" style="width:${pct}%;background:${barColor}"></div></div>`
    : "";

  // Is this session in dot/revolve mode on overlay? (on screen > 15 min)
  const onScreenSec = session.attention_since
    ? (Date.now() / 1000 - session.attention_since)
    : 0;
  const isDot = onScreenSec > 15 * 60;
  const dotBadge = isDot ? ` <span class="dot-badge">⊙</span>` : "";

  // Status line: event · tool
  let status = "";
  if (session.tool) {
    status = session.tool;
  } else if (session.event) {
    status = session.event;
  }

  // data-char + animClass on the char container — CSS targets [data-char="X"].char-slot-Y svg
  return `<div class="session ${attentionClass}" data-id="${session.id}">
    <div class="session-char ${animClass}" data-char="${charId}">
      ${char.svg}
    </div>
    ${indicator}
    ${healthBar}
    <div class="session-name-short">${name}${dotBadge}</div>
    ${status ? `<div class="session-status">${status}</div>` : ""}
    <div class="session-tooltip">${tooltipParts.join("")}</div>
  </div>`;
}

/** Activity indicator dot. Priority: red > amber > green > gray > none. */
function getIndicator(session: Session): string {
  if (session.event === "approval" || session.event === "stuck") {
    return `<div class="activity-dot dot-red"></div>`;
  }
  if (session.attention) {
    return `<div class="activity-dot dot-amber"></div>`;
  }
  if (session.event === "tool") {
    return `<div class="activity-dot dot-green dot-pulse"></div>`;
  }
  if (session.event === "running") {
    return `<div class="activity-dot dot-green"></div>`;
  }
  if (!session.active) {
    return `<div class="activity-dot dot-gray"></div>`;
  }
  return "";
}

function sessionToAction(session: Session): CharacterAction {
  if (session.attention) return "alert";
  if (session.event === "running") return "think";
  if (session.event === "tool") return "think";
  if (!session.active) return "sleep";
  return "idle";
}

// ─── Grouping ───────────────────────────────────────────────────────────────

function groupSessions(sessions: Session[], order: string[]): SessionGroup[] {
  const groups: SessionGroup[] = [];

  // "on-screen" pseudo-group: sessions with attention (on overlay)
  const onScreen = sessions.filter((s) => s.attention);
  if (onScreen.length > 0) {
    groups.push({
      id: "on-screen",
      label: "On Screen",
      source: "on-screen",
      sessions: onScreen,
    });
  }

  // Group by source, IDE sub-grouped by workspace
  for (const sourceId of order) {
    if (sourceId === "on-screen") continue;

    const sourceSessions = sessions.filter((s) => s.source === sourceId);
    if (sourceSessions.length === 0) continue;

    if (sourceId === "kiro-ide") {
      const byGroup = new Map<string, Session[]>();
      for (const s of sourceSessions) {
        const key = s.group || "ide";
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(s);
      }
      for (const [groupName, groupSessions] of byGroup) {
        groups.push({
          id: `ide-${groupName}`,
          label: groupName.toUpperCase(),
          source: sourceId,
          sessions: groupSessions,
        });
      }
    } else {
      groups.push({
        id: sourceId,
        label: sourceLabel(sourceId),
        source: sourceId,
        sessions: sourceSessions,
      });
    }
  }

  // Unknown sources at end
  const knownSources = new Set(order);
  const unknown = sessions.filter((s) => !knownSources.has(s.source));
  if (unknown.length > 0) {
    groups.push({
      id: "other",
      label: "OTHER",
      source: "other",
      sessions: unknown,
    });
  }

  return groups;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "kiro-ide": return "IDE";
    case "kiro-cli": return "CLI";
    case "kiro-crew": return "CREW";
    default: return source.toUpperCase();
  }
}
