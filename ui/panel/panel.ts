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


/** Recursively render sub-groups. depth controls indentation CSS class. */
function renderSubGroups(groups: SessionGroup[], depth: number): string {
  let html = "";
  for (const sub of groups) {
    const isSubCollapsed = collapsed.has(sub.id);
    const subArrow = isSubCollapsed ? "▸" : "▾";
    const sessionCount = countSessions(sub);
    const attentionCount = sub.sessions.filter(s => s.attention).length;
    const attentionBadge = attentionCount > 0 ? `<span class="attention-badge">${attentionCount}!</span>` : "";

    html += `<div class="group group-depth-${depth} ${isSubCollapsed ? "group-collapsed" : ""}" data-group="${sub.id}">
      <div class="group-header" data-toggle="${sub.id}">
        <span class="group-arrow">${subArrow}</span>
        <span class="group-label">${sub.label}</span>
        ${attentionBadge}
        <span class="group-count">${sessionCount}</span>
      </div>`;

    if (!isSubCollapsed) {
      if (sub.subGroups && sub.subGroups.length > 0) {
        // Has nested sub-groups — recurse
        html += `<div class="group-content">`;
        html += renderSubGroups(sub.subGroups, depth + 1);
        html += `</div>`;
      } else {
        // Leaf level — render sessions
        html += `<div class="group-sessions">`;
        for (const session of sub.sessions) {
          html += renderSession(session);
        }
        html += `</div>`;
      }
    }
    html += `</div>`;
  }
  return html;
}

