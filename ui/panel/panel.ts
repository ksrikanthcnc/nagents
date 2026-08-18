/**
 * Panel — Control center.
 *
 * Shows all sessions grouped by source/workspace.
 * Sessions with attention get highlighted.
 * Sessions on overlay get a badge.
 *
 * Groups (in config order):
 *   - on-screen: sessions currently on overlay (duplicated here for visibility)
 *   - kiro-cli: CLI sessions
 *   - crew: Kiro Crew sessions
 *   - kiro-ide: IDE sessions (sub-grouped by workspace)
 */

import type { Session, SessionGroup, StateSnapshot, Config } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import { setOverlayClickthrough } from "../shared/bridge";

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

  // Start polling state
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

  let html = `<header class="panel-header">
    <h1>nagents</h1>
    <div class="header-actions">
      <button class="overlay-edit-btn ${overlayInteractive ? "active" : ""}" id="overlay-edit-btn" title="Toggle overlay interaction (move/drag chars)">
        ${overlayInteractive ? "✋" : "👆"}
      </button>
      <span class="session-count">${currentState.count}</span>
    </div>
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
        <span class="group-count">${group.sessions.length}</span>
        ${attentionBadge}
      </div>
      <div class="group-sessions">`;

    for (const session of group.sessions) {
      html += renderSession(session);
    }

    html += `</div></div>`;
  }

  html += `</div>`;

  // Footer
  html += `<footer class="panel-footer">
    <span class="timestamp">Updated: ${new Date(currentState.timestamp * 1000).toLocaleTimeString()}</span>
  </footer>`;

  container.innerHTML = html;

  // Attach overlay edit toggle handler
  const editBtn = container.querySelector("#overlay-edit-btn");
  if (editBtn) {
    editBtn.addEventListener("click", async () => {
      overlayInteractive = !overlayInteractive;
      try {
        // When interactive: overlay accepts clicks (move/drag chars)
        // When not: overlay is click-through (normal desktop use)
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
  const char = getCharacter(session.character ?? "ghost");
  const attentionClass = session.attention ? "session-attention" : "";

  // Determine action for character animation
  const action = sessionToAction(session);
  const actionDef = char.actions[action];
  const animClass = actionDef?.cssClass ?? "";

  // Short name for under the char
  const shortName = session.name.length > 6 ? session.name.slice(0, 6) : session.name;

  // Tooltip content
  const workspace = session.workspace ? `<div class="tooltip-row">workspace: <span>${session.workspace}</span></div>` : "";
  const event = session.event ? `<div class="tooltip-row">event: <span>${session.event}</span></div>` : "";
  const tool = session.tool ? `<div class="tooltip-row">tool: <span>${session.tool}</span></div>` : "";
  const file = session.file ? `<div class="tooltip-row">file: <span>${session.file}</span></div>` : "";
  const attention = session.attention ? `<div class="tooltip-row">attention: <span>${session.attention_reason || "yes"}</span></div>` : "";
  const tokens = session.tokens > 0 ? `<div class="tooltip-row">tokens: <span>${(session.tokens / 1000).toFixed(0)}k / ${(session.maxTokens / 1000).toFixed(0)}k</span></div>` : "";
  const overlay = session.on_overlay ? `<div class="tooltip-row">on overlay: <span>yes</span></div>` : "";

  return `<div class="session ${attentionClass}" data-id="${session.id}">
    <div class="session-char ${animClass}">
      ${char.svg}
    </div>
    <div class="session-name-short">${shortName}</div>
    <div class="session-tooltip">
      <div class="tooltip-title">${session.name}</div>
      ${workspace}${event}${tool}${file}${attention}${tokens}${overlay}
      <div class="tooltip-row">source: <span>${session.source}</span></div>
      <div class="tooltip-row">group: <span>${session.group}</span></div>
    </div>
  </div>`;
}

/** Map session state to character action. */
function sessionToAction(session: Session): import("../characters/types").CharacterAction {
  if (session.attention) return "alert";
  if (session.event === "running") return "think";
  if (session.event === "tool") return "think";
  if (!session.active) return "sleep";
  return "idle";
}

// ─── Grouping ───────────────────────────────────────────────────────────────

function groupSessions(sessions: Session[], order: string[]): SessionGroup[] {
  const groups: SessionGroup[] = [];

  // "on-screen" pseudo-group: sessions currently on overlay
  const onScreen = sessions.filter((s) => s.on_overlay);
  if (onScreen.length > 0 && order.includes("on-screen")) {
    groups.push({
      id: "on-screen",
      label: "On Screen",
      source: "on-screen",
      sessions: onScreen,
    });
  }

  // Group remaining by source, then IDE by workspace
  for (const sourceId of order) {
    if (sourceId === "on-screen") continue;

    const sourceSessions = sessions.filter((s) => s.source === sourceId);
    if (sourceSessions.length === 0) continue;

    if (sourceId === "kiro-ide") {
      // Sub-group by workspace/group
      const byGroup = new Map<string, Session[]>();
      for (const s of sourceSessions) {
        const key = s.group || "ide";
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(s);
      }
      for (const [groupName, groupSessions] of byGroup) {
        groups.push({
          id: `ide-${groupName}`,
          label: groupName,
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

  // Any sessions from sources not in panel_order go at the end
  const knownSources = new Set(order);
  const unknown = sessions.filter((s) => !knownSources.has(s.source));
  if (unknown.length > 0) {
    groups.push({
      id: "other",
      label: "Other",
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
    case "kiro-crew": return "Crew";
    default: return source;
  }
}
