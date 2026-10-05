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
  setVirtualBounds, setDisplayBounds, isPerDisplay, isLeadWindow, setIsLeadWindow,
  displayOriginX, displayOriginY, displayWidth, displayHeight,
  virtualOriginX, virtualOriginY, canvasW, canvasH, setDisplayRects,
  latestFollowerFrame, setLatestFollowerFrame,
} from "./overlay-state";
import type { OverlayChar } from "./overlay-state";
import { updatePhysics } from "./physics";
import { drawConnections } from "./connections";
import { createCharElement, getToolIcon, getActionText, randomRoamTarget, randomEdgePosition, updateHiddenBadge } from "./dom";
import { initDebugPanel, updateCharDistanceBadges } from "./debug-panel";

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

/** Toggle .reduce-motion class on the overlay container. When active, CSS
 *  disables all keyframe animations (blink, pulse, shake, orbit, poof, bob),
 *  drastically reducing WindowServer compositor repaints. */
function applyReduceMotion(): void {
  if (!container) return;
  const reduce = cfg.reduce_motion === true || cfg.reduce_motion === "true"
    || localStorage.getItem("nagents:setting:reduce_motion") === "true";
  container.classList.toggle("reduce-motion", reduce);
  document.documentElement.classList.toggle("reduce-motion", reduce);
}

// ─── Init ───────────────────────────────────────────────────────────────────

// ─── Follower lifecycle (cancel on re-init / HMR) ───────────────────────────
// startFollowerRenderer creates a rAF loop + Tauri event listener, both captured
// in closures. On HMR re-init, initOverlay runs again — without cleanup, old
// loops survive and create duplicate DOM elements (artifact source). These hooks
// let initOverlay tear down the previous follower before starting a new one.
let _followerCleanup: (() => void) | null = null;
/** Timestamp of last state change (new session, attention change). Used by the
 *  render loop to prevent idle freeze when chars haven't settled yet. */
let _lastStateChangeAt = Date.now();

