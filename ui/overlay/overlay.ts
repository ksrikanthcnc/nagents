/**
 * Overlay — transparent fullscreen window with cursor-following characters.
 *
 * Lifecycle:
 *   Stop/approval/stuck → char appears, FOLLOWS cursor
 *   UserPromptSubmit    → char stays, ROAMS freely
 *   After SHRINK_AFTER_MS on screen → shrinks to dot, REVOLVES around cursor
 *   Scanner GC removes session → char removed
 */

import type { Session, CursorPosition, OverlayConfig } from "../shared/types";
import { pollState, getConfig, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

type CharMode = "follow" | "roam" | "revolve";

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
  /** When this char first appeared on overlay (Date.now()) */
  spawnedAt: number;
  /** Angle for revolve mode (radians) */
  revolveAngle: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let cursor: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
/** Smoothed cursor — interpolated each physics frame for smooth movement at low cursor_fps */
let smoothCursor: CursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const chars: Map<string, OverlayChar> = new Map();
let container: HTMLElement | null = null;
let animFrameId: number | null = null;
/** Global revolve angle — shared by all dots for perfect equidistance */
let globalRevolveAngle = 0;
/** Have we received at least one cursor position from backend? */
let cursorReady = false;
/** Last time we printed the summary log */
let lastSummaryLog = 0;
/** Hidden count badge element */
let hiddenBadgeEl: HTMLElement | null = null;

// ─── Config (loaded from backend, with defaults) ────────────────────────────

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
  dot_scale: 0.5,
  cursor_fps: 10,
  physics_fps: 60,
  font_size_group: 9,
  font_size_title: 10,
  font_size_action: 10,
  max_followers: 3,
  max_dots: 4,
  max_roamers: 5,
  pin_counts_toward_max: false,
  group_as_one: false,
  source_as_group: false,
  follower_mode: "priority,fifo",
};

const DAMPING = 0.88;
const CHAR_SIZE = 44;

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  // Create hidden count badge (shows how many chars are off-screen)
  hiddenBadgeEl = document.createElement("div");
  hiddenBadgeEl.className = "overlay-hidden-badge";
  hiddenBadgeEl.style.display = "none";
  el.appendChild(hiddenBadgeEl);

  // Load config
  try {
    const appConfig = await getConfig();
    if (appConfig.overlay) {
      cfg = appConfig.overlay;
      log("overlay", `config loaded: shrink_after_min=${cfg.shrink_after_min}, dot_scale=${cfg.dot_scale}, collision=${cfg.collision_distance}`);
    }
  } catch {
    log("overlay", "config load failed, using defaults");
  }

  // Poll cursor position (configurable fps)
  const cursorInterval = Math.round(1000 / cfg.cursor_fps);
  const pollCursor = async () => {
    while (true) {
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          cursor = await resp.json();
          cursorReady = true;
        }
      } catch {
        // server not ready
      }
      await new Promise((r) => setTimeout(r, cursorInterval));
    }
  };
  pollCursor();
  log("overlay", `cursor polling started (${cfg.cursor_fps}fps)`);

  // Poll state + re-read config periodically
  let configPollCount = 0;
  pollState(async (state) => {
    if (!cursorReady) return;
    // Re-read config every 30 polls (~30s)
    configPollCount++;
    if (configPollCount % 30 === 0) {
      try {
        const fresh = await getConfig();
        if (fresh.overlay) {
          cfg = fresh.overlay;
          console.log(`[config] re-read: shrink_after_min=${cfg.shrink_after_min}`);
        }
      } catch {}
    }
    const showSessions = state.sessions.filter((s) => s.attention);
    syncChars(showSessions);
  }, 1000);

  startRenderLoop();
  log("overlay", "render loop started");
}

// ─── Sync chars with backend state ──────────────────────────────────────────

