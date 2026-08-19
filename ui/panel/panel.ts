/**
 * Panel — Control center.
 *
 * Shows all sessions grouped by source/workspace.
 * On-screen (overlay) chars shown at top.
 * Groups are collapsible. Right-click session to change character.
 */

import type { Session, SessionGroup, StateSnapshot, Config } from "../shared/types";
import { pollState, getConfig, setOverlayClickthrough, log } from "../shared/bridge";
import { getCharacter, listCharacters } from "../characters/registry";
import type { CharacterAction } from "../characters/types";

// ─── State ──────────────────────────────────────────────────────────────────

let currentState: StateSnapshot | null = null;
let config: Config | null = null;
let container: HTMLElement | null = null;
let overlayInteractive = false;
/** Collapsed group IDs (persisted to localStorage) */
let collapsed: Set<string> = new Set(
  JSON.parse(localStorage.getItem("nagents:collapsed") || "[]")
);
/** Per-session character overrides (persisted to localStorage) */
let charOverrides: Record<string, string> = JSON.parse(
  localStorage.getItem("nagents:charOverrides") || "{}"
);
/** Track last rendered session IDs to detect structural changes */
let lastSessionIds: string = "";
/** Track per-session state hash for incremental updates */
let sessionHashes: Map<string, string> = new Map();

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initPanel(el: HTMLElement): Promise<void> {
  container = el;
  log("panel", "initializing");

  config = await getConfig();
  log("panel", "config loaded", config);

  pollState((state) => {
    currentState = state;
    updatePanel();
  }, 1500);

  log("panel", "polling started (1.5s)");
}

// ─── Persistence ────────────────────────────────────────────────────────────

function saveCollapsed(): void {
  localStorage.setItem("nagents:collapsed", JSON.stringify([...collapsed]));
}

function saveCharOverrides(): void {
  localStorage.setItem("nagents:charOverrides", JSON.stringify(charOverrides));
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Hash a session's visible state (to detect what actually changed). */
function hashSession(session: Session): string {
  return `${session.character}|${session.event}|${session.attention}|${session.active}|${session.tool}|${session.tokens}|${session.on_overlay}`;
}

/**
 * Smart update: only full-render when structure changes (sessions added/removed/reordered).
 * For state-only changes (event, attention), update in-place to preserve animations.
 */
function updatePanel(): void {
  if (!container || !currentState || !config) return;

  // Compute current session ID set (order matters)
  const currentIds = currentState.sessions.map((s) => s.id).sort().join(",");

  // If structure changed OR first render, do full render
  if (currentIds !== lastSessionIds || !container.querySelector(".panel-header")) {
    lastSessionIds = currentIds;
    sessionHashes.clear();
    for (const s of currentState.sessions) {
      sessionHashes.set(s.id, hashSession(s));
    }
    render();
    return;
  }

  // Otherwise, update individual sessions in-place (preserves animations)
  for (const session of currentState.sessions) {
    const newHash = hashSession(session);
    const oldHash = sessionHashes.get(session.id);
    if (newHash === oldHash) continue; // No change

    sessionHashes.set(session.id, newHash);
    updateSessionElement(session);
  }

  // Update header count
  const countEl = container.querySelector(".session-count");
  if (countEl) countEl.textContent = `${currentState.count} sessions`;
}

/** Update a single session element in-place without destroying it. */
function updateSessionElement(session: Session): void {
  if (!container) return;
  const el = container.querySelector(`.session[data-id="${session.id}"]`) as HTMLElement | null;
  if (!el) return;

  const charId = charOverrides[session.id] || session.character || "ghost";
  const char = getCharacter(charId);
  const action = sessionToAction(session);
  const actionDef = char.actions[action];
  const newAnimClass = actionDef?.cssClass ?? "";

  // Update attention styling
  el.classList.toggle("session-attention", !!session.attention);

  // Update animation class on .session-char (preserve data-char, don't replace element)
  const charEl = el.querySelector(".session-char") as HTMLElement | null;
  if (charEl) {
    // Remove old slot classes, add new one
    const oldClasses = Array.from(charEl.classList).filter((c) => c.startsWith("char-slot-") || c.startsWith("char-action-"));
    for (const c of oldClasses) charEl.classList.remove(c);
    if (newAnimClass) charEl.classList.add(newAnimClass);

    // Update data-char if character changed
    if (charEl.dataset.char !== charId) {
      charEl.dataset.char = charId;
      charEl.innerHTML = char.svg;
    }
  }

  // Update indicator
  const oldIndicator = el.querySelector(".activity-dot");
  const newIndicatorHtml = getIndicator(session);
  if (oldIndicator) {
    if (!newIndicatorHtml) {
      oldIndicator.remove();
    } else {
      oldIndicator.outerHTML = newIndicatorHtml;
    }
  } else if (newIndicatorHtml && charEl) {
    charEl.insertAdjacentHTML("afterend", newIndicatorHtml);
  }
}


function render(): void {
  if (!container || !currentState || !config) return;

  const groups = groupSessions(currentState.sessions, config.panel_order);

  let html = `<header class="panel-header">
    <span class="session-count">${currentState.count} sessions</span>
    <button class="overlay-edit-btn ${overlayInteractive ? "active" : ""}" id="overlay-edit-btn" title="Edit overlay (move/drag chars)">
      ${overlayInteractive ? "✋" : "👆"}
    </button>
  </header>`;

  html += `<div class="panel-groups">`;

  for (const group of groups) {
    const isCollapsed = collapsed.has(group.id);
    const attentionCount = group.sessions.filter((s) => s.attention).length;
    const attentionBadge = attentionCount > 0
      ? `<span class="attention-badge">${attentionCount}!</span>`
      : "";
    const arrow = isCollapsed ? "▸" : "▾";

    html += `<div class="group ${isCollapsed ? "group-collapsed" : ""}" data-group="${group.id}">
      <div class="group-header" data-toggle="${group.id}">
        <span class="group-arrow">${arrow}</span>
        <span class="group-label">${group.label}</span>
        ${attentionBadge}
        <span class="group-count">${group.sessions.length}</span>
      </div>`;

    if (!isCollapsed) {
      html += `<div class="group-sessions">`;
      for (const session of group.sessions) {
        html += renderSession(session);
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;

  container.innerHTML = html;
  attachEventHandlers();
}

function attachEventHandlers(): void {
  if (!container) return;

  // Group collapse toggle
  container.querySelectorAll(".group-header[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const groupId = (el as HTMLElement).dataset.toggle!;
      if (collapsed.has(groupId)) {
        collapsed.delete(groupId);
      } else {
        collapsed.add(groupId);
      }
      saveCollapsed();
      render();
    });
  });

  // Right-click session to change character
  container.querySelectorAll(".session[data-id]").forEach((el) => {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const sessionId = (el as HTMLElement).dataset.id!;
      showCharPicker(sessionId, e as MouseEvent);
    });
  });

  // Overlay edit button
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

