/**
 * Overlay — transparent fullscreen window with animated characters.
 *
 * nagents (nagging ai agents): chars nag you to deal with idle sessions,
 * stand in corners when working, orbit as dots when overflow.
 *
 * Mode assignment delegated to modes.ts (pure logic).
 * This file: init, config, sync, mode assignment, render loop orchestration.
 */

import type { Session, OverlayConfig } from "../shared/types";
import { getConfig, log, onConfigChanged, onStateChanged } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import { computeModes, type CharState, type ModeConfig, MODE_DEFAULTS } from "./modes";
import {
  cursor, cursorTarget, chars, container,
  setContainer, setCursorReady, cursorReady,
  setHiddenBadgeEl, hiddenBadgeEl,
  setAllCharsHidden, allCharsHidden,
  setFrameInterval, frameInterval, setAnimFrameId,
  cfg, setCfg, CHAR_SIZE, setCharSize,
} from "./overlay-state";
import type { OverlayChar } from "./overlay-state";
import { updatePhysics } from "./physics";
import { drawConnections } from "./connections";
import { createCharElement, getToolIcon, getActionText, randomRoamTarget, randomEdgePosition, updateHiddenBadge } from "./dom";

// ─── Overlay Mode Presets ────────────────────────────────────────────────────

/** Apply overlay_mode preset overrides to cfg.
 * "lite": 1 follower, no roam/dots, slow cursor, no connectors.
 * "off": handled externally (overlay hidden, BSB shown).
 */
function applyOverlayMode(): void {
  const mode = cfg.overlay_mode || "full";
  if (mode === "lite") {
    cfg.max_followers = 1;
    cfg.max_roamers = 0;
    cfg.max_dots = 0;
    cfg.cursor_fps = 1;
    cfg.cursor_smoothing = 0.04;
    cfg.follow_strength = 0.003;
    cfg.connectors = false;
    cfg.collision_distance = 0;
    cfg.physics_fps = 30;
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  setContainer(el);
  log("overlay", "initializing");

  const badge = document.createElement("div");
  badge.className = "overlay-hidden-badge";
  badge.style.display = "none";
  el.appendChild(badge);
  setHiddenBadgeEl(badge);

  try {
    const appConfig = await getConfig();
    if (appConfig.overlay) setCfg(appConfig.overlay);
    applyOverlayMode();
    if (cfg.char_size) setCharSize(cfg.char_size);
    log("overlay", `config loaded: mode=${cfg.overlay_mode || "full"} followers=${cfg.max_followers} roamers=${cfg.max_roamers} dots=${cfg.max_dots} charSize=${CHAR_SIZE}`);
  } catch {
    log("overlay", "config load failed, using defaults");
  }

  let cursorInterval = Math.round(1000 / cfg.cursor_fps);
  (async () => {
    while (true) {
      if (cursorReady && (chars.size === 0 || allCharsHidden)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          const raw = await resp.json();
          cursorTarget.x = raw.x;
          cursorTarget.y = raw.y - 38;
          setCursorReady(true);
        }
      } catch {}
      await new Promise(r => setTimeout(r, cursorInterval));
    }
  })();

  // Listen for config changes (fs watch events from Rust, instant)
  onConfigChanged((fresh) => {
    if (fresh.overlay) {
      const prevWorkingMode = cfg.working_mode;
      setCfg(fresh.overlay);
      applyOverlayMode();
      if (cfg.char_size) setCharSize(cfg.char_size);
      cursorInterval = Math.round(1000 / cfg.cursor_fps);
      setFrameInterval(1000 / cfg.physics_fps);
      // Poof all working chars when working_mode changes (visual cue)
      if (prevWorkingMode && prevWorkingMode !== cfg.working_mode) {
        for (const char of chars.values()) {
          if (char.session.event === "running" || char.session.event === "tool") {
            char.el.classList.remove("char-poof");
            void char.el.offsetWidth;
            char.el.classList.add("char-poof");
          }
        }
      }
      log("overlay", `config updated: mode=${cfg.overlay_mode || "full"} fps=${cfg.physics_fps} cursor=${cfg.cursor_fps}`);
    }
  });

  // Fallback: re-read config every 10s
  setInterval(async () => {
    try {
      const fresh = await getConfig();
      if (fresh.overlay) {
        setCfg(fresh.overlay);
        applyOverlayMode();
        if (cfg.char_size) setCharSize(cfg.char_size);
        cursorInterval = Math.round(1000 / cfg.cursor_fps);
        setFrameInterval(1000 / cfg.physics_fps);
      }
    } catch {}
  }, 10000);

  onStateChanged(async (state) => {
    if (!cursorReady) return;
    syncChars(state.sessions.filter(s => s.active));
  });

  startRenderLoop();
  log("overlay", "render loop started");

  // Sleep/wake detection
  let lastTimestamp = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTimestamp;
    lastTimestamp = now;
    if (gap > 10000) {
      const delay = (cfg.startup_delay_sec ?? 5) * 1000;
      log("overlay", `wake detected (gap=${Math.round(gap/1000)}s), pausing for ${delay/1000}s`);
      setAllCharsHidden(true);
      setTimeout(() => {
        setAllCharsHidden(false);
        log("overlay", "resumed after wake delay");
      }, delay);
    }
  }, 2000);
}

