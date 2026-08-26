/**
 * Overlay — transparent fullscreen window with animated characters.
 *
 * nagents (nagging ai agents): chars nag you to deal with idle sessions,
 * stand in corners when working, orbit as dots when overflow.
 *
 * Mode assignment delegated to modes.ts (pure logic).
 * This file: rendering, physics, DOM, cursor tracking.
 */

import type { Session, CursorPosition, OverlayConfig } from "../shared/types";
import { pollState, getConfig, setOverlayClickthrough, log, onConfigChanged, onStateChanged } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import { computeModes, type CharMode, type CharState, type ModeConfig, MODE_DEFAULTS } from "./modes";

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverlayChar {
  session: Session;
  el: HTMLElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: CharMode;
  roamTarget: { x: number; y: number };
  roamTimer: number;
  spawnedAt: number;
  /** Timestamp when mode was last changed */
  modeSetAt: number;
  /** If set, this char is clustered to the given session (targets its position, scales down) */
  clusteredTo: string | null;
}

// ─── State ──────────────────────────────────────────────────────────────────

let cursor: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let cursorTarget: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const chars: Map<string, OverlayChar> = new Map();
let container: HTMLElement | null = null;
let animFrameId: number | null = null;
let globalRevolveAngle = 0;
let cursorReady = false;
let lastSummaryLog = 0;
let hiddenBadgeEl: HTMLElement | null = null;
/** True when all chars have mode=hidden (skip cursor poll) */
let allCharsHidden = false;
let frameInterval = 1000 / 60;

// ─── Config ─────────────────────────────────────────────────────────────────

let cfg: OverlayConfig = {
  follow_strength: 0.04,
  roam_strength: 0.008,
  roam_max_speed: 3,
  follow_max_speed: 6,
  min_cursor_distance: 80,
  collision_distance: 100,
  revolve_radius: 50,
  revolve_speed: 0.015,
  shrink_after_min: 15,
  dot_scale: 0.55,
  cursor_fps: 5,
  cursor_smoothing: 0.07,
  physics_fps: 60,
  font_size_group: 9,
  font_size_title: 10,
  font_size_action: 10,
  max_followers: 2,
  max_dots: 5,
  max_roamers: 3,
  pin_counts_toward_max: false,
  group_as_one: false,
  source_as_group: false,
  follower_mode: "priority,lifo",
  round_robin_sec: 10,
};

