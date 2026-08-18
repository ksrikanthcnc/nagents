/**
 * Overlay — transparent fullscreen window with cursor-following characters.
 *
 * Lifecycle:
 *   Stop/approval/stuck → char appears, FOLLOWS cursor
 *   UserPromptSubmit    → char stays, ROAMS freely
 *   After SHRINK_AFTER_MS on screen → shrinks to dot, REVOLVES around cursor
 *   Scanner GC removes session → char removed
 */

import type { Session, CursorPosition } from "../shared/types";
import { pollState, log } from "../shared/bridge";
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
const chars: Map<string, OverlayChar> = new Map();
let container: HTMLElement | null = null;
let animFrameId: number | null = null;

// ─── Config ─────────────────────────────────────────────────────────────────

const FOLLOW_STRENGTH = 0.04;
const ROAM_STRENGTH = 0.015;
const DAMPING = 0.88;
const MIN_CURSOR_DIST = 80;
const MAX_SPEED = 6;
const COLLISION_DIST = 55;
const CHAR_SIZE = 44;
const DOT_SIZE = 12;
const REVOLVE_RADIUS = 50;
const REVOLVE_SPEED = 0.015; // radians per frame
/** After this many ms on screen, char shrinks to dot and revolves */
const SHRINK_AFTER_MS = 15 * 60 * 1000; // 15 minutes

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  // Poll cursor position (~30fps)
  const pollCursor = async () => {
    while (true) {
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          cursor = await resp.json();
        }
      } catch {
        // server not ready
      }
      await new Promise((r) => setTimeout(r, 33));
    }
  };
  pollCursor();
  log("overlay", "cursor polling started");

  // Poll state
  pollState((state) => {
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
      const offsetX = (Math.random() - 0.5) * 150;
      const offsetY = (Math.random() - 0.5) * 150;

      // Use attention_since from backend (epoch seconds) for on-screen time tracking
      // This survives app restarts (hibernate/resume)
      const spawnedAt = session.attention_since
        ? session.attention_since * 1000  // epoch seconds → ms
        : Date.now();

      chars.set(session.id, {
        session,
        el,
        x: cursor.x + offsetX,
        y: cursor.y + offsetY,
        vx: 0,
        vy: 0,
        mode: eventToMode(session.event),
        roamTarget: randomRoamTarget(),
        roamTimer: 0,
        spawnedAt,
        revolveAngle: Math.random() * Math.PI * 2,
      });
      log("overlay", `added: ${session.name} (mode=${eventToMode(session.event)}, on-screen ${Math.round((Date.now() - spawnedAt) / 1000)}s)`);
    } else {
      const char = chars.get(session.id)!;
      char.session = session;

      // Check if should shrink to dot (on screen > SHRINK_AFTER_MS)
      const onScreenMs = Date.now() - char.spawnedAt;
      if (onScreenMs > SHRINK_AFTER_MS) {
        char.mode = "revolve";
      } else {
        char.mode = eventToMode(session.event);
      }

      // Update label
      const eventLabel = session.event ? ` · ${session.event}` : "";
      const labelEl = char.el.querySelector(".overlay-char-label");
      if (labelEl) labelEl.textContent = `${session.name}${eventLabel}`;
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
  const charDef = getCharacter(session.character ?? "ghost");

  const el = document.createElement("div");
  el.className = "overlay-char";
  el.dataset.sessionId = session.id;
  el.dataset.group = session.group;

  const groupLabel = session.group || session.source;
  const eventLabel = session.event ? ` · ${session.event}` : "";

  el.innerHTML = `
    <div class="overlay-char-source">${groupLabel}</div>
    <div class="overlay-char-svg">${charDef.svg}</div>
    <div class="overlay-char-label">${session.name}${eventLabel}</div>
  `;
  el.style.position = "absolute";
  el.style.width = `${CHAR_SIZE}px`;
  el.style.height = `${CHAR_SIZE}px`;
  el.style.pointerEvents = "none";
  return el;
}

// ─── Render Loop ────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;";
  container!.appendChild(svg);

  function tick() {
    updatePhysics();
    drawConnections(svg);
    animFrameId = requestAnimationFrame(tick);
  }
  tick();
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

      const halfSize = CHAR_SIZE / 2;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x + halfSize));
      line.setAttribute("y1", String(a.y + halfSize));
      line.setAttribute("x2", String(b.x + halfSize));
      line.setAttribute("y2", String(b.y + halfSize));
      line.setAttribute("stroke", "rgba(167, 139, 250, 0.25)");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);
    }
  }
}

function updatePhysics(): void {
  const charArray = Array.from(chars.values());

  for (const char of charArray) {
    // ─── Revolve mode: dot orbits cursor ─────────────────────────────
    if (char.mode === "revolve") {
      char.revolveAngle += REVOLVE_SPEED;
      char.x = cursor.x + Math.cos(char.revolveAngle) * REVOLVE_RADIUS - DOT_SIZE / 2;
      char.y = cursor.y + Math.sin(char.revolveAngle) * REVOLVE_RADIUS - DOT_SIZE / 2;

      // Shrink element
      char.el.style.left = `${Math.round(char.x)}px`;
      char.el.style.top = `${Math.round(char.y)}px`;
      char.el.classList.add("char-dot");
      char.el.classList.remove("char-following", "char-roaming");
      continue;
    }

    // ─── Normal mode: follow or roam ─────────────────────────────────
    char.el.classList.remove("char-dot");

    let targetX: number;
    let targetY: number;
    let strength: number;

    if (char.mode === "follow") {
      targetX = cursor.x;
      targetY = cursor.y;
      strength = FOLLOW_STRENGTH;
    } else {
      char.roamTimer++;
      if (char.roamTimer > 180 || distTo(char, char.roamTarget) < 30) {
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      targetX = char.roamTarget.x;
      targetY = char.roamTarget.y;
      strength = ROAM_STRENGTH;
    }

    const dx = targetX - char.x;
    const dy = targetY - char.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (char.mode === "follow") {
      if (dist > MIN_CURSOR_DIST) {
        char.vx += dx * strength;
        char.vy += dy * strength;
      } else if (dist < MIN_CURSOR_DIST * 0.4) {
        char.vx -= dx * 0.03;
        char.vy -= dy * 0.03;
      }
    } else {
      if (dist > 20) {
        char.vx += dx * strength;
        char.vy += dy * strength;
      }
    }

    // Collision avoidance
    for (const other of charArray) {
      if (other === char) continue;
      const cdx = char.x - other.x;
      const cdy = char.y - other.y;
      const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      if (cdist < COLLISION_DIST && cdist > 0) {
        const push = ((COLLISION_DIST - cdist) / cdist) * 0.08;
        char.vx += cdx * push;
        char.vy += cdy * push;
      }
    }

    // Damping + speed limit
    char.vx *= DAMPING;
    char.vy *= DAMPING;
    const speed = Math.sqrt(char.vx * char.vx + char.vy * char.vy);
    if (speed > MAX_SPEED) {
      char.vx = (char.vx / speed) * MAX_SPEED;
      char.vy = (char.vy / speed) * MAX_SPEED;
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
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomRoamTarget(): { x: number; y: number } {
  return {
    x: 50 + Math.random() * (window.innerWidth - 100),
    y: 50 + Math.random() * (window.innerHeight - 100),
  };
}

function distTo(char: OverlayChar, target: { x: number; y: number }): number {
  const dx = char.x - target.x;
  const dy = char.y - target.y;
  return Math.sqrt(dx * dx + dy * dy);
}
