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
  }, 3000);

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


/** Render settings form for overlay config. */
function renderSettings(): string {
  if (!config) return "";
  const ov = (config as any).overlay || {};
  const groupAsOne = localStorage.getItem("nagents:group_as_one") === "true" || ov.group_as_one || false;
  const groupDisplay = localStorage.getItem("nagents:group_display") || ov.group_display || "cluster";
  return `<div class="settings-grid">
    <label>Followers<input type="number" class="cfg-input" data-key="max_followers" value="${ov.max_followers ?? 2}" min="0" max="10"></label>
    <label>Roamers<input type="number" class="cfg-input" data-key="max_roamers" value="${ov.max_roamers ?? 3}" min="0" max="10"></label>
    <label>Dots<input type="number" class="cfg-input" data-key="max_dots" value="${ov.max_dots ?? 5}" min="0" max="20"></label>
    <label>Orbit radius<input type="number" class="cfg-input" data-key="revolve_radius" value="${ov.revolve_radius ?? 50}" min="20" max="150"></label>
    <label>Dot scale<input type="number" class="cfg-input" data-key="dot_scale" value="${ov.dot_scale ?? 0.55}" min="0.2" max="1" step="0.05"></label>
    <label>Char size<input type="number" class="cfg-input" data-key="char_size" value="${(ov as any).char_size ?? 44}" min="24" max="80"></label>
    <label>Collision dist<input type="number" class="cfg-input" data-key="collision_distance" value="${ov.collision_distance ?? 100}" min="30" max="200"></label>
    <label>Follow strength<input type="number" class="cfg-input" data-key="follow_strength" value="${ov.follow_strength ?? 0.04}" min="0.01" max="0.2" step="0.01"></label>
    <label>Roam strength<input type="number" class="cfg-input" data-key="roam_strength" value="${ov.roam_strength ?? 0.008}" min="0.002" max="0.05" step="0.002"></label>
    <label>Follower mode<select class="cfg-input" data-key="follower_mode">
      <option value="lifo" ${ov.follower_mode === "lifo" ? "selected" : ""}>LIFO</option>
      <option value="fifo" ${ov.follower_mode === "fifo" ? "selected" : ""}>FIFO</option>
      <option value="lru" ${ov.follower_mode === "lru" ? "selected" : ""}>LRU</option>
      <option value="priority,lifo" ${ov.follower_mode === "priority,lifo" ? "selected" : ""}>Priority+LIFO</option>
      <option value="round_robin" ${ov.follower_mode === "round_robin" ? "selected" : ""}>Round Robin</option>
    </select></label>
    <label>Panel mode<select class="cfg-input" data-key="panel_mode">
      <option value="compact" ${ov.panel_mode === "compact" ? "selected" : ""}>Compact</option>
      <option value="comfortable" ${ov.panel_mode === "comfortable" ? "selected" : ""}>Comfortable</option>
    </select></label>
    <label>Group mode<select class="cfg-input" data-key="group_display" id="group-display-select">
      <option value="cluster" ${groupDisplay === "cluster" ? "selected" : ""}>Cluster</option>
      <option value="single" ${groupDisplay === "single" ? "selected" : ""}>Single</option>
    </select></label>
    <label>Rotate sec<input type="number" class="cfg-input" data-key="round_robin_sec" value="${ov.round_robin_sec ?? 3}" min="1" max="60"></label>
    <label class="toolbar-toggle">
      <input type="checkbox" class="cfg-input" data-key="group_as_one" id="group-as-one-toggle" ${groupAsOne ? "checked" : ""} />
      <span>Group as one</span>
    </label>
    <label class="toolbar-toggle">
      <input type="checkbox" id="battery-saver-toggle" ${localStorage.getItem("nagents:battery_saver") === "true" ? "checked" : ""} />
      <span>Battery saver</span>
    </label>
    <label>BSB chars<input type="number" class="cfg-input" data-key="bsb_max_chars" value="${(ov as any).bsb_max_chars ?? 5}" min="1" max="20"></label>
    <label>BSB layout<select class="cfg-input" data-key="bsb_layout">
      <option value="horizontal" ${(ov as any).bsb_layout === "horizontal" || !(ov as any).bsb_layout ? "selected" : ""}>Horizontal</option>
      <option value="vertical" ${(ov as any).bsb_layout === "vertical" ? "selected" : ""}>Vertical</option>
      <option value="grid" ${(ov as any).bsb_layout === "grid" ? "selected" : ""}>Grid</option>
    </select></label>
  </div>
  <button class="settings-save-btn" id="settings-save-btn">Save to config.local.yaml</button>`;
}