const DAMPING = 0.88;
let CHAR_SIZE = 44; // base char size, configurable via cfg.char_size

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
    cfg.physics_fps = 30; // 30fps is smooth enough for 1 slow char
  }
  // "full" = no overrides, use config as-is
  // "off" = handled by battery_saver flow (overlay hidden)
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  hiddenBadgeEl = document.createElement("div");
  hiddenBadgeEl.className = "overlay-hidden-badge";
  hiddenBadgeEl.style.display = "none";
  el.appendChild(hiddenBadgeEl);

  try {
    const appConfig = await getConfig();
    if (appConfig.overlay) cfg = appConfig.overlay;
    applyOverlayMode();
    if (cfg.char_size) CHAR_SIZE = cfg.char_size;
    log("overlay", `config loaded: mode=${cfg.overlay_mode || "full"} followers=${cfg.max_followers} roamers=${cfg.max_roamers} dots=${cfg.max_dots} charSize=${CHAR_SIZE}`);
  } catch {
    log("overlay", "config load failed, using defaults");
  }

  let cursorInterval = Math.round(1000 / cfg.cursor_fps);
  (async () => {
    while (true) {
      // Pause cursor poll when no chars on screen or all chars hidden
      if (cursorReady && (chars.size === 0 || allCharsHidden)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          const raw = await resp.json();
          cursorTarget.x = raw.x;
          cursorTarget.y = raw.y - 38; // menu bar offset (macOS ~38px)
          cursorReady = true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, cursorInterval));
    }
  })();

  // Listen for config changes (fs watch events from Rust, instant)
  onConfigChanged((fresh) => {
    if (fresh.overlay) {
      const prevWorkingMode = cfg.working_mode;
      cfg = fresh.overlay;
      applyOverlayMode();
      if (cfg.char_size) CHAR_SIZE = cfg.char_size;
      cursorInterval = Math.round(1000 / cfg.cursor_fps);
      frameInterval = 1000 / cfg.physics_fps;
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

  // Fallback: re-read config every 10s in case Tauri events don't reach this window
  setInterval(async () => {
    try {
      const fresh = await getConfig();
      if (fresh.overlay) {
        cfg = fresh.overlay;
        applyOverlayMode();
        if (cfg.char_size) CHAR_SIZE = cfg.char_size;
        cursorInterval = Math.round(1000 / cfg.cursor_fps);
        frameInterval = 1000 / cfg.physics_fps;
      }
    } catch {}
  }, 10000);

  onStateChanged(async (state) => {
    if (!cursorReady) return;
    // ALL sessions shown on overlay. Waterfall determines zone (follow/roam/dot/hidden).
    syncChars(state.sessions.filter(s => s.active));
  });

  startRenderLoop();
  log("overlay", "render loop started");

  // Sleep/wake detection: pause overlay after system sleep, resume with delay
  let lastTimestamp = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTimestamp;
    lastTimestamp = now;
    // If >10s gap between checks (interval is 2s), system was sleeping
    if (gap > 10000) {
      const delay = (cfg.startup_delay_sec ?? 5) * 1000;
      log("overlay", `wake detected (gap=${Math.round(gap/1000)}s), pausing for ${delay/1000}s`);
      allCharsHidden = true; // pause physics
      setTimeout(() => {
        allCharsHidden = false;
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
      // Debounce: only start removal after 3s of being gone (prevents flicker)
      if (!char.el.dataset.goneAt) {
        char.el.dataset.goneAt = String(Date.now());
        continue; // Don't remove yet — wait
      }
      const goneMs = Date.now() - Number(char.el.dataset.goneAt);
      if (goneMs < 3000) continue; // Still debouncing

      // Animate walk-off: set target to nearest edge, remove after reaching it
      if (!char.el.dataset.leaving) {
        char.el.dataset.leaving = "1";
        char.el.classList.add("char-hiding");
        // Pick nearest edge
        const cx = char.x + CHAR_SIZE / 2;
        const cy = char.y + CHAR_SIZE / 2;
        const toLeft = cx, toRight = window.innerWidth - cx;
        const toTop = cy, toBottom = window.innerHeight - cy;
        const min = Math.min(toLeft, toRight, toTop, toBottom);
        if (min === toLeft) char.roamTarget = { x: -CHAR_SIZE * 2, y: char.y };
        else if (min === toRight) char.roamTarget = { x: window.innerWidth + CHAR_SIZE * 2, y: char.y };
        else if (min === toTop) char.roamTarget = { x: char.x, y: -CHAR_SIZE * 2 };
        else char.roamTarget = { x: char.x, y: window.innerHeight + CHAR_SIZE * 2 };
        char.mode = "roam"; // Use roam physics to walk to edge
        log("overlay", `${char.session.name}: leaving (walk-off)`);
      }
      // Check if off screen → actually remove
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
      // Appear animation
      el.classList.add("char-appearing");
      setTimeout(() => el.classList.remove("char-appearing"), 400);
      log("overlay", `added: ${session.name}`);
    } else {
      const char = chars.get(session.id)!;
      // Detect pin/mute state change → poof animation
      const prevPinned = char.session.pinned;
      const prevMuted = (char.session as any).muted;
      char.session = session;
      if (prevPinned !== session.pinned || prevMuted !== (session as any).muted) {
        char.el.classList.remove("char-poof");
        void char.el.offsetWidth;
        char.el.classList.add("char-poof");
      }
      // Clear removal debounce if session came back
      delete char.el.dataset.goneAt;
      // Update char SVG if character changed (user picked in panel)
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

/** Cached previous assignments — only recompute when inputs change meaningfully */
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
  // Compute modes only when state has meaningfully changed
  const stateFingerprint = states.map(s =>
    `${s.sessionId}:${s.session.event}:${s.session.attention}:${s.session.pinned}:${(s.session as any).muted}:${s.session.active}`
  ).sort().join(",");

  const assignments = computeModes(states, modeCfg);

  // Only publish + apply DOM changes if assignments actually differ
  const newAssignmentStr = JSON.stringify(Array.from(assignments.entries()).sort());
  const prevAssignmentStr = JSON.stringify(Array.from(prevAssignments.entries()).sort());
  const modesChanged = newAssignmentStr !== prevAssignmentStr;
  prevAssignments = assignments;

  if (modesChanged) {
    // Publish assignments to localStorage so panel (separate webview) can read them
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
        // Restore text labels when leaving dot mode
        char.el.querySelectorAll(".overlay-char-group, .overlay-char-title, .overlay-char-action")
          .forEach((l: Element) => { (l as HTMLElement).style.display = ""; });
      }
      if (newMode === "revolve") {
        // Hide dot text labels (display:none = no render cost)
        char.el.querySelectorAll(".overlay-char-group, .overlay-char-title, .overlay-char-action")
          .forEach((l: Element) => { (l as HTMLElement).style.display = "none"; });
      }
      if (newMode === "roam" && prevMode !== "roam") {
        char.spawnedAt = Date.now();
        // Reset velocity to prevent carry-over momentum (e.g. follow→roam jank)
        char.vx = 0;
        char.vy = 0;
        // Pick a new roam target away from cursor
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      if (newMode === "follow" && prevMode !== "follow") {
        // Reset velocity so follower smoothly approaches cursor
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
      // Poof before hiding (only if was previously visible)
      if (prevMode && prevMode !== "hidden" && !batterySaverOn) {
        char.el.classList.remove("char-poof");
        void char.el.offsetWidth;
        char.el.classList.add("char-poof");
        // Hide after poof animation (250ms)
        setTimeout(() => { char.el.style.display = "none"; }, 250);
      } else {
        char.el.style.display = "none";
      }
      if (newMode === "hidden" && !assignment.groupHidden) hiddenCount++;
    } else {
      char.el.style.display = "";
    }
  }

  // In battery saver, hide the +N badge and satellites too
  if (batterySaverOn) {
    if (hiddenBadgeEl) hiddenBadgeEl.style.display = "none";
  } else {
    updateHiddenBadge(hiddenCount);
  }

  // Track whether all chars are hidden (for cursor poll optimization)
  // In battery saver mode, all chars are visually hidden (no cursor poll needed)
  allCharsHidden = batterySaverOn || hiddenCount === charArray.length;
}

// ─── Render Loop ────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;";
  container!.appendChild(svg);

  frameInterval = 1000 / cfg.physics_fps;
  let lastFrame = 0;
  let frameCount = 0;

  // Cache localStorage reads (refresh every 60 frames ≈ 1s at 60fps)
  let cachedBatterySaver = localStorage.getItem("nagents:battery_saver") === "true";
  let cachedHiddenUntil = Number(localStorage.getItem("nagents:overlay_hidden_until") || "0");
  let cacheRefreshCounter = 0;

  function tick(now: number) {
    animFrameId = requestAnimationFrame(tick);

    // Refresh localStorage cache every 60 frames (~1s)
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

    const effectiveInterval = cachedBatterySaver ? 66 : frameInterval; // 15fps vs configured
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
  animFrameId = requestAnimationFrame(tick);
}

function updatePhysics(batterySaver: boolean, hiddenUntil: number): void {
  // Lerp cursor toward target (smooths jumps from slow poll rate)
  const smoothing = cfg.cursor_smoothing || 0.12;
  cursor.x += (cursorTarget.x - cursor.x) * smoothing;
  cursor.y += (cursorTarget.y - cursor.y) * smoothing;

  const charArray = Array.from(chars.values());
  const now = Date.now();

  // Check overlay hide flag (set by panel)
  if (hiddenUntil === Infinity || (hiddenUntil > 0 && now < hiddenUntil)) {
    // Hide all chars
    for (const c of charArray) c.el.style.display = "none";
    if (hiddenBadgeEl) hiddenBadgeEl.style.display = "none";
    if (container) container.style.opacity = "0";
    hideBsbBox();
    return;
  } else if (container && container.style.opacity === "0") {
    container.style.opacity = "";
    localStorage.removeItem("nagents:overlay_hidden_until");
  }

  // Skip physics entirely if no visible chars (power saving)
  if (charArray.length === 0) { hideBsbBox(); return; }

  // Battery saver: show separate BSB window (small transparent, draggable)
  if (batterySaver) {
    for (const c of charArray) c.el.style.display = "none";
    for (const [, el] of satellites) el.style.display = "none";
    if (hiddenBadgeEl) hiddenBadgeEl.style.display = "none";
    showBsbWindow();
    return;
  } else {
    hideBsbWindow();
    hideBsbBox();
    for (const [, el] of satellites) el.style.display = "";
  }

  const visibleChars = charArray.filter(c => c.el.style.display !== "none");
  if (visibleChars.length === 0) return;

  // Periodic summary
  if (now - lastSummaryLog > 10000 && charArray.length > 0) {
    lastSummaryLog = now;
    const counts = { follow: 0, roam: 0, revolve: 0, hidden: 0 };
    for (const c of charArray) if (c.mode in counts) counts[c.mode as keyof typeof counts]++;
    log("overlay", `[summary] total=${charArray.length} follow=${counts.follow}/${cfg.max_followers} roam=${counts.roam}/${cfg.max_roamers} dot=${counts.revolve}/${cfg.max_dots} hidden=${counts.hidden}`);
  }

  // No smoothCursor — physics handles all smoothing.
  // ALL chars (follow, roam, dots) use the same physics loop.
  // Dots target their orbit position. Followers target cursor. Roamers target random.

  const dotChars = charArray.filter(c => c.mode === "revolve" && !c.clusteredTo);
  const dotCount = dotChars.length;
  globalRevolveAngle += cfg.revolve_speed;

  for (const char of charArray) {
    if (char.el.style.display === "none") continue; // Skip hidden

    // ─── Determine target based on mode ──────────────────────────────
    let targetX: number, targetY: number, strength: number;

    if (char.mode === "revolve") {
      // Dots: lerp toward orbit position (smooth, no physics/velocity)
      const dotIndex = dotChars.indexOf(char);
      const angle = globalRevolveAngle + (2 * Math.PI * dotIndex) / Math.max(1, dotCount);
      const orbitX = cursor.x + Math.cos(angle) * cfg.revolve_radius;
      const orbitY = cursor.y + Math.sin(angle) * cfg.revolve_radius;
      // Smooth lerp (0.15 = fast catch-up without rubber-band)
      const lerpFactor = 0.15;
      char.x += (orbitX - char.x) * lerpFactor;
      char.y += (orbitY - char.y) * lerpFactor;
      char.vx = 0;
      char.vy = 0;
      // Apply dot visual — scale and center on orbit point
      const dotScale = cfg.dot_scale || 0.4;
      // Measure SVG center offset within element (cached after first read)
      if (!(char as any)._svgCenterX) {
        const svgEl = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
        if (svgEl) {
          (char as any)._svgCenterX = svgEl.offsetLeft + svgEl.offsetWidth / 2;
          (char as any)._svgCenterY = svgEl.offsetTop + svgEl.offsetHeight / 2;
        } else {
          (char as any)._svgCenterX = CHAR_SIZE / 2;
          (char as any)._svgCenterY = CHAR_SIZE / 2;
        }
      }
      const cx = (char as any)._svgCenterX;
      const cy = (char as any)._svgCenterY;
      // Translate so SVG center sits exactly at left/top, then scale
      char.el.style.transform = `translate(${-cx}px, ${-cy}px) scale(${dotScale})`;
      char.el.style.transformOrigin = `${cx}px ${cy}px`;
      char.el.classList.add("char-dot");
      char.el.classList.remove("char-following", "char-roaming", "char-working");
      // Dot text opacity set via CSS custom property (only on mode enter, see below)
      // Render position and skip physics
      const newLeft = Math.round(char.x);
      const newTop = Math.round(char.y);
      if (newLeft !== (char as any)._lastLeft || newTop !== (char as any)._lastTop) {
        char.el.style.left = `${newLeft}px`;
        char.el.style.top = `${newTop}px`;
        (char as any)._lastLeft = newLeft;
        (char as any)._lastTop = newTop;
      }
      continue;
    } else if (char.mode === "follow") {
      const hw = (char.el.offsetWidth || CHAR_SIZE) / 2;
      const hh = (char.el.offsetHeight || CHAR_SIZE) / 2;
      // When dots exist, followers target outside the ring (not on cursor)
      if (dotCount > 0) {
        const ringOuter = cfg.revolve_radius + CHAR_SIZE; // well outside dot orbit
        // Position follower at ring-outer distance from cursor, on the line from cursor to char
        const charCx = char.x + hw;
        const charCy = char.y + hh;
        const dx = charCx - cursor.x;
        const dy = charCy - cursor.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          // Target: point on ring perimeter closest to current char position
          targetX = cursor.x + (dx / dist) * ringOuter - hw;
          targetY = cursor.y + (dy / dist) * ringOuter - hh;
        } else {
          // Char is exactly on cursor — push to arbitrary direction
          targetX = cursor.x + ringOuter - hw;
          targetY = cursor.y - hh;
        }
      } else {
        targetX = cursor.x - hw;
        targetY = cursor.y - hh;
      }
      strength = cfg.follow_strength || 0.04;
      // Clear dot visuals
      char.el.classList.remove("char-dot");
      char.el.style.transform = "";
      char.el.style.width = `${CHAR_SIZE}px`;
      char.el.style.fontSize = "";
    } else {
      // Roam
      char.roamTimer++;
      if (char.roamTimer > 240 || distTo(char, char.roamTarget) < 30) {
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      targetX = char.roamTarget.x;
      targetY = char.roamTarget.y;
      strength = Math.max(cfg.roam_strength, 0.02); // floor at 0.02 so target pull dominates collision noise
      // Clear dot visuals
      char.el.classList.remove("char-dot");
      char.el.style.transform = "";
      char.el.style.width = `${CHAR_SIZE}px`;
      char.el.style.fontSize = "";
    }

    // ─── Cluster override: fixed position around center char ────────────
    if (char.clusteredTo) {
      const rep = chars.get(char.clusteredTo);
      if (rep && rep.el.style.display !== "none") {
        // If rep is a dot, hide clustered members (too small to see, clutters dot ring)
        if (rep.mode === "revolve") {
          char.el.style.display = "none";
          continue;
        }
        // Fixed orbit position around rep (no physics)
        const clusterMembers = charArray.filter(c => c.clusteredTo === char.clusteredTo && c.el.style.display !== "none");
        const clusterIdx = clusterMembers.indexOf(char);
        const clusterCount = clusterMembers.length;
        const orbitAngle = (2 * Math.PI * clusterIdx) / Math.max(1, clusterCount);
        const orbitRadius = CHAR_SIZE * 0.8; // orbit outside rep's body area
        char.x = rep.x + Math.cos(orbitAngle) * orbitRadius;
        char.y = rep.y + Math.sin(orbitAngle) * orbitRadius;
        char.vx = 0;
        char.vy = 0;
        // Scale down smaller than dots, full opacity
        const clusterScale = (cfg.dot_scale || 0.55) * 0.7;
        char.el.style.transform = `scale(${clusterScale})`;
        char.el.style.transformOrigin = "center center";
        char.el.style.opacity = "";
        char.el.style.zIndex = "0";
        char.el.classList.add("char-clustered");
        // Render position directly
        const newLeft = Math.round(char.x);
        const newTop = Math.round(char.y);
        if (newLeft !== (char as any)._lastLeft || newTop !== (char as any)._lastTop) {
          char.el.style.left = `${newLeft}px`;
          char.el.style.top = `${newTop}px`;
          (char as any)._lastLeft = newLeft;
          (char as any)._lastTop = newTop;
        }
        continue;
      }
    } else if (!char.el.classList.contains("char-dot")) {
      char.el.classList.remove("char-clustered");
      if ((char.mode as string) !== "revolve") {
        char.el.style.transform = "";
        char.el.style.opacity = "";
        char.el.style.zIndex = "";
      }
    }

    // ─── Unified physics: pull toward target ─────────────────────────
    const dx = targetX - char.x;
    const dy = targetY - char.y;
    char.vx += dx * strength;
    char.vy += dy * strength;

    // ─── Ring exclusion: push non-dot chars outside the dot orbit ring ─
    if ((char.mode as string) !== "revolve" && dotCount > 0) {
      const toCursorX = char.x - cursor.x;
      const toCursorY = char.y - cursor.y;
      const toCursorDist = Math.sqrt(toCursorX * toCursorX + toCursorY * toCursorY);
      const ringRadius = cfg.revolve_radius + CHAR_SIZE * 0.75; // ring edge + half a full char width
      if (toCursorDist < ringRadius) {
        // Hard push: treat ring as a solid circle. Push outward proportional to penetration.
        const penetration = ringRadius - toCursorDist;
        const norm = Math.max(1, toCursorDist);
        // Strong immediate displacement — override velocity toward outside
        const pushForce = Math.min(penetration * 0.5, 8); // capped to avoid explosion
        char.vx += (toCursorX / norm) * pushForce;
        char.vy += (toCursorY / norm) * pushForce;
      }
    }

    // ─── Collision rules: ───────────────────────────────────────────
    // dots ↔ followers: yes (dots push followers away)
    // dots ↔ roamers: no (pass through)
    // followers ↔ roamers: yes
    // followers ↔ followers: yes
    // roamers ↔ roamers: yes
    // Collision (skip in battery saver — use cached value from render loop)
    if ((char.mode as string) !== "revolve" && !batterySaver) {
      for (const other of charArray) {
        if (other === char || other.el.style.display === "none") continue;
        // Skip dot-roamer collisions
        if (other.mode === "revolve" && char.mode === "roam") continue;
        // Skip collision between same-cluster members (they're intentionally close)
        if (char.clusteredTo && (other.clusteredTo === char.clusteredTo || other.session.id === char.clusteredTo)) continue;
        if (other.clusteredTo && (char.clusteredTo === other.clusteredTo || char.session.id === other.clusteredTo)) continue;
        const cdx = char.x - other.x;
        const cdy = char.y - other.y;
        const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
        const minDist = other.mode === "revolve" ? 50 : cfg.collision_distance;
        if (cdist < minDist && cdist > 0) {
          const push = ((minDist - cdist) / cdist) * 0.15;
          char.vx += cdx * push;
          char.vy += cdy * push;
        }
      }
    }

    // ─── Damping + position update ───────────────────────────────────
    const damping = char.mode === "follow" ? 0.8 : DAMPING;
    char.vx *= damping;
    char.vy *= damping;

    // Velocity clamping for roamers — prevents jank from collision spikes
    if (char.mode === "roam") {
      const maxSpeed = cfg.roam_max_speed || 3;
      const speed = Math.sqrt(char.vx * char.vx + char.vy * char.vy);
      if (speed > maxSpeed) {
        char.vx = (char.vx / speed) * maxSpeed;
        char.vy = (char.vy / speed) * maxSpeed;
      }
    }

    char.x += char.vx;
    char.y += char.vy;
    char.x = Math.max(-50, Math.min(window.innerWidth + 50, char.x));
    char.y = Math.max(-50, Math.min(window.innerHeight + 50, char.y));

    // ─── Render position (skip DOM write if unchanged) ─────────────
    const newLeft = Math.round(char.x);
    const newTop = Math.round(char.y);
    if (newLeft !== (char as any)._lastLeft || newTop !== (char as any)._lastTop) {
      char.el.style.left = `${newLeft}px`;
      char.el.style.top = `${newTop}px`;
      (char as any)._lastLeft = newLeft;
      (char as any)._lastTop = newTop;
    }
    char.el.classList.toggle("char-following", char.mode === "follow");
    char.el.classList.toggle("char-roaming", char.mode === "roam");
    const isWorking = char.session.event === "running" || char.session.event === "tool";
    char.el.classList.toggle("char-working", isWorking);
    char.el.classList.toggle("char-attention", !!char.session.attention);

    // Accelerating pulse: starts at 2.5s, speeds up to 0.6s over 5 minutes
    if (char.session.attention && char.session.attention_since) {
      const waitingSec = (Date.now() / 1000) - char.session.attention_since;
      const speed = Math.max(0.6, 2.5 - (waitingSec / 300) * 1.9); // 0s→2.5s, 300s→0.6s
      char.el.style.setProperty("--pulse-speed", `${speed.toFixed(2)}s`);
    }

    applyCharAnim(char, char.mode === "follow" && char.session.attention ? "alert" : char.mode === "follow" ? "idle" : "walk");
    applyFacing(char);
    // Eye tracking only for followers (others too far/small to notice)
    if (char.mode === "follow") trackEyes(char);
  }

  // ─── Sub-agent satellites: orbit parent chars ──────────────────────
  renderSatellites(charArray);

  // Hidden badge follows cursor — positioned above cursor so bottom edge touches it
  if (hiddenBadgeEl && hiddenBadgeEl.style.display !== "none") {
    hiddenBadgeEl.style.left = `${Math.round(cursor.x - 12)}px`;
    hiddenBadgeEl.style.top = `${Math.round(cursor.y - 24)}px`;
  }
}

// ─── Character animation + facing ──────────────────────────────────────────

function applyCharAnim(char: OverlayChar, action: import("../characters/types").CharacterAction): void {
  const slotMap: Record<string, string> = {
    alert: "char-slot-alert",
    walk: "char-slot-walk",
    idle: "char-slot-idle",
    think: "char-slot-active",
  };
  const slotForMode = slotMap[action] || "char-slot-idle";
  const svgWrap = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
  if (svgWrap && !svgWrap.classList.contains(slotForMode)) {
    svgWrap.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
    svgWrap.classList.add(slotForMode);
  }
  if (!char.el.classList.contains(slotForMode)) {
    char.el.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
    char.el.classList.add(slotForMode);
  }

  // Per-character CSS class
  const charId = char.el.dataset.char || "ghost";
  const charDef = getCharacter(charId);
  const actionDef = charDef.actions[action];
  const charActionClass = actionDef?.cssClass ?? "";
  const prevClass = char.el.dataset.charAction || "";
  if (charActionClass !== prevClass) {
    if (prevClass) char.el.classList.remove(prevClass);
    if (charActionClass) char.el.classList.add(charActionClass);
    char.el.dataset.charAction = charActionClass;
  }
}

function applyFacing(char: OverlayChar): void {
  const svgEl = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
  if (!svgEl) return;
  let flip: number;
  if (char.mode === "follow") {
    const faceDx = cursor.x - (char.x + CHAR_SIZE / 2);
    flip = faceDx < -20 ? -1 : faceDx > 20 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
  } else {
    flip = char.vx < -0.5 ? -1 : char.vx > 0.5 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
  }
  char.el.dataset.flip = String(flip);
  svgEl.style.transform = `scaleX(${flip})`;
}

// ─── Eye Tracking ───────────────────────────────────────────────────────────

const EYE_MAX_OFFSET = 2;

function trackEyes(char: OverlayChar): void {
  const eyes = char.el.querySelectorAll("svg .eye");
  if (eyes.length === 0) return;
  const cx = char.x + CHAR_SIZE / 2;
  const cy = char.y + CHAR_SIZE / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;
  const ox = (dx / dist) * EYE_MAX_OFFSET;
  const oy = (dy / dist) * EYE_MAX_OFFSET;
  const flip = char.el.dataset.flip === "-1" ? -1 : 1;
  for (const eye of eyes) {
    (eye as SVGElement).style.translate = `${ox * flip}px ${oy}px`;
  }
}

// ─── Sub-agent Satellites ────────────────────────────────────────────────────

/** Source → glow color for satellites */
function getSourceColor(source: string): string {
  if (source.includes("crew")) return "rgba(167, 139, 250, 0.7)";
  if (source.includes("cli")) return "rgba(168, 230, 207, 0.7)";
  if (source.includes("ide")) return "rgba(96, 165, 250, 0.7)";
  return "rgba(167, 139, 250, 0.5)";
}

/** Worker type → character ID mapping (from anim-agent spec 032) */
const WORKER_CHAR_MAP: Record<string, string> = {
  "cg": "wisp",
  "context-gatherer": "wisp",
  "task": "spark",
  "general-task-execution": "spark",
  "creator": "flame",
  "custom-agent-creator": "flame",
  "reviewer": "orb",
  "semantic_reviewer": "orb",
  "knowledge": "owl",
  "kirocrew-knowledge": "owl",
  "lite": "blob",
  "kirocrew-lite": "blob",
  "introspect": "crystal",
};

/** Extract worker type from name (e.g. "cg: Exploring auth" → "cg") */
function getWorkerType(name: string): string {
  const colonIdx = name.indexOf(":");
  if (colonIdx > 0) return name.slice(0, colonIdx).trim();
  return name.trim();
}

/** Satellite elements keyed by "parentId-index" */
const satellites: Map<string, HTMLElement> = new Map();
let satelliteAngle = 0;

/** Satellite size scales with main char size (≈40% of CHAR_SIZE) */
function getSatSize(): number { return Math.round(CHAR_SIZE * 0.4); }

function renderSatellites(charArray: OverlayChar[]): void {
  if (!container) return;
  satelliteAngle += 0.02; // slow orbit

  const activeSatelliteKeys = new Set<string>();

  for (const char of charArray) {
    if (char.el.style.display === "none") continue;
    if (char.mode === "hidden") continue;
    const count = (char.session as any).sub_agents || 0;
    const names: string[] = (char.session as any).workers || [];
    if (count === 0) continue;

    const orbitRadius = CHAR_SIZE * 0.6;
    for (let i = 0; i < count; i++) {
      const key = `${char.session.id}-sat-${i}`;
      activeSatelliteKeys.add(key);

      let el = satellites.get(key);
      const name = names[i] || `sub-${i + 1}`;
      const workerType = getWorkerType(name);
      const satCharId = WORKER_CHAR_MAP[workerType] || "ghost";

      if (!el) {
        el = document.createElement("div");
        el.className = "overlay-satellite";
        el.style.position = "absolute";
        el.style.pointerEvents = "none";
        el.style.width = `${getSatSize()}px`;
        el.style.height = `${getSatSize()}px`;
        container.appendChild(el);
        satellites.set(key, el);
      }

      // Position: orbit around parent
      const angle = satelliteAngle + (2 * Math.PI * i) / count;
      const satSize = getSatSize();
      const sx = char.x + CHAR_SIZE / 2 + Math.cos(angle) * orbitRadius - satSize / 2;
      const sy = char.y + CHAR_SIZE / 2 + Math.sin(angle) * orbitRadius - satSize / 2;
      el.style.left = `${Math.round(sx)}px`;
      el.style.top = `${Math.round(sy)}px`;

      // Render SVG char + description label
      const colonIdx = name.indexOf(":");
      const desc = colonIdx > 0 ? name.slice(colonIdx + 1).trim() : "";
      const contentKey = `${satCharId}:${desc}`;
      if (el.dataset.contentKey !== contentKey) {
        const charDef = getCharacter(satCharId);
        const descHtml = desc ? `<span class="sat-label">${desc.length > 14 ? desc.slice(0, 13) + "\u2026" : desc}</span>` : "";
        el.innerHTML = `${charDef.svg}${descHtml}`;
        el.dataset.contentKey = contentKey;
        el.classList.add("char-slot-idle");
        el.style.setProperty("--sat-color", getSourceColor(char.session.source));
      }
    }
  }

  // Remove satellites for sessions that no longer have sub-agents
  for (const [key, el] of satellites) {
    if (!activeSatelliteKeys.has(key)) {
      el.remove();
      satellites.delete(key);
    }
  }
}

// ─── Battery Saver Box (inline in overlay, fixed position, read-only) ────────

let bsbBoxEl: HTMLElement | null = null;
let bsbPrevHtml = "";

function renderBsbBox(charArray: OverlayChar[]): void {
  if (!container) return;

  if (!bsbBoxEl) {
    bsbBoxEl = document.createElement("div");
    bsbBoxEl.className = "bsb-box";
    container.appendChild(bsbBoxEl);
  }
  bsbBoxEl.style.display = "";

  const maxChars = cfg.bsb_max_chars ?? 5;
  const fGroup = cfg.font_size_group ?? 9;
  const fTitle = cfg.font_size_title ?? 10;
  const fAction = cfg.font_size_action ?? 10;

  // Group by state for display
  const working: OverlayChar[] = [];
  const needsYou: OverlayChar[] = [];
  const done: OverlayChar[] = [];
  const other: OverlayChar[] = [];

  for (const c of charArray) {
    const s = c.session;
    if (s.event === "approval" || s.event === "stuck" || s.attention) needsYou.push(c);
    else if (s.event === "running" || s.event === "tool") working.push(c);
    else if (s.event === "idle") done.push(c);
    else other.push(c);
  }

  // Sort each group by time (newest first)
  const byTime = (a: OverlayChar, b: OverlayChar) => {
    const aTs = a.session.last_user_ts || a.session.mtime || 0;
    const bTs = b.session.last_user_ts || b.session.mtime || 0;
    return bTs - aTs;
  };
  needsYou.sort(byTime);
  working.sort(byTime);
  done.sort(byTime);
  other.sort(byTime);

  const groups = [
    { label: "NEEDS YOU", items: needsYou },
    { label: "WORKING", items: working },
    { label: "DONE", items: done },
    { label: "OTHER", items: other },
  ].filter(g => g.items.length > 0);

  let total = 0;
  let html = "";
  for (const g of groups) {
    const shown = g.items.slice(0, Math.max(1, maxChars - total));
    if (shown.length === 0) break;
    total += shown.length;

    html += `<div class="bsb-section"><div class="bsb-section-label">${g.label}</div><div class="bsb-section-chars">`;
    for (const c of shown) {
      const s = c.session;
      const charId = s.character || "ghost";
      const charDef = getCharacter(charId);
      const group = s.group || s.source;
      const action = getActionText(s);
      html += `<div class="bsb-char" style="width:${CHAR_SIZE}px">
        <div class="bsb-group" style="font-size:${fGroup}px">${group}</div>
        <div class="bsb-title" style="font-size:${fTitle}px">${s.name}</div>
        <div class="bsb-svg" style="width:${CHAR_SIZE}px;height:${CHAR_SIZE}px">${charDef.svg}</div>
        ${action ? `<div class="bsb-action" style="font-size:${fAction}px">${action}</div>` : ""}
      </div>`;
    }
    html += `</div></div>`;

    if (total >= maxChars) break;
  }

  const overflow = charArray.length - total;
  if (overflow > 0) {
    html += `<div class="bsb-overflow">+${overflow}</div>`;
  }

  if (html !== bsbPrevHtml) {
    bsbPrevHtml = html;
    bsbBoxEl.innerHTML = html;
  }
}

function hideBsbBox(): void {
  if (bsbBoxEl) bsbBoxEl.style.display = "none";
}

// ─── BSB Window (small transparent window, Peeky-style) ─────────────────────

let bsbWindowShown = false;

async function showBsbWindow(): Promise<void> {
  if (bsbWindowShown) return;
  bsbWindowShown = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_bsb_window");
  } catch (e) {
    log("overlay", `BSB show failed: ${e}`);
    bsbWindowShown = false;
  }
}

async function hideBsbWindow(): Promise<void> {
  if (!bsbWindowShown) return;
  bsbWindowShown = false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hide_bsb_window");
  } catch {}
}

// ─── Connections ────────────────────────────────────────────────────────────

function drawConnections(svg: SVGSVGElement): void {
  svg.innerHTML = "";
  const charArray = Array.from(chars.values());

  // Group visible chars by group
  const groups = new Map<string, typeof charArray>();
  for (const c of charArray) {
    if (c.el.style.display === "none" || c.el.dataset.leaving || !c.session.group) continue;
    if (!groups.has(c.session.group)) groups.set(c.session.group, []);
    groups.get(c.session.group)!.push(c);
  }

  // For each group, draw chain connections (nearest-neighbor chain, not N×N)
  for (const [, members] of groups) {
    if (members.length < 2) continue;

    // Build minimum spanning chain: start from first, always connect to nearest unvisited
    const visited = new Set<number>();
    let current = 0;
    visited.add(0);

    for (let step = 0; step < members.length - 1; step++) {
      let nearest = -1;
      let nearestDist = Infinity;
      for (let j = 0; j < members.length; j++) {
        if (visited.has(j)) continue;
        const dx = members[current].x - members[j].x;
        const dy = members[current].y - members[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestDist) { nearestDist = d; nearest = j; }
      }
      if (nearest === -1) break;
      visited.add(nearest);

      // Draw line — connect at SVG center (accounting for text above)
      const a = members[current], b = members[nearest];
      const aHalf = CHAR_SIZE / 2;
      // For dots, position IS the center. For others, add half-size offset.
      const ax = a.mode === "revolve" ? a.x : a.x + aHalf;
      const ay = a.mode === "revolve" ? a.y : a.y + aHalf;
      const bx = b.mode === "revolve" ? b.x : b.x + aHalf;
      const by = b.mode === "revolve" ? b.y : b.y + aHalf;

      const shadow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      shadow.setAttribute("x1", String(ax)); shadow.setAttribute("y1", String(ay));
      shadow.setAttribute("x2", String(bx)); shadow.setAttribute("y2", String(by));
      shadow.setAttribute("stroke", "rgba(0,0,0,0.3)"); shadow.setAttribute("stroke-width", "2");
      shadow.setAttribute("stroke-dasharray", "6 4"); shadow.setAttribute("stroke-dashoffset", "5");
      svg.appendChild(shadow);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(ax)); line.setAttribute("y1", String(ay));
      line.setAttribute("x2", String(bx)); line.setAttribute("y2", String(by));
      line.setAttribute("stroke", "rgba(255,255,255,0.4)"); line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "6 4");
      svg.appendChild(line);

      current = nearest;
    }
  }
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function createCharElement(session: Session): HTMLElement {
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

function getToolIcon(tool: string | null, event: string | null): string {
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

function getActionText(session: Session): string {
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
    // Use action_text from hook if available (pre-formatted by data-agent)
    if ((session as any).action_text) return (session as any).action_text;
    // Fallback: agent's description ends with ? = asked something
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomRoamTarget(): { x: number; y: number } {
  return { x: 50 + Math.random() * (window.innerWidth - 100), y: 50 + Math.random() * (window.innerHeight - 100) };
}

function randomEdgePosition(): { x: number; y: number } {
  const edge = Math.floor(Math.random() * 4);
  switch (edge) {
    case 0: return { x: Math.random() * window.innerWidth, y: -CHAR_SIZE };
    case 1: return { x: window.innerWidth + CHAR_SIZE, y: Math.random() * window.innerHeight };
    case 2: return { x: Math.random() * window.innerWidth, y: window.innerHeight + CHAR_SIZE };
    case 3: return { x: -CHAR_SIZE, y: Math.random() * window.innerHeight };
    default: return { x: -CHAR_SIZE, y: window.innerHeight / 2 };
  }
}

function updateHiddenBadge(count: number): void {
  if (!hiddenBadgeEl) return;
  if (count > 0) {
    hiddenBadgeEl.textContent = `+${count}`;
    hiddenBadgeEl.style.display = "";
  } else {
    hiddenBadgeEl.style.display = "none";
  }
}

function distTo(char: OverlayChar, target: { x: number; y: number }): number {
  const dx = char.x - target.x;
  const dy = char.y - target.y;
  return Math.sqrt(dx * dx + dy * dy);
}