// ─── Sync ───────────────────────────────────────────────────────────────────

function syncChars(sessions: Session[]): void {
  if (!container) return;
  const activeIds = new Set(sessions.map(s => s.id));

  // Remove gone chars (with debounce + walk-off animation)
  for (const [id, char] of chars) {
    if (!activeIds.has(id)) {
      if (!char.el.dataset.goneAt) {
        char.el.dataset.goneAt = String(Date.now());
        continue;
      }
      const goneMs = Date.now() - Number(char.el.dataset.goneAt);
      if (goneMs < 3000) continue;

      if (!char.el.dataset.leaving) {
        char.el.dataset.leaving = "1";
        char.el.classList.add("char-hiding");
        const cx = char.x + CHAR_SIZE / 2;
        const cy = char.y + CHAR_SIZE / 2;
        const toLeft = cx, toRight = window.innerWidth - cx;
        const toTop = cy, toBottom = window.innerHeight - cy;
        const min = Math.min(toLeft, toRight, toTop, toBottom);
        if (min === toLeft) char.roamTarget = { x: -CHAR_SIZE * 2, y: char.y };
        else if (min === toRight) char.roamTarget = { x: window.innerWidth + CHAR_SIZE * 2, y: char.y };
        else if (min === toTop) char.roamTarget = { x: char.x, y: -CHAR_SIZE * 2 };
        else char.roamTarget = { x: char.x, y: window.innerHeight + CHAR_SIZE * 2 };
        char.mode = "roam";
        log("overlay", `${char.session.name}: leaving (walk-off)`);
      }
      if (goneMs > 10000 || char.x < -CHAR_SIZE * 2 || char.x > window.innerWidth + CHAR_SIZE ||
          char.y < -CHAR_SIZE * 2 || char.y > window.innerHeight + CHAR_SIZE) {
        char.el.remove();
        chars.delete(id);
      }
    }
  }

  // Add/update chars
  for (const session of sessions) {
    if (!chars.has(session.id)) {
      const el = createCharElement(session);
      container.appendChild(el);
      const edge = randomEdgePosition();
      chars.set(session.id, {
        session, el,
        x: edge.x, y: edge.y, vx: 0, vy: 0,
        mode: "follow",
        roamTarget: randomRoamTarget(), roamTimer: 0,
        spawnedAt: Date.now(),
        modeSetAt: Date.now(),
        clusteredTo: null,
      });
      el.classList.add("char-appearing");
      setTimeout(() => el.classList.remove("char-appearing"), 400);
      log("overlay", `added: ${session.name}`);
    } else {
      const char = chars.get(session.id)!;
      const prevPinned = char.session.pinned;
      const prevMuted = (char.session as any).muted;
      char.session = session;
      if (prevPinned !== session.pinned || prevMuted !== (session as any).muted) {
        char.el.classList.remove("char-poof");
        void char.el.offsetWidth;
        char.el.classList.add("char-poof");
      }
      delete char.el.dataset.goneAt;
      // Update char SVG if character changed
      const currentChar = char.el.dataset.char || "ghost";
      const newCharId = session.character || currentChar;
      if (newCharId !== currentChar) {
        const charDef = getCharacter(newCharId);
        const svgWrap = char.el.querySelector(".overlay-char-svg");
        if (svgWrap) {
          svgWrap.innerHTML = charDef.svg;
          svgWrap.setAttribute("data-char", newCharId);
        }
        char.el.dataset.char = newCharId;
      }
      // Update group/title/action labels
      const groupEl = char.el.querySelector(".overlay-char-group");
      if (groupEl) groupEl.textContent = session.group || session.source;
      const titleEl = char.el.querySelector(".overlay-char-title");
      if (titleEl) titleEl.textContent = session.name;
      const actionEl = char.el.querySelector(".overlay-char-action");
      if (actionEl) {
        const icon = getToolIcon(session.tool, session.event);
        const text = getActionText(session);
        actionEl.innerHTML = `${icon ? `<span class="action-icon">${icon}</span>` : ""}${text}`;
      }
    }
  }

  applyModes();
}