function syncChars(sessions: Session[]): void {
  if (!container) return;

  const activeIds = new Set(sessions.map((s) => s.id));

  // Remove chars no longer on overlay
  for (const [id, char] of chars) {
    if (!activeIds.has(id)) {
      log("overlay", `removing: ${char.session.name}`);
      char.el.remove();
      chars.delete(id);
    }
  }

  // Add new chars
  for (const session of sessions) {
    if (!chars.has(session.id)) {
      const el = createCharElement(session);
      container.appendChild(el);
      const edge = randomEdgePosition();
      chars.set(session.id, {
        session,
        el,
        x: edge.x,
        y: edge.y,
        vx: 0,
        vy: 0,
        mode: "roam",
        roamTarget: randomRoamTarget(),
        roamTimer: 0,
        spawnedAt: Date.now(),
        revolveAngle: Math.random() * Math.PI * 2,
      });
      log("overlay", `added: ${session.name} (spawned at edge)`);
    } else {
      // Update session data
      const char = chars.get(session.id)!;
      const prevEvent = char.session.event;
      char.session = session;

      // On event change, reset dot state so assignModes() can reassign cleanly.
      const eventChanged = prevEvent !== session.event;
      if (char.mode === "revolve" && eventChanged) {
        setMode(char, "roam"); // assignModes() will put it in the right place
        log("overlay", `${session.name}: event changed (${prevEvent}→${session.event}), reassigning`);
      }

      // Update labels
      const actionIcon = getToolIcon(session.tool, session.event);
      const actionText = getActionText(session);
      const actionEl = char.el.querySelector(".overlay-char-action");
      if (actionEl) actionEl.innerHTML = `${actionIcon ? `<span class="action-icon">${actionIcon}</span>` : ""}${actionText}`;
    }
  }

  // ─── Mode Assignment ───────────────────────────────────────────────
  assignModes();
}

/**
 * Assign overlay modes — clean waterfall.
 *
 * Goal: help user finish off sessions. Latest idle sessions get priority visibility.
 *
 * Waterfall (chars flow down, limited slots per tier):
 *   1. PINNED  → always follow (user-marked, exempt from all limits)
 *   2. FOLLOW  → approval/stuck first, then idle fills remaining slots (sorted by follower_mode)
 *   3. ROAM    → everything else with attention (working + overflow)
 *   4. DOT     → excess roamers (max_roamers) + stale (shrink_after_min, no attention)
 *   5. HIDDEN  → excess dots (max_dots)
 *
 * Key: idle CAN follow if slots are available (LIFO = newest idle first).
 */
