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
  cursor_fps: 30,
  physics_fps: 60,
  font_size_group: 9,
  font_size_title: 10,
  font_size_action: 10,
};

const DAMPING = 0.88;
const CHAR_SIZE = 44;

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  // Load config
  try {
    const appConfig = await getConfig();
    if (appConfig.overlay) {
      cfg = appConfig.overlay;
      log("overlay", "config loaded", cfg);
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

  // Poll state
  pollState((state) => {
    if (!cursorReady) return; // Don't spawn chars until cursor position is known
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

  // Add or update
  for (const session of sessions) {
    if (!chars.has(session.id)) {
      const el = createCharElement(session);
      container.appendChild(el);

      // Spawn at random screen edge (walk in from off-screen)
      const edge = randomEdgePosition();

      // Use attention_since from backend for on-screen time tracking
      const spawnedAt = session.attention_since
        ? session.attention_since * 1000
        : Date.now();

      chars.set(session.id, {
        session,
        el,
        x: edge.x,
        y: edge.y,
        vx: 0,
        vy: 0,
        mode: eventToMode(session.event),
        roamTarget: randomRoamTarget(),
        roamTimer: 0,
        spawnedAt,
        revolveAngle: Math.random() * Math.PI * 2,
      });
      log("overlay", `added: ${session.name} (mode=${eventToMode(session.event)}, spawned at edge)`);
    } else {
      const char = chars.get(session.id)!;
      const prevEvent = char.session.event;
      char.session = session;

      // If agent resumed working (was idle/done, now running/tool) → un-dot, reset timer
      const wasIdle = prevEvent === "idle" || prevEvent === "approval" || prevEvent === "stuck";
      const nowWorking = session.event === "running" || session.event === "tool";
      if (wasIdle && nowWorking) {
        char.spawnedAt = Date.now(); // Reset on-screen timer
        char.mode = "roam";
        char.el.classList.remove("char-dot");
        char.el.style.transform = "";
        log("overlay", `${session.name}: woke from dot → roam`);
      } else {
        // Normal mode check
        const onScreenMs = Date.now() - char.spawnedAt;
        if (onScreenMs > cfg.shrink_after_min * 60 * 1000) {
          char.mode = "revolve";
        } else {
          char.mode = eventToMode(session.event);
        }
      }

      // Update labels
      const actionIcon = getToolIcon(session.tool, session.event);
      const actionText = getActionText(session);
      const actionEl = char.el.querySelector(".overlay-char-action");
      if (actionEl) actionEl.innerHTML = `${actionIcon ? `<span class="action-icon">${actionIcon}</span>` : ""}${actionText}`;
    }
  }
}

function eventToMode(event: string | null): CharMode {
  switch (event) {
    case "idle":
    case "approval":
    case "stuck":
      return "follow";
    case "running":
    case "tool":
      return "roam";
    default:
      return "follow";
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
      case "update_session_information": return "";
      case "todo_list": return "";
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
      case "todo_list":
        return "";  // Internal tools, not interesting to show
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

      // Position dot centered on cursor (account for element height: labels + SVG)
      const elemCenterX = CHAR_SIZE / 2;
      const elemCenterY = 40; // approx center of full element (group+title+SVG+action)
      char.x = smoothCursor.x + Math.cos(angle) * cfg.revolve_radius - elemCenterX;
      char.y = smoothCursor.y + Math.sin(angle) * cfg.revolve_radius - elemCenterY;

      char.el.style.left = `${Math.round(char.x)}px`;
      char.el.style.top = `${Math.round(char.y)}px`;
      char.el.classList.add("char-dot");
      char.el.style.transform = `scale(${cfg.dot_scale || 0.5})`;
      char.el.classList.remove("char-following", "char-roaming");
      // Dots don't participate in collision — skip physics below
      continue;
    }

    // ─── Normal mode: follow or roam ─────────────────────────────────
    char.el.classList.remove("char-dot");

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

    // Apply character-specific animation slot based on mode
    const slotForMode = char.mode === "follow" ? "char-slot-alert" : "char-slot-idle";
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

    // Face toward cursor (follow) or movement direction (roam)
    if (char.mode === "follow") {
      const dx = cursor.x - (char.x + CHAR_SIZE / 2);
      const tilt = Math.max(-8, Math.min(8, dx * 0.03));
      const flip = dx < -20 ? -1 : dx > 20 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
      char.el.dataset.flip = String(flip);
      char.el.style.transform = `scaleX(${flip}) rotate(${tilt}deg)`;
    } else {
      const flip = char.vx < -0.5 ? -1 : char.vx > 0.5 ? 1 : (char.el.dataset.flip === "-1" ? -1 : 1);
      char.el.dataset.flip = String(flip);
      char.el.style.transform = `scaleX(${flip})`;
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