// ─── Mode Assignment (delegates to modes.ts) ────────────────────────────────

let prevAssignments: Map<string, import("./modes").ModeAssignment> = new Map();

function applyModes(): void {
  const charArray = Array.from(chars.values()).filter(c => !c.el.dataset.leaving);

  const states: CharState[] = charArray.map(c => ({
    sessionId: c.session.id,
    session: c.session,
    currentMode: c.mode,
    spawnedAt: c.spawnedAt,
    lastUserTs: c.session.last_user_ts ?? (c.session.mtime * 1000),
    interactionCount: c.session.interaction_count ?? 0,
  }));

  const batterySaverOn = localStorage.getItem("nagents:battery_saver") === "true" || cfg.overlay_mode === "off";

  const modeCfg: ModeConfig = {
    max_followers: batterySaverOn ? 1 : (cfg.max_followers ?? MODE_DEFAULTS.max_followers),
    max_roamers: batterySaverOn ? 0 : (cfg.max_roamers ?? MODE_DEFAULTS.max_roamers),
    max_dots: batterySaverOn ? 0 : (cfg.max_dots ?? MODE_DEFAULTS.max_dots),
    follower_mode: cfg.follower_mode ?? MODE_DEFAULTS.follower_mode,
    round_robin_sec: cfg.round_robin_sec ?? MODE_DEFAULTS.round_robin_sec,
    pin_counts_toward_max: cfg.pin_counts_toward_max ?? MODE_DEFAULTS.pin_counts_toward_max,
    group_as_one: localStorage.getItem("nagents:group_as_one") === "true" || (cfg.group_as_one ?? MODE_DEFAULTS.group_as_one),
    group_display: localStorage.getItem("nagents:group_display") || cfg.group_display || "cluster",
    working_mode: cfg.working_mode || "roam",
    working_counts_toward_max: cfg.working_counts_toward_max ?? false,
    attention_follows: cfg.attention_follows ?? true,
    freq_half_life_min: cfg.freq_half_life_min ?? 60,
  };

  const assignments = computeModes(states, modeCfg);

  const newAssignmentStr = JSON.stringify(Array.from(assignments.entries()).sort());
  const prevAssignmentStr = JSON.stringify(Array.from(prevAssignments.entries()).sort());
  const modesChanged = newAssignmentStr !== prevAssignmentStr;
  prevAssignments = assignments;

  if (modesChanged) {
    const assignmentData: Record<string, string> = {};
    for (const [id, a] of assignments) {
      assignmentData[id] = a.mode;
    }
    localStorage.setItem("nagents:mode_assignments", JSON.stringify(assignmentData));
  }

  let hiddenCount = 0;
  for (const char of charArray) {
    const assignment = assignments.get(char.session.id);
    if (!assignment) continue;

    const newMode = assignment.mode;
    const prevMode = char.mode;

    if (prevMode !== newMode) {
      if (prevMode === "revolve") {
        char.el.classList.remove("char-dot");
        char.el.style.transform = "";
        char.el.style.transformOrigin = "";
        char.el.style.width = `${CHAR_SIZE}px`;
        char.el.style.fontSize = "";
        char.el.style.display = "";
        char.el.querySelectorAll(".overlay-char-group, .overlay-char-title, .overlay-char-action")
          .forEach((l: Element) => { (l as HTMLElement).style.display = ""; });
      }
      if (newMode === "revolve") {
        char.el.querySelectorAll(".overlay-char-group, .overlay-char-title, .overlay-char-action")
          .forEach((l: Element) => { (l as HTMLElement).style.display = "none"; });
      }
      if (newMode === "roam" && prevMode !== "roam") {
        char.spawnedAt = Date.now();
        char.vx = 0;
        char.vy = 0;
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      if (newMode === "follow" && prevMode !== "follow") {
        char.vx = 0;
        char.vy = 0;
      }
      char.modeSetAt = Date.now();
      log("overlay", `${char.session.name}: ${prevMode} → ${newMode} (event=${char.session.event} attn=${char.session.attention} prio=${char.session.priority})`);
    }

    char.mode = newMode;
    char.clusteredTo = assignment.clusteredTo || null;
    char.el.style.opacity = "";

    if (newMode === "hidden" || batterySaverOn) {
      if (prevMode && prevMode !== "hidden" && !batterySaverOn) {
        char.el.classList.remove("char-poof");
        void char.el.offsetWidth;
        char.el.classList.add("char-poof");
        setTimeout(() => { char.el.style.display = "none"; }, 250);
      } else {
        char.el.style.display = "none";
      }
      if (newMode === "hidden" && !assignment.groupHidden) hiddenCount++;
    } else {
      char.el.style.display = "";
    }
  }

  if (batterySaverOn) {
    if (hiddenBadgeEl) hiddenBadgeEl.style.display = "none";
  } else {
    updateHiddenBadge(hiddenBadgeEl, hiddenCount);
  }

  setAllCharsHidden(batterySaverOn || hiddenCount === charArray.length);
}

// ─── Render Loop ────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;";
  container!.appendChild(svg);

  setFrameInterval(1000 / cfg.physics_fps);
  let lastFrame = 0;
  let frameCount = 0;

  let cachedBatterySaver = localStorage.getItem("nagents:battery_saver") === "true";
  let cachedHiddenUntil = Number(localStorage.getItem("nagents:overlay_hidden_until") || "0");
  let cacheRefreshCounter = 0;

  function tick(now: number) {
    setAnimFrameId(requestAnimationFrame(tick));

    cacheRefreshCounter++;
    if (cacheRefreshCounter >= 60) {
      cacheRefreshCounter = 0;
      const newBatterySaver = localStorage.getItem("nagents:battery_saver") === "true";
      if (newBatterySaver !== cachedBatterySaver) {
        log("overlay", `battery saver changed: ${cachedBatterySaver} → ${newBatterySaver}`);
      }
      cachedBatterySaver = newBatterySaver;
      cachedHiddenUntil = Number(localStorage.getItem("nagents:overlay_hidden_until") || "0");
    }

    const effectiveInterval = cachedBatterySaver ? 66 : frameInterval;
    if (now - lastFrame < effectiveInterval) return;
    lastFrame = now;
    frameCount++;
    updatePhysics(cachedBatterySaver, cachedHiddenUntil);
    // Draw connections (skip in battery saver or when disabled)
    const connectorsEnabled = cfg.connectors !== false;
    if (!cachedBatterySaver && connectorsEnabled && frameCount % 3 === 0) {
      drawConnections(svg);
    } else if ((cachedBatterySaver || !connectorsEnabled) && svg.innerHTML) {
      svg.innerHTML = "";
    }
  }
  setAnimFrameId(requestAnimationFrame(tick));
}