function assignModes(): void {
  const allChars = Array.from(chars.values());

  // ─── Step 1: Separate pinned from normal ──────────────────────────
  const pinned: OverlayChar[] = [];
  const normal: OverlayChar[] = [];
  for (const char of allChars) {
    if (char.session.pinned) {
      pinned.push(char);
    } else {
      normal.push(char);
    }
  }

  // Pinned → always follow
  for (const char of pinned) {
    setMode(char, "follow");
  }

  // ─── Step 2: Determine who WANTS to follow ────────────────────────
  const followSlots = cfg.pin_counts_toward_max
    ? Math.max(0, cfg.max_followers - pinned.length)
    : cfg.max_followers;

  // Candidates: anyone with attention + idle/approval/stuck
  const candidates: OverlayChar[] = [];
  const workers: OverlayChar[] = []; // running/tool — always roam

  for (const char of normal) {
    const event = char.session.event;
    const attention = char.session.attention;

    if (!attention) continue; // No attention = will be handled as stale below

    if (event === "approval" || event === "stuck") {
      candidates.push(char); // High priority — blocked
    } else if (event === "idle") {
      candidates.push(char); // Can follow if slots available
    } else {
      workers.push(char); // running/tool → roam
    }
  }

  // Sort candidates by follower_mode (e.g. "priority,lifo")
  sortFollowers(candidates);

  // ─── Step 3: Assign follow/roam ───────────────────────────────────
  const roamers: OverlayChar[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (i < followSlots) {
      setMode(candidates[i], "follow");
    } else {
      setMode(candidates[i], "roam");
      roamers.push(candidates[i]);
    }
  }

  // Workers → roam
  for (const char of workers) {
    setMode(char, "roam");
    roamers.push(char);
  }

  // ─── Step 4: Stale chars (no attention) ───────────────────────────
  // Chars without attention that are still on overlay (not yet GC'd by syncChars)
  // They're already dotted or should become dots
  const stale = normal.filter(c =>
    !c.session.attention &&
    !candidates.includes(c) &&
    !workers.includes(c)
  );
  for (const char of stale) {
    setMode(char, "revolve");
  }

  // ─── Step 5: Count-based dotting (max_roamers) ────────────────────
  const maxRoamers = cfg.max_roamers ?? 999;
  const allRoaming = normal.filter(c => c.mode === "roam");
  if (allRoaming.length > maxRoamers) {
    allRoaming.sort((a, b) => a.spawnedAt - b.spawnedAt); // oldest roam first
    for (let i = 0; i < allRoaming.length - maxRoamers; i++) {
      setMode(allRoaming[i], "revolve");
    }
  }

  // ─── Step 6: Time-based dotting (shrink_after_min) ────────────────
  // Only non-attention roamers. Active sessions stay visible.
  if (cfg.shrink_after_min > 0) {
    const threshold = cfg.shrink_after_min * 60 * 1000;
    const now = Date.now();
    for (const char of normal.filter(c => c.mode === "roam" && !c.session.attention)) {
      if (now - char.spawnedAt > threshold) {
        setMode(char, "revolve");
      }
    }
  }

  // ─── Step 7: Cap dots → hidden ────────────────────────────────────
  const dots = allChars.filter(c => c.mode === "revolve");
  dots.sort((a, b) => a.spawnedAt - b.spawnedAt); // oldest hidden first

  let hiddenCount = 0;
  for (let i = 0; i < dots.length; i++) {
    if (i < dots.length - cfg.max_dots) {
      dots[i].el.style.display = "none";
      hiddenCount++;
    } else {
      dots[i].el.style.display = "";
    }
  }
  updateHiddenBadge(hiddenCount);
}

/** Set a char's mode, handling all DOM cleanup for transitions. */
function setMode(char: OverlayChar, newMode: CharMode): void {
  const prev = char.mode;
  if (prev === newMode) return;

  // Leaving dot mode → clean up dot DOM state
  if (prev === "revolve") {
    char.el.classList.remove("char-dot");
    char.el.style.transform = "";
    char.el.style.transformOrigin = "";
    char.el.style.display = "";
  }

  // Entering roam → reset timer (fresh countdown before dotting)
  if (newMode === "roam" && prev !== "roam") {
    char.spawnedAt = Date.now();
  }

  char.mode = newMode;
  log("overlay", `${char.session.name}: ${prev} → ${newMode}`);
}

/**
 * Sort followers based on configured follower_mode.
 * Supports chained modes: "priority,fifo" = sort by urgency, break ties with newest-first.
 *
 * Available criteria:
 *   fifo     — newest attention first
 *   lifo     — oldest attention first (fairness)
 *   lru      — least recently interacted first (oldest mtime)
 *   priority — by event urgency: approval > stuck > idle
 */