export async function initOverlay(el: HTMLElement): Promise<void> {
  // Cancel any previous follower renderer (HMR re-init safety).
  if (_followerCleanup) {
    _followerCleanup();
    _followerCleanup = null;
  }

  setContainer(el);
  log("overlay", "initializing");

  // Debug panel (draggable, shows on all displays, reads from lead's broadcast)
  initDebugPanel();

  // Per-display mode: each window discovers its display bounds via Tauri IPC
  // command (not URL params — WebviewUrl::App encodes ? in the path, so query
  // params are lost). If the command returns data, this is a per-display window.
  // Primary display (is_lead=true) runs the full physics; others are followers
  // that receive char positions via Tauri events and only render their slice.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{
      dx: number; dy: number; dw: number; dh: number;
      vox: number; voy: number; vw: number; vh: number;
      is_lead: boolean;
      displays: Array<{ x: number; y: number; w: number; h: number }>;
    } | null>("get_overlay_display_info");
    if (info) {
      setDisplayBounds(info.dx, info.dy, info.dw, info.dh, info.vox, info.voy);
      setVirtualBounds(info.vw, info.vh);
      setDisplayRects(info.displays);
      log("overlay", `per-display: (${info.dx},${info.dy}) ${info.dw}x${info.dh} is_lead=${info.is_lead}`);
      if (!info.is_lead) {
        setIsLeadWindow(false);
        log("overlay", `follower mode — starting renderer`);
        applyReduceMotion();
        startFollowerRenderer(el, info.dx, info.dy, info.dw, info.dh);
        return;
      }
    }
  } catch (e) {
    log("overlay", `display info IPC failed (single-display mode): ${e}`);
  }

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
    applyReduceMotion();
    log("overlay", `config loaded: mode=${cfg.overlay_mode || "full"} followers=${cfg.max_followers} roamers=${cfg.max_roamers} dots=${cfg.max_dots} charSize=${CHAR_SIZE}`);
  } catch {
    log("overlay", "config load failed, using defaults");
  }

  let cursorInterval = Math.round(1000 / cfg.cursor_fps);
  let lastPollX = 0, lastPollY = 0, cursorPollIdleCount = 0;
  (async () => {
    while (true) {
      // In per-display mode, every window must keep polling at full speed even
      // when no chars are visible on this display — the cursor could arrive
      // any frame. Only throttle in single-window mode when truly idle.
      if (!isPerDisplay && cursorReady && (chars.size === 0 || allCharsHidden)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          const raw = await resp.json();
          // Per-display: cursor stays global. Each char's position is in
          // virtual space; toDisplayLocal maps to this display's local coords
          // at render time.
          if (isPerDisplay) {
            cursorTarget.x = raw.x;
            cursorTarget.y = raw.y;
          } else {
            // Single display: legacy offset.
            cursorTarget.x = raw.x;
            cursorTarget.y = raw.y - 38;
          }
          setCursorReady(true);
          // Adaptive poll rate: slow down when cursor is idle (same position).
          const px = Math.round(raw.x), py = Math.round(raw.y);
          if (px === lastPollX && py === lastPollY) {
            cursorPollIdleCount++;
          } else {
            lastPollX = px; lastPollY = py; cursorPollIdleCount = 0;
          }
        }
      } catch {}
      // When cursor idle for 20+ polls, slow to 1/sec (was 10/sec).
      // Detects movement within 1s and resumes full speed.
      const pollDelay = cursorPollIdleCount > 20 ? 1000 : cursorInterval;
      await new Promise(r => setTimeout(r, pollDelay));
    }
  })();

  // Listen for config changes (fs watch events from Rust, instant)
  onConfigChanged((fresh) => {
    if (fresh.overlay) {
      const prevWorkingMode = cfg.working_mode;
      setCfg(fresh.overlay);
      applyOverlayMode();
      if (cfg.char_size) setCharSize(cfg.char_size);
      applyReduceMotion();
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
        applyReduceMotion();
        cursorInterval = Math.round(1000 / cfg.cursor_fps);
        setFrameInterval(1000 / cfg.physics_fps);
      }
    } catch {}
  }, 10000);

  onStateChanged(async (state) => {
    if (!cursorReady) return;
    syncChars(state.sessions.filter(s => s.active));
    // Wake render loop: reset the cursor idle timer so new chars get full
    // physics to reach cursor (otherwise they'd freeze at spawn edge).
    _lastStateChangeAt = Date.now();
  });

  startRenderLoop();
  log("overlay", "render loop started");

  // ─── Auto-detect display refresh rate ──────────────────────────────
  // If the display runs at a higher Hz than physics_fps (e.g. 100Hz Dell
  // vs 60fps physics), bump physics_fps to match so broadcasts keep up.
  // Measure actual rAF interval over 20 frames, then adjust once.
  {
    let detectCount = 0;
    let detectStart = 0;
    const detectHz = (ts: number) => {
      if (detectCount === 0) { detectStart = ts; }
      detectCount++;
      if (detectCount < 21) { requestAnimationFrame(detectHz); return; }
      const elapsed = ts - detectStart;
      const measuredFps = Math.round(20000 / elapsed);
      if (measuredFps > cfg.physics_fps + 10) {
        log("overlay", `display refresh ${measuredFps}Hz > physics_fps ${cfg.physics_fps} → bumping to ${measuredFps}`);
        cfg.physics_fps = measuredFps;
        setFrameInterval(1000 / measuredFps);
      } else {
        log("overlay", `display refresh ~${measuredFps}Hz, physics_fps ${cfg.physics_fps} OK`);
      }
    };
    requestAnimationFrame(detectHz);
  }

  // ─── Auto Battery Mode ──────────────────────────────────────────────
  // Power state is managed by Rust backend as runtime config overrides.
  // When on battery → Rust sets battery_saver=true in runtime config.
  // GET /config returns effective config (user + runtime merged).
  // The overlay just reads cfg.battery_saver — no localStorage needed.
  log("overlay", "battery mode managed by backend runtime config");

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
        const toLeft = cx, toRight = canvasW() - cx;
        const toTop = cy, toBottom = canvasH() - cy;
        const min = Math.min(toLeft, toRight, toTop, toBottom);
        if (min === toLeft) char.roamTarget = { x: -CHAR_SIZE * 2, y: char.y };
        else if (min === toRight) char.roamTarget = { x: canvasW() + CHAR_SIZE * 2, y: char.y };
        else if (min === toTop) char.roamTarget = { x: char.x, y: -CHAR_SIZE * 2 };
        else char.roamTarget = { x: char.x, y: canvasH() + CHAR_SIZE * 2 };
        char.mode = "roam";
        log("overlay", `${char.session.name}: leaving (walk-off)`);
      }
      if (goneMs > 10000 || char.x < -CHAR_SIZE * 2 || char.x > canvasW() + CHAR_SIZE ||
          char.y < -CHAR_SIZE * 2 || char.y > canvasH() + CHAR_SIZE) {
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
      const edge = randomEdgePosition(session.id);
      chars.set(session.id, {
        session, el,
        x: edge.x, y: edge.y, vx: 0, vy: 0,
        mode: "follow",
        roamTarget: randomRoamTarget(session.id, 0), roamTimer: 0, roamPickCount: 0,
        spawnedAt: session.mtime ? session.mtime * 1000 : Date.now(),
        modeSetAt: session.mtime ? session.mtime * 1000 : Date.now(),
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
        // Update pin/mute badge
        const badgeEl = char.el.querySelector(".overlay-char-badge");
        if (badgeEl) badgeEl.textContent = session.pinned ? "📌" : session.muted ? "🔇" : "";
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

  const batterySaverOn = cfg.battery_saver === true || cfg.battery_saver === "true" || cfg.overlay_mode === "off";

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
    cluster_carousel: localStorage.getItem("nagents:cluster_carousel") === "true" || (cfg.cluster_carousel ?? false),
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
        char.roamTarget = randomRoamTarget(char.session.id, char.roamTimer);
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
    char.clusterAnchor = assignment.clusterAnchor || false;
    char.clusterCenter = assignment.clusterCenter || false;
    // Glow on the anchor (the prio-giving sun), even while it orbits in carousel.
    char.el.classList.toggle("char-sun", !!assignment.clusterAnchor);
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

  let cachedBatterySaver = cfg.battery_saver === true || cfg.battery_saver === "true";
  let cachedHiddenUntil = Number(cfg.overlay_hidden_until || 0);
  let cacheRefreshCounter = 0;
  // Idle cursor detection: when cursor hasn't moved for 2s, drop to 15fps.
  // Chars are at rest → fewer DOM writes → WindowServer idles.
  let lastCursorX = 0, lastCursorY = 0, cursorIdleSince = 0;
  let wasFrozen = false;

  function tick(now: number) {

    cacheRefreshCounter++;
    if (cacheRefreshCounter >= 60) {
      cacheRefreshCounter = 0;
      const newBatterySaver = cfg.battery_saver === true || cfg.battery_saver === "true";
      if (newBatterySaver !== cachedBatterySaver) {
        log("overlay", `battery saver changed: ${cachedBatterySaver} → ${newBatterySaver}`);
      }
      cachedBatterySaver = newBatterySaver;
      cachedHiddenUntil = Number(cfg.overlay_hidden_until || 0);
    }

    // Detect cursor idle: if cursor position hasn't changed, track idle time.
    const cx = Math.round(cursorTarget.x), cy = Math.round(cursorTarget.y);
    if (cx !== lastCursorX || cy !== lastCursorY) {
      lastCursorX = cx; lastCursorY = cy; cursorIdleSince = now;
    }
    const cursorIdleMs = now - cursorIdleSince;

    // Hard freeze: when cursor idle 5s+, reduce to 0.5fps (2s interval).
    // Nearly zero compositor work while keeping rAF alive for wake detection.
    // EXCEPTION: attention chars keep physics at normal rate.
    // On first freeze frame: run one final physics pass so chars settle to
    // their target positions (followers near cursor, roamers in their ring).
    let frozen = false;
    if (!cachedBatterySaver && cursorIdleMs > 5000) {
      const recentStateChange = (now - _lastStateChangeAt) < 5000;
      const hasUrgent = Array.from(chars.values()).some(c =>
        c.session.attention || c.session.event === "approval" || c.session.event === "stuck"
      );
      if (!hasUrgent && !recentStateChange) frozen = true;
    }

    // Schedule next frame.
    setAnimFrameId(requestAnimationFrame(tick));

    const effectiveInterval = cachedBatterySaver ? 66 : frozen ? 2000 : frameInterval;
    if (now - lastFrame < effectiveInterval) return;
    lastFrame = now;
    frameCount++;

    // On transition TO freeze: snap all chars to final positions.
    // Run physics with high strength so they arrive in one frame.
    if (frozen && !wasFrozen) {
      // Snap: set all velocities to zero, teleport to target.
      for (const c of chars.values()) {
        c.vx = 0;
        c.vy = 0;
      }
    }
    wasFrozen = frozen;

    updatePhysics(cachedBatterySaver, cachedHiddenUntil, now - cursorIdleSince);
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


// ─── Follower Renderer (per-display, non-lead windows) ──────────────────────
// Pure renderer: receives char positions from the lead window via Tauri events
// (emit/listen — the only cross-window mechanism that works across separate
// WKWebView processes in Tauri). No physics, no cursor polling, no mode
// assignment — one source of truth from the lead.
//
// Returns a cleanup function that cancels the rAF loop, removes the Tauri
// listener, and clears all follower DOM elements. Called by initOverlay on
// re-init (HMR) to prevent duplicate renderers.

function startFollowerRenderer(
  container: HTMLElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const MARGIN = 500;
  const STALE_MS = 3000;
  let cancelled = false;
  let unlistenFn: (() => void) | null = null;
  let lastBroadcastTs = Date.now();
  let staleCheckId: ReturnType<typeof setInterval> | null = null;

  // ─── Per-char state ──────────────────────────────────────────────
  // At 30fps broadcast rate, direct position assignment is smooth enough.
  // No lerp needed — it was causing a sluggish ease-in/ease-out effect
  // that didn't match the lead's constant-velocity physics.
  interface FollowerChar {
    el: HTMLElement;
    lastLx: number; // last rendered local X (for skip-if-unchanged)
    lastLy: number;
  }
  const charState = new Map<string, FollowerChar>();

  // +N hidden badge.
  const badgeEl = document.createElement("div");
  badgeEl.className = "overlay-hidden-badge";
  badgeEl.style.display = "none";
  badgeEl.style.position = "absolute";
  badgeEl.style.left = "0px";
  badgeEl.style.top = "0px";
  badgeEl.style.willChange = "transform";
  container.appendChild(badgeEl);

  // ─── Buffered frame ─────────────────────────────────────────────────
  let pendingFrame: {
    chars: Record<string, [number, number, string, string, string, string, string]>;
    cx: number; cy: number; hiddenCount: number;
  } | null = null;
  let lastHiddenCount = 0;

  // ─── Subscribe to lead broadcasts ───────────────────────────────────
  import("@tauri-apps/api/event").then(({ listen }) => {
    if (cancelled) return;
    listen<{
      chars: Record<string, [number, number, string, string, string, string, string]>;
      cx: number; cy: number; hiddenCount?: number;
    }>("nagents:charPositions", (event) => {
      if (cancelled) return;
      const p = event.payload;
      if (!p || !p.chars) return;
      lastBroadcastTs = Date.now();
      pendingFrame = { chars: p.chars, cx: p.cx, cy: p.cy, hiddenCount: p.hiddenCount || 0 };
    }).then((fn) => { unlistenFn = fn; });
    log("overlay", `follower listening for Tauri charPositions events`);
  }).catch((e) => {
    log("overlay", `follower Tauri listen failed: ${e}`);
  });

  // ─── rAF render loop (runs EVERY frame, not just on broadcast) ─────
  function renderTick() {
    if (cancelled) return;
    requestAnimationFrame(renderTick);

    // ── Process new broadcast (if any) ──
    if (pendingFrame) {
      const { chars: charData, cx, cy, hiddenCount } = pendingFrame;
      pendingFrame = null;
      lastHiddenCount = hiddenCount;
      setLatestFollowerFrame(charData);
      cursor.x = cx;
      cursor.y = cy;

      const activeIds = new Set(Object.keys(charData));

      // Remove departed chars.
      for (const [id, fc] of charState) {
        if (!activeIds.has(id)) {
          fc.el.remove();
          charState.delete(id);
        }
      }

      // Update / create chars.
      for (const [id, data] of Object.entries(charData)) {
        const [vx, vy, mode, charId, name, group, ev] = data;
        const lx = vx - dx;
        const ly = vy - dy;

        // Off this display — remove.
        if (lx < -MARGIN || lx > dw + MARGIN || ly < -MARGIN || ly > dh + MARGIN) {
          const fc = charState.get(id);
          if (fc) { fc.el.remove(); charState.delete(id); }
          continue;
        }

        let fc = charState.get(id);
        if (!fc) {
          // New char: create element, start at target (no lerp on first frame).
          const el = document.createElement("div");
          el.className = "overlay-char";
          el.dataset.sessionId = id;
          el.dataset.char = charId;
          const charDef = getCharacter(charId);
          el.innerHTML = `
            <div class="overlay-char-group" style="font-size:${cfg.font_size_group || 9}px">${group}</div>
            <div class="overlay-char-title" style="font-size:${cfg.font_size_title || 10}px">${name}</div>
            <div class="overlay-char-svg char-slot-idle" data-char="${charId}">${charDef.svg}</div>
            <div class="overlay-char-action" style="font-size:${cfg.font_size_action || 10}px">${ev || ""}</div>
          `;
          el.style.position = "absolute";
          el.style.left = "0px";
          el.style.top = "0px";
          el.style.width = `${cfg.char_size || 44}px`;
          el.style.pointerEvents = "none";
          el.style.willChange = "transform"; // GPU compositing — prevents ghost trails
          container.appendChild(el);
          fc = { el, lastLx: Math.round(lx), lastLy: Math.round(ly) };
          charState.set(id, fc);
        } else {
          // Update SVG if char changed.
          if (fc.el.dataset.char !== charId) {
            const charDef = getCharacter(charId);
            const svgWrap = fc.el.querySelector(".overlay-char-svg");
            if (svgWrap) {
              svgWrap.innerHTML = charDef.svg;
              svgWrap.setAttribute("data-char", charId);
            }
            fc.el.dataset.char = charId;
          }
          // Update text labels (only if changed — avoids DOM write).
          const titleEl = fc.el.querySelector(".overlay-char-title");
          if (titleEl && titleEl.textContent !== name) titleEl.textContent = name;
          const groupEl = fc.el.querySelector(".overlay-char-group");
          if (groupEl && groupEl.textContent !== group) groupEl.textContent = group;
        }

        // GPU-composited position — skip write if position unchanged (avoids
        // unnecessary WindowServer recomposite when chars are stationary).
        const rlx = Math.round(lx), rly = Math.round(ly);
        if (rlx !== fc.lastLx || rly !== fc.lastLy) {
          fc.el.style.transform = `translate(${rlx}px, ${rly}px)`;
          fc.lastLx = rlx;
          fc.lastLy = rly;
        }

        // Apply mode-based CSS classes so chars look the same as on the lead
        // (without these, roamers appear at full opacity/size on follower but
        // dimmed/scaled on lead — visual mismatch).
        fc.el.classList.toggle("char-following", mode === "follow");
        fc.el.classList.toggle("char-roaming", mode === "roam");
        fc.el.classList.toggle("char-dot", mode === "revolve");
      }
    }

    // +N badge near cursor (convert global → local for CSS positioning).
    if (lastHiddenCount > 0) {
      const blx = cursor.x - dx - 12;
      const bly = cursor.y - dy - 24;
      if (blx > -MARGIN && blx < dw + MARGIN && bly > -MARGIN && bly < dh + MARGIN) {
        badgeEl.textContent = `+${lastHiddenCount}`;
        badgeEl.style.transform = `translate(${Math.round(blx)}px, ${Math.round(bly)}px)`;
        badgeEl.style.display = "";
      } else {
        badgeEl.style.display = "none";
      }
    } else {
      badgeEl.style.display = "none";
    }
  }
  requestAnimationFrame(renderTick);

  // ─── Stale broadcast check (safety net for missed broadcasts) ────────
  // If the lead stops broadcasting (crash, HMR, Tauri IPC failure), chars
  // on this follower would freeze as permanent artifacts. This interval
  // removes all chars if no broadcast has arrived within STALE_MS.
  staleCheckId = setInterval(() => {
    if (cancelled) return;
    if (charState.size > 0 && Date.now() - lastBroadcastTs > STALE_MS) {
      for (const [, fc] of charState) fc.el.remove();
      charState.clear();
      log("overlay", `follower: cleared stale chars (no broadcast for ${STALE_MS}ms)`);
    }
  }, 1000);

  // ─── Cleanup (called by initOverlay on re-init) ────────────────────
  _followerCleanup = () => {
    cancelled = true;
    if (unlistenFn) unlistenFn();
    if (staleCheckId) clearInterval(staleCheckId);
    for (const [, fc] of charState) fc.el.remove();
    charState.clear();
    badgeEl.remove();
    log("overlay", "follower renderer cleaned up (re-init)");
  };

  // Debug panel on followers too.
  initDebugPanel();
  log("overlay", `follower renderer started (Tauri events, display ${dx},${dy} ${dw}x${dh})`);
}