// ─── Character Picker (right-click menu) ────────────────────────────────────

function showCharPicker(sessionId: string, event: MouseEvent): void {
  // Remove any existing picker
  document.querySelector(".char-picker")?.remove();

  const chars = listCharacters();
  const picker = document.createElement("div");
  picker.className = "char-picker";
  picker.style.left = `${event.clientX}px`;
  picker.style.top = `${event.clientY}px`;

  picker.innerHTML = chars
    .map(
      (c) =>
        `<div class="char-picker-item" data-char-id="${c.id}" title="${c.name}">
          <div class="char-picker-svg">${c.svg}</div>
          <span>${c.name}</span>
        </div>`
    )
    .join("");

  document.body.appendChild(picker);

  // Click handler on each item
  picker.querySelectorAll(".char-picker-item").forEach((item) => {
    item.addEventListener("click", () => {
      const charId = (item as HTMLElement).dataset.charId!;
      charOverrides[sessionId] = charId;
      saveCharOverrides();
      log("panel", `char override: ${sessionId} → ${charId}`);
      picker.remove();

      // Push override to backend via HTTP
      fetch("http://127.0.0.1:3335/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, character: charId }),
      }).catch(() => {});

      render();
    });
  });

  // Close on click outside
  setTimeout(() => {
    document.addEventListener(
      "click",
      () => picker.remove(),
      { once: true }
    );
  }, 10);
}

// ─── Session Rendering ──────────────────────────────────────────────────────

function renderSession(session: Session): string {
  // Use override if set, otherwise session's character or default
  const charId = charOverrides[session.id] || session.character || "ghost";
  const char = getCharacter(charId);
  const attentionClass = session.attention ? "session-attention" : "";

  const action = sessionToAction(session);
  const actionDef = char.actions[action];
  const animClass = actionDef?.cssClass ?? "";

  const name = session.name;
  const indicator = getIndicator(session);

  // Health bar
  const pct = session.maxTokens > 0 ? Math.min(100, Math.round((session.tokens / session.maxTokens) * 100)) : 0;
  const barColor = pct > 80 ? "#ef4444" : pct > 50 ? "#f59e0b" : "#4ade80";
  const healthBar = session.tokens > 0
    ? `<div class="session-health"><div class="session-health-fill" style="width:${pct}%;background:${barColor}"></div></div>`
    : "";

  // Dot badge for revolve mode
  const onScreenSec = session.attention_since
    ? (Date.now() / 1000 - session.attention_since)
    : 0;
  const isDot = onScreenSec > 15 * 60;
  const dotBadge = isDot ? ` <span class="dot-badge">⊙</span>` : "";

  // Status line
  let status = "";
  if (session.tool) {
    status = session.tool;
  } else if (session.event) {
    status = session.event;
  }

  // Tooltip
  const tooltipParts: string[] = [];
  tooltipParts.push(`<div class="tooltip-title">${session.name}</div>`);
  if (session.workspace) tooltipParts.push(`<div class="tooltip-row">${session.workspace}</div>`);
  if (session.event) tooltipParts.push(`<div class="tooltip-row">event: <span>${session.event}</span></div>`);
  if (session.tool) tooltipParts.push(`<div class="tooltip-row">tool: <span>${session.tool}</span></div>`);
  if (session.file) tooltipParts.push(`<div class="tooltip-row">file: <span>${session.file}</span></div>`);
  if (session.attention_reason) tooltipParts.push(`<div class="tooltip-row">attention: <span>${session.attention_reason}</span></div>`);
  if (session.tokens > 0) tooltipParts.push(`<div class="tooltip-row">tokens: <span>${(session.tokens / 1000).toFixed(0)}k/${(session.maxTokens / 1000).toFixed(0)}k</span></div>`);
  tooltipParts.push(`<div class="tooltip-row" style="opacity:0.5">right-click to change char</div>`);

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

  // "On Screen" pseudo-group: sessions with attention
  const onScreen = sessions.filter((s) => s.attention);
  if (onScreen.length > 0) {
    groups.push({
      id: "on-screen",
      label: "ON SCREEN",
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

  // No "Other" group — only show configured sources

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