/** Count all sessions in a group (recursively through sub-groups). */
function countSessions(group: SessionGroup): number {
  if (group.subGroups && group.subGroups.length > 0) {
    return group.subGroups.reduce((acc, sg) => acc + countSessions(sg), 0);
  }
  return group.sessions.length;
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

  // Group display mode toggle
  const groupAsOne = localStorage.getItem("nagents:group_as_one") === "true" || (config as any).overlay?.group_as_one || false;
  const groupDisplay = localStorage.getItem("nagents:group_display") || (config as any).overlay?.group_display || "cluster";
  html += `<div class="panel-toolbar">
    <label class="toolbar-toggle" title="Merge same-group sessions">
      <input type="checkbox" id="group-as-one-toggle" ${groupAsOne ? "checked" : ""} />
      <span>Group</span>
    </label>
    <select class="toolbar-select" id="group-display-select" ${!groupAsOne ? "disabled" : ""}>
      <option value="cluster" ${groupDisplay === "cluster" ? "selected" : ""}>Cluster</option>
      <option value="single" ${groupDisplay === "single" ? "selected" : ""}>Single</option>
      <option value="carousel" ${groupDisplay === "carousel" ? "selected" : ""}>Carousel</option>
    </select>
  </div>`;

  const panelMode = (config as any).overlay?.panel_mode || "comfortable";
  html += `<div class="panel-groups panel-${panelMode}">`;

  for (const meta of groups) {
    const isMetaCollapsed = collapsed.has(meta.id);
    const arrow = isMetaCollapsed ? "▸" : "▾";
    const count = meta.sessions.length;

    // Meta header
    html += `<div class="meta-group ${isMetaCollapsed ? "meta-collapsed" : ""}" data-group="${meta.id}">
      <div class="meta-header" data-toggle="${meta.id}">
        <span class="group-arrow">${arrow}</span>
        <span class="meta-label">${meta.label}</span>
        <span class="group-count">${count}</span>
      </div>`;

    if (!isMetaCollapsed && meta.subGroups) {
      html += `<div class="meta-content">`;
      html += renderSubGroups(meta.subGroups, 1);
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

  // Group/meta collapse toggle
  container.querySelectorAll("[data-toggle]").forEach((el) => {
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

  // Group-as-one toggle
  const groupToggle = container.querySelector("#group-as-one-toggle") as HTMLInputElement | null;
  if (groupToggle) {
    groupToggle.addEventListener("change", () => {
      localStorage.setItem("nagents:group_as_one", groupToggle.checked ? "true" : "false");
      log("panel", `group_as_one: ${groupToggle.checked}`);
      render();
    });
  }

  // Group display mode select
  const groupSelect = container.querySelector("#group-display-select") as HTMLSelectElement | null;
  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      localStorage.setItem("nagents:group_display", groupSelect.value);
      log("panel", `group_display: ${groupSelect.value}`);
      render();
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
      // Also update backend so overlay picks it up
      fetch("http://127.0.0.1:3335/character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, character: charId }),
      }).catch(() => {});
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

  // Display name: if "group:title" format, show just title part
  const name = session.name.includes(":") ? session.name.split(":").slice(1).join(":") : session.name;
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

  // Status line — rich action text (same as overlay speech bubble)
  let status = "";
  if (session.tool) {
    const toolMap: Record<string, string> = {
      read_file: "reading", read_files: "reading", read_code: "reading",
      fs_write: "writing", str_replace: "writing",
      execute_bash: "bash", grep_search: "searching", file_search: "searching",
      list_directory: "listing", invoke_sub_agent: "sub-agent",
      update_session_information: "status", todo_list: "todo",
    };
    const toolText = toolMap[session.tool] || (session.tool.length > 12 ? session.tool.slice(0, 11) + "\u2026" : session.tool);
    const fileHint = session.file ? ` ${session.file.split("/").pop()}` : "";
    status = `\uD83D\uDD27 ${toolText}${fileHint}`;
  } else if (session.event === "idle") {
    if ((session as any).action_text) {
      status = (session as any).action_text;
    } else if (session.description) {
      const desc = session.description.trimEnd();
      const icon = desc.endsWith("?") ? "?" : "\u2713";
      status = `${icon} ${desc.length > 18 ? desc.slice(0, 17) + "\u2026" : desc}`;
    } else {
      status = "\u2713 done";
    }
  } else if (session.event === "running") {
    status = "\u2699\uFE0F working";
  } else if (session.event === "approval") {
    status = "? approval";
  } else if (session.event === "stuck") {
    status = "\uD83D\uDEA8 stuck";
  } else if (session.active) {
    status = session.event || "active";
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

  const groupLabel = session.group || session.source;

  return `<div class="session ${attentionClass}" data-id="${session.id}">
    <div class="session-group-label">${groupLabel}</div>
    <div class="session-name-short">${name}${dotBadge}</div>
    <div class="session-char ${animClass}" data-char="${charId}">
      ${char.svg}
    </div>
    ${indicator}
    ${healthBar}
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
  const metas: SessionGroup[] = [];

  // ─── ON SCREEN meta: 3-level nesting (ZONE/STATE → sub-groups → sessions) ─
  const onScreen = sessions.filter(s => s.active);
  if (onScreen.length > 0) {
    const subGroups: SessionGroup[] = [];

    // ── ZONE (mid-level): FOLLOWING / ROAMING / DOT/HIDDEN ──
    const zoneChildren: SessionGroup[] = [];
    const withAttention = onScreen.filter(s => s.attention);
    const followCandidates = withAttention.filter(s => s.event === "approval" || s.event === "stuck" || s.event === "idle");
    const maxF = 2; // approximate — matches config
    const following = followCandidates.slice(0, maxF);
    const roaming = [...followCandidates.slice(maxF), ...withAttention.filter(s => s.event === "running" || s.event === "tool")];
    const dotHidden = onScreen.filter(s => !following.includes(s) && !roaming.includes(s));

    if (following.length > 0) zoneChildren.push({ id: "on-zone-follow", label: "FOLLOWING", source: "on-screen" as any, sessions: following });
    if (roaming.length > 0) zoneChildren.push({ id: "on-zone-roam", label: "ROAMING", source: "on-screen" as any, sessions: roaming });
    if (dotHidden.length > 0) zoneChildren.push({ id: "on-zone-dot", label: "DOT/HIDDEN", source: "on-screen" as any, sessions: dotHidden });

    if (zoneChildren.length > 0) {
      subGroups.push({
        id: "on-zone", label: "ZONE", source: "on-screen" as any,
        sessions: onScreen, subGroups: zoneChildren, isMeta: true,
      });
    }

    // ── STATE (mid-level): NEEDS YOU / DONE / WORKING ──
    const stateChildren: SessionGroup[] = [];
    const blocked = onScreen.filter(s => s.event === "approval" || s.event === "stuck");
    const idle = onScreen.filter(s => s.event === "idle");
    const working = onScreen.filter(s => s.event === "running" || s.event === "tool");

    if (blocked.length > 0) stateChildren.push({ id: "on-state-blocked", label: "NEEDS YOU", source: "on-screen" as any, sessions: blocked });
    if (idle.length > 0) stateChildren.push({ id: "on-state-idle", label: "DONE", source: "on-screen" as any, sessions: idle });
    if (working.length > 0) stateChildren.push({ id: "on-state-working", label: "WORKING", source: "on-screen" as any, sessions: working });

    if (stateChildren.length > 0) {
      subGroups.push({
        id: "on-state", label: "STATE", source: "on-screen" as any,
        sessions: onScreen, subGroups: stateChildren, isMeta: true,
      });
    }

    metas.push({
      id: "on-screen", label: `ON SCREEN`, source: "on-screen" as any,
      sessions: onScreen, subGroups, isMeta: true,
    });
  }

  // ─── Source metas: cli-v2, cli-v3, crew, ide ──────────────────────
  for (const sourceId of order) {
    if (sourceId === "on-screen") continue;
    const sourceSessions = sessions.filter(s => s.source === sourceId);
    if (sourceSessions.length === 0) continue;

    const subGroups = subGroupByField(sourceSessions, sourceId);
    const label = sourceLabel(sourceId);
    metas.push({
      id: sourceId, label, source: sourceId as any,
      sessions: sourceSessions, subGroups, isMeta: true,
    });
  }

  return metas;
}

/** Sub-group sessions by their group field (IDE=workspace, CLI/Crew=name prefix). */
function subGroupByField(sessions: Session[], parentId: string): SessionGroup[] {
  const byGroup = new Map<string, Session[]>();
  for (const s of sessions) {
    let groupKey: string;
    if (s.name.includes(":")) {
      groupKey = s.name.split(":")[0]; // "misc:hi" → "misc"
    } else {
      groupKey = s.group || parentId;
    }
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
    byGroup.get(groupKey)!.push(s);
  }
  const result: SessionGroup[] = [];
  for (const [name, sess] of byGroup) {
    result.push({ id: `${parentId}-${name}`, label: name.toUpperCase(), source: parentId as any, sessions: sess });
  }
  return result;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "kiro-ide": return "IDE";
    case "kiro-cli": return "CLI";
    case "kiro-crew": return "CREW";
    default: return source.toUpperCase();
  }
}