function sortFollowers(list: OverlayChar[]): void {
  const modeStr = cfg.follower_mode || "priority,fifo";
  const modes = modeStr.split(",").map(s => s.trim());

  list.sort((a, b) => {
    for (const mode of modes) {
      const diff = compareByMode(a, b, mode);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

/** Compare two chars by a single sort criterion. Returns <0, 0, or >0. */
function compareByMode(a: OverlayChar, b: OverlayChar, mode: string): number {
  switch (mode) {
    case "fifo": {
      // First In First Out: oldest attention gets priority (waited longest → served first)
      const aTime = a.session.attention_since ?? a.spawnedAt;
      const bTime = b.session.attention_since ?? b.spawnedAt;
      return aTime - bTime; // oldest first
    }
    case "lifo": {
      // Last In First Out: newest attention gets priority (latest task = most relevant)
      const aTime = a.session.attention_since ?? a.spawnedAt;
      const bTime = b.session.attention_since ?? b.spawnedAt;
      return bTime - aTime; // newest first
    }
    case "lru":
      // Least recently used: oldest mtime first (neglected sessions prioritized)
      return a.session.mtime - b.session.mtime;
    case "priority": {
      const urgency = (event: string | null): number => {
        switch (event) {
          case "approval": return 3;
          case "stuck": return 2;
          case "idle": return 1;
          default: return 0;
        }
      };
      return urgency(b.session.event) - urgency(a.session.event);
    }
    default:
      return 0;
  }
}

// ─── DOM ────────────────────────────────────────────────────────────────────

function createCharElement(session: Session): HTMLElement {
  // Use localStorage override (same as panel) or session.character or default
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
  const actionIcon = getToolIcon(session.tool, session.event);
  const actionText = getActionText(session);

  el.innerHTML = `
    <div class="overlay-char-group" style="font-size:${cfg.font_size_group}px">${groupLabel}</div>
    <div class="overlay-char-title" style="font-size:${cfg.font_size_title}px">${session.name}</div>
    <div class="overlay-char-svg char-slot-idle" data-char="${charId}">${charDef.svg}</div>
    <div class="overlay-char-action" style="font-size:${cfg.font_size_action}px">${actionIcon ? `<span class="action-icon">${actionIcon}</span>` : ""}${actionText}</div>
  `;
  el.style.position = "absolute";
  el.style.width = `${CHAR_SIZE}px`;
  el.style.pointerEvents = "none";
  return el;
}

/** Map tool/event to a small icon + display text. */
function getToolIcon(tool: string | null, event: string | null): string {
  if (tool) {
    switch (tool) {
      case "fs_write": return "✏️";
      case "str_replace": return "✏️";
      case "read_file": return "📖";
      case "read_files": return "📖";
      case "read_code": return "📖";
      case "execute_bash": return "⚡";
      case "grep_search": return "🔍";
      case "file_search": return "🔍";
      case "list_directory": return "📂";
      case "web_fetch": return "🌐";
      case "remote_web_search": return "🌐";
      case "invoke_sub_agent": return "🤖";
      case "update_session_information": return "📋";
      case "todo_list": return "☑️";
      default: return "🔧";
    }
  }
  if (event) {
    switch (event) {
      case "idle": return "❓";
      case "running": return "⚙️";
      case "approval": return "⏳";
      case "stuck": return "🚨";
      case "tool": return "🔧";
      default: return "";
    }
  }
  return "";
}

/** Get display text for the action line (meaningful info, not raw tool name). */
function getActionText(session: Session): string {
  if (session.tool) {
    // Show file for read/write, or short tool description
    switch (session.tool) {
      case "read_file":
      case "read_files":
      case "read_code":
        return session.file ? basename(session.file) : "reading";
      case "fs_write":
      case "str_replace":
        return session.file ? basename(session.file) : "writing";
      case "execute_bash":
        return session.file ? session.file.slice(0, 25) : "bash";
      case "grep_search":
      case "file_search":
        return "searching";
      case "list_directory":
        return session.file ? basename(session.file) : "listing";
      case "invoke_sub_agent":
        return "sub-agent";
      case "update_session_information":
        return "status";
      case "todo_list":
        return "todo";
      default:
        return session.tool.length > 15 ? session.tool.slice(0, 14) + "…" : session.tool;
    }
  }
  return session.event || "";
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

// ─── Render Loop ────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;";
  container!.appendChild(svg);

  const frameInterval = 1000 / cfg.physics_fps;
  let lastFrame = 0;

  function tick(now: number) {
    animFrameId = requestAnimationFrame(tick);
    if (now - lastFrame < frameInterval) return;
    lastFrame = now;
    updatePhysics();
    drawConnections(svg);
  }
  animFrameId = requestAnimationFrame(tick);
}

function drawConnections(svg: SVGSVGElement): void {
  svg.innerHTML = "";
  const charArray = Array.from(chars.values());
  const drawn = new Set<string>();

  for (const a of charArray) {
    for (const b of charArray) {
      if (a === b) continue;
      if (a.session.group !== b.session.group || !a.session.group) continue;
      const key = [a.session.id, b.session.id].sort().join("-");
      if (drawn.has(key)) continue;
      drawn.add(key);

      // From center of char
      const ax = a.x + CHAR_SIZE / 2;
      const ay = a.y + CHAR_SIZE / 2;
      const bx = b.x + CHAR_SIZE / 2;
      const by = b.y + CHAR_SIZE / 2;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(ax));
      line.setAttribute("y1", String(ay));
      line.setAttribute("x2", String(bx));
      line.setAttribute("y2", String(by));
      // Alternating black-white dash for visibility on any background
      line.setAttribute("stroke", "rgba(255, 255, 255, 0.5)");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", "6 4");
      svg.appendChild(line);

      // Shadow line underneath for contrast
      const shadow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      shadow.setAttribute("x1", String(ax));
      shadow.setAttribute("y1", String(ay));
      shadow.setAttribute("x2", String(bx));
      shadow.setAttribute("y2", String(by));
      shadow.setAttribute("stroke", "rgba(0, 0, 0, 0.4)");
      shadow.setAttribute("stroke-width", "2.5");
      shadow.setAttribute("stroke-dasharray", "6 4");
      shadow.setAttribute("stroke-dashoffset", "5");
      svg.insertBefore(shadow, svg.firstChild);
    }
  }
}

function updatePhysics(): void {
  const charArray = Array.from(chars.values());

  // Periodic summary log (every 10 seconds)
  const now = Date.now();
  if (now - lastSummaryLog > 10000 && charArray.length > 0) {
    lastSummaryLog = now;
    const following = charArray.filter(c => c.mode === "follow");
    const roaming = charArray.filter(c => c.mode === "roam");
    const dots = charArray.filter(c => c.mode === "revolve");
    const hidden = charArray.filter(c => c.el.style.display === "none");
    const working = charArray.filter(c => c.el.classList.contains("char-working"));
    log("overlay", `[summary] total=${charArray.length} follow=${following.length}/${cfg.max_followers} roam=${roaming.length} dot=${dots.length}/${cfg.max_dots} hidden=${hidden.length} working=${working.length}`);
    if (following.length > 0) {
      log("overlay", `  followers: ${following.map(c => c.session.name).join(", ")}`);
    }
    if (dots.length > 0) {
      log("overlay", `  dots: ${dots.map(c => c.session.name).join(", ")}`);
    }
  }

  // Smoothly interpolate cursor for smooth dot movement at low cursor_fps
  smoothCursor.x += (cursor.x - smoothCursor.x) * 0.2;
  smoothCursor.y += (cursor.y - smoothCursor.y) * 0.2;

  // Count dots for equidistant revolve positioning
  const dotChars = charArray.filter((c) => c.mode === "revolve");
  const dotCount = dotChars.length;
  globalRevolveAngle += cfg.revolve_speed;

  for (const char of charArray) {
    // ─── Revolve mode: dot orbits cursor at equidistant positions ─────
    if (char.mode === "revolve") {
      // Each dot gets an equal slice of the circle
      const dotIndex = dotChars.indexOf(char);
      const angle = globalRevolveAngle + (2 * Math.PI * dotIndex) / Math.max(1, dotCount);

      // Position dot centered on cursor
      // Scaled element: visual center is at (width*scale/2, height*scale/2) from top-left
      // But we position by top-left, so offset by half the VISUAL size
      const dotVisualHalf = CHAR_SIZE * (cfg.dot_scale || 0.5) / 2;
      char.x = smoothCursor.x + Math.cos(angle) * cfg.revolve_radius - dotVisualHalf;
      char.y = smoothCursor.y + Math.sin(angle) * cfg.revolve_radius - dotVisualHalf;

      char.el.style.left = `${Math.round(char.x)}px`;
      char.el.style.top = `${Math.round(char.y)}px`;
      char.el.classList.add("char-dot");
      char.el.style.transform = `scale(${cfg.dot_scale || 0.5})`;
      char.el.style.transformOrigin = "center center";
      char.el.classList.remove("char-following", "char-roaming");
      // Dots don't participate in collision — skip physics below
      continue;
    }

    // ─── Normal mode: follow or roam ─────────────────────────────────
    char.el.classList.remove("char-dot");
    char.el.style.transform = ""; // Clear dot scale if was previously dot

    let targetX: number;
    let targetY: number;
    let strength: number;
    let maxSpeed: number;

    if (char.mode === "follow") {
      targetX = smoothCursor.x;
      targetY = smoothCursor.y;
      strength = cfg.follow_strength;
      maxSpeed = cfg.follow_max_speed;
    } else {
      char.roamTimer++;
      if (char.roamTimer > 240 || distTo(char, char.roamTarget) < 30) {
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      targetX = char.roamTarget.x;
      targetY = char.roamTarget.y;
      strength = cfg.roam_strength;
      maxSpeed = cfg.roam_max_speed;
    }

    const dx = targetX - char.x;
    const dy = targetY - char.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (char.mode === "follow") {
      if (dist > cfg.min_cursor_distance) {
        char.vx += dx * strength;
        char.vy += dy * strength;
      } else if (dist < cfg.min_cursor_distance * 0.4) {
        char.vx -= dx * 0.03;
        char.vy -= dy * 0.03;
      }
    } else {
      if (dist > 20) {
        char.vx += dx * strength;
        char.vy += dy * strength;
      }
    }

    // Collision avoidance — all non-dot chars collide with each other
    for (const other of charArray) {
      if (other === char || other.mode === "revolve") continue;
      const cdx = char.x - other.x;
      const cdy = char.y - other.y;
      const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      if (cdist < cfg.collision_distance && cdist > 0) {
        const push = ((cfg.collision_distance - cdist) / cdist) * 0.15;
        char.vx += cdx * push;
        char.vy += cdy * push;
      }
    }

    // Damping + speed limit
    char.vx *= DAMPING;
    char.vy *= DAMPING;
    const speed = Math.sqrt(char.vx * char.vx + char.vy * char.vy);
    if (speed > maxSpeed) {
      char.vx = (char.vx / speed) * maxSpeed;
      char.vy = (char.vy / speed) * maxSpeed;
    }

    char.x += char.vx;
    char.y += char.vy;

    // Keep on screen
    char.x = Math.max(10, Math.min(window.innerWidth - CHAR_SIZE - 10, char.x));
    char.y = Math.max(10, Math.min(window.innerHeight - CHAR_SIZE - 10, char.y));

    // Render
    char.el.style.left = `${Math.round(char.x)}px`;
    char.el.style.top = `${Math.round(char.y)}px`;
    char.el.classList.toggle("char-following", char.mode === "follow");
    char.el.classList.toggle("char-roaming", char.mode === "roam");
    // Workers (running/tool) get a visual distinction — lower opacity via CSS
    const isWorking = char.session.event === "running" || char.session.event === "tool";
    char.el.classList.toggle("char-working", char.mode === "roam" && isWorking);

    // Apply character-specific animation slot based on mode
    const actionForMode: import("../characters/types").CharacterAction = char.mode === "follow" ? "alert" : "walk";
    const slotForMode = char.mode === "follow" ? "char-slot-alert" : "char-slot-walk";
    const svgWrap = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
    if (svgWrap && !svgWrap.classList.contains(slotForMode)) {
      svgWrap.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
      svgWrap.classList.add(slotForMode);
    }
    // Keep outer element in sync for CSS that targets it
    if (!char.el.classList.contains(slotForMode)) {
      char.el.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
      char.el.classList.add(slotForMode);
    }

    // Apply per-character action CSS class (ghost wavy walk, flame flicker, etc.)
    const charId = char.el.dataset.char || "ghost";
    const charDef = getCharacter(charId);
    const actionDef = charDef.actions[actionForMode];
    const charActionClass = actionDef?.cssClass ?? "";
    const prevCharAction = char.el.dataset.charAction || "";
    if (charActionClass !== prevCharAction) {
      if (prevCharAction) char.el.classList.remove(prevCharAction);
      if (charActionClass) char.el.classList.add(charActionClass);
      char.el.dataset.charAction = charActionClass;
    }

    // Face toward cursor (follow) or movement direction (roam)
    // ONLY flip the SVG, not the text labels
    const svgEl = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
    if (char.mode === "follow") {
      const faceDx = cursor.x - (char.x + CHAR_SIZE / 2);
      const flip = faceDx < -20 ? -1 : faceDx > 20 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
      char.el.dataset.flip = String(flip);
      if (svgEl) svgEl.style.transform = `scaleX(${flip})`;
    } else {
      const flip = char.vx < -0.5 ? -1 : char.vx > 0.5 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
      char.el.dataset.flip = String(flip);
      if (svgEl) svgEl.style.transform = `scaleX(${flip})`;
    }

    // Eye tracking — eyes shift toward cursor
    trackEyes(char);
  }
}

// ─── Eye Tracking ───────────────────────────────────────────────────────────

const EYE_MAX_OFFSET = 2; // px — subtle shift, not cartoon-huge

function trackEyes(char: OverlayChar): void {
  const eyes = char.el.querySelectorAll("svg .eye");
  if (eyes.length === 0) return;

  // Compute direction from char center to cursor
  const cx = char.x + CHAR_SIZE / 2;
  const cy = char.y + CHAR_SIZE / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;

  // Normalize and scale
  const ox = (dx / dist) * EYE_MAX_OFFSET;
  const oy = (dy / dist) * EYE_MAX_OFFSET;

  // Account for flip (scaleX(-1) reverses x)
  const flip = char.el.dataset.flip === "-1" ? -1 : 1;

  for (const eye of eyes) {
    (eye as SVGElement).style.translate = `${ox * flip}px ${oy}px`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomRoamTarget(): { x: number; y: number } {
  return {
    x: 50 + Math.random() * (window.innerWidth - 100),
    y: 50 + Math.random() * (window.innerHeight - 100),
  };
}

/** Show/hide the hidden count badge near cursor. */
function updateHiddenBadge(count: number): void {
  if (!hiddenBadgeEl) return;
  if (count > 0) {
    hiddenBadgeEl.textContent = `+${count} hidden`;
    hiddenBadgeEl.style.display = "";
    // Position near bottom-right of screen (fixed, unobtrusive)
    hiddenBadgeEl.style.left = `${window.innerWidth - 100}px`;
    hiddenBadgeEl.style.top = `${window.innerHeight - 30}px`;
  } else {
    hiddenBadgeEl.style.display = "none";
  }
}

/** Pick a random position along a screen edge (for walk-in spawn). */
function randomEdgePosition(): { x: number; y: number } {
  const edge = Math.floor(Math.random() * 4);
  switch (edge) {
    case 0: // top
      return { x: Math.random() * window.innerWidth, y: -CHAR_SIZE };
    case 1: // right
      return { x: window.innerWidth + CHAR_SIZE, y: Math.random() * window.innerHeight };
    case 2: // bottom
      return { x: Math.random() * window.innerWidth, y: window.innerHeight + CHAR_SIZE };
    case 3: // left
      return { x: -CHAR_SIZE, y: Math.random() * window.innerHeight };
    default:
      return { x: -CHAR_SIZE, y: window.innerHeight / 2 };
  }
}

function distTo(char: OverlayChar, target: { x: number; y: number }): number {
  const dx = char.x - target.x;
  const dy = char.y - target.y;
  return Math.sqrt(dx * dx + dy * dy);
}