/** Collect settings form values and POST to /config. */
function saveSettings(): void {
  if (!container) return;
  const inputs = container.querySelectorAll(".cfg-input");
  const overlay: Record<string, unknown> = {};
  inputs.forEach((el) => {
    const key = (el as HTMLElement).dataset.key!;
    if ((el as HTMLInputElement).type === "checkbox") {
      overlay[key] = (el as HTMLInputElement).checked;
      localStorage.setItem(`nagents:${key}`, String((el as HTMLInputElement).checked));
    } else {
      const val = (el as HTMLInputElement | HTMLSelectElement).value;
      const num = parseFloat(val);
      overlay[key] = isNaN(num) ? val : num;
      localStorage.setItem(`nagents:${key}`, val);
    }
  });
  fetch("http://127.0.0.1:3335/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overlay }),
  }).then(() => {
    log("panel", "settings saved to config.local.yaml");
  }).catch((e) => {
    log("panel", `settings save error: ${e}`);
  });
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
        // Leaf level — render sessions (sorted by follower_mode order)
        const sorted = [...sub.sessions].sort(panelSessionSort);
        html += `<div class="group-sessions">`;
        for (const session of sorted) {
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
    <select class="toolbar-select" id="hide-overlay-select" title="Hide overlay">
      <option value="">👁</option>
      <option value="5">Hide 5min</option>
      <option value="60">Hide 1hr</option>
      <option value="0">Hide forever</option>
    </select>
    <button class="toolbar-btn" id="config-reload-btn" title="Reload config">⟳</button>
  </header>`;

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

  // ─── Settings section ─────────────────────────────────────────────
  const isSettingsOpen = collapsed.has("settings") ? false : true; // default open = false
  const settingsCollapsed = !collapsed.has("settings"); // inverted: settings default collapsed
  html += `<div class="meta-group ${settingsCollapsed ? "" : "meta-collapsed"}" data-group="settings">
    <div class="meta-header" data-toggle="settings">
      <span class="group-arrow">${settingsCollapsed ? "▾" : "▸"}</span>
      <span class="meta-label" style="color: var(--text-muted)">SETTINGS</span>
    </div>
    ${settingsCollapsed ? `<div class="meta-content settings-content">
      ${renderSettings()}
    </div>` : ""}
  </div>`;

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

  // Left-click session to pin/unpin
  container.querySelectorAll(".session[data-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const sessionId = (el as HTMLElement).dataset.id!;
      const isPinned = (el as HTMLElement).classList.contains("session-pinned");
      fetch("http://127.0.0.1:3335/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, pinned: !isPinned }),
      }).catch(() => {});
      log("panel", `pin toggle: ${sessionId} → ${!isPinned}`);
      (el as HTMLElement).classList.toggle("session-pinned");
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

  // Config reload button
  const reloadBtn = container.querySelector("#config-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      try {
        config = await getConfig();
        log("panel", "config reloaded");
        render();
      } catch (e) {
        log("panel", `config reload error: ${e}`);
      }
    });
  }

  // Hide overlay select
  const hideSelect = container.querySelector("#hide-overlay-select") as HTMLSelectElement | null;
  if (hideSelect) {
    hideSelect.addEventListener("change", () => {
      const val = hideSelect.value;
      if (val === "") {
        // Re-show overlay (eye selected)
        localStorage.removeItem("nagents:overlay_hidden_until");
        log("panel", "overlay shown");
      } else {
        const minutes = parseInt(val);
        const hideUntil = minutes === 0 ? Infinity : Date.now() + minutes * 60 * 1000;
        localStorage.setItem("nagents:overlay_hidden_until", String(hideUntil));
        log("panel", `overlay hidden for ${minutes === 0 ? "forever" : minutes + "min"}`);
      }
      // Keep selected value visible to indicate state
    });
  }

  // Settings save button
  const saveBtn = container.querySelector("#settings-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => saveSettings());
  }

  // Battery saver toggle
  const batteryToggle = container.querySelector("#battery-saver-toggle") as HTMLInputElement | null;
  if (batteryToggle) {
    batteryToggle.addEventListener("change", () => {
      localStorage.setItem("nagents:battery_saver", batteryToggle.checked ? "true" : "false");
      log("panel", `battery saver: ${batteryToggle.checked}`);
    });
  }

  // Group-as-one toggle (in settings)
  const groupToggle = container.querySelector("#group-as-one-toggle") as HTMLInputElement | null;
  if (groupToggle) {
    groupToggle.addEventListener("change", () => {
      localStorage.setItem("nagents:group_as_one", groupToggle.checked ? "true" : "false");
      log("panel", `group_as_one: ${groupToggle.checked}`);
    });
  }

  // Group display mode select (in settings) — immediate effect
  const groupSelect = container.querySelector("#group-display-select") as HTMLSelectElement | null;
  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      localStorage.setItem("nagents:group_display", groupSelect.value);
      log("panel", `group_display: ${groupSelect.value}`);
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
  const pinnedClass = session.pinned ? "session-pinned" : "";

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

  const pinBadge = session.pinned ? `<span class="pin-badge">📌</span>` : "";

  return `<div class="session ${attentionClass} ${pinnedClass}" data-id="${session.id}">
    <div class="session-group-label">${groupLabel}</div>
    <div class="session-name-short">${name}${dotBadge}${pinBadge}</div>
    <div class="session-char ${animClass}" data-char="${charId}">
      ${char.svg}
    </div>
    ${indicator}
    ${healthBar}
    ${status ? `<div class="session-status">${status}</div>` : ""}
    ${(session.sub_agents || 0) > 0 ? `<div class="session-sub-agents">⑂${session.sub_agents}${(session as any).workers?.length ? `<div class="sub-agent-list">${(session as any).workers.map((n: string) => `<span class="sub-agent-name">${n}</span>`).join("")}</div>` : ""}</div>` : ""}
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

/** Sort sessions for panel display (matches overlay's follower_mode). */
function panelSessionSort(a: Session, b: Session): number {
  // Pinned first
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  // Then by last_user_ts (LIFO: newest first — default mode)
  const aTs = a.last_user_ts || 0;
  const bTs = b.last_user_ts || 0;
  if (aTs !== bTs) return bTs - aTs;
  return a.id.localeCompare(b.id);
}

function groupSessions(sessions: Session[], order: string[]): SessionGroup[] {
  const metas: SessionGroup[] = [];

  // ─── ALL SESSIONS meta: 3-level nesting (PINNED/ZONE/STATE → sub-groups → sessions) ─
  const onScreen = sessions.filter(s => s.active);
  if (onScreen.length > 0) {
    const subGroups: SessionGroup[] = [];

    // ── PINNED (mid-level) ──
    const pinned = onScreen.filter(s => s.pinned);
    if (pinned.length > 0) {
      subGroups.push({
        id: "on-pinned", label: "PINNED", source: "on-screen" as any,
        sessions: pinned, isMeta: false,
      });
    }

    // ── ZONE (mid-level): FOLLOWING / ROAMING / DOT / HIDDEN ──
    // Read actual mode assignments from overlay (published via localStorage)
    const modeData: Record<string, string> = JSON.parse(
      localStorage.getItem("nagents:mode_assignments") || "{}"
    );

    const following: Session[] = [];
    const roaming: Session[] = [];
    const dotSessions: Session[] = [];
    const hiddenSessions: Session[] = [];

    for (const s of onScreen) {
      if (s.pinned) continue; // pinned shown separately above
      const mode = modeData[s.id] || "hidden";
      switch (mode) {
        case "follow": following.push(s); break;
        case "roam": roaming.push(s); break;
        case "revolve": dotSessions.push(s); break;
        case "hidden": hiddenSessions.push(s); break;
      }
    }

    const zoneChildren: SessionGroup[] = [];
    if (following.length > 0) zoneChildren.push({ id: "on-zone-follow", label: "FOLLOWING", source: "on-screen" as any, sessions: following });
    if (roaming.length > 0) zoneChildren.push({ id: "on-zone-roam", label: "ROAMING", source: "on-screen" as any, sessions: roaming });
    if (dotSessions.length > 0) zoneChildren.push({ id: "on-zone-dot", label: "DOT", source: "on-screen" as any, sessions: dotSessions });
    if (hiddenSessions.length > 0) zoneChildren.push({ id: "on-zone-hidden", label: "HIDDEN", source: "on-screen" as any, sessions: hiddenSessions });

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
      id: "on-screen", label: `SESSIONS`, source: "on-screen" as any,
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
