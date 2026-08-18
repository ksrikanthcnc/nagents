/**
 * Overlay — transparent fullscreen window with cursor-following characters.
 *
 * Simple logic driven directly by hook events:
 *   - event="idle" (Stop) → char appears, FOLLOWS cursor (done, needs you)
 *   - event="approval" (stuck tool) → char appears, FOLLOWS cursor
 *   - event="running" → char appears, ROAMS freely (doesn't follow)
 *   - event="tool" → char appears, ROAMS (working)
 *   - UserPromptSubmit clears attention → char disappears
 *
 * No complex attention rules here — the backend decides who has attention,
 * this module just renders and animates.
 */

import type { Session, CursorPosition } from "../shared/types";
import { pollState, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

type CharMode = "follow" | "roam";

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

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  // Debug: show status on screen
  const dbg = document.getElementById("debug-dot");

  // Use HTTP polling for cursor (reliable across all window types)
  let cursorActive = true;
  const dbgDot = document.getElementById("debug-dot");
  const pollCursor = async () => {
    while (cursorActive) {
      try {
        const resp = await fetch("http://127.0.0.1:3335/cursor");
        if (resp.ok) {
          cursor = await resp.json();
          // Debug: move dot to cursor position
          if (dbgDot) {
            dbgDot.style.left = `${cursor.x}px`;
            dbgDot.style.top = `${cursor.y}px`;
          }
        }
      } catch {
        // server not ready
      }
      await new Promise((r) => setTimeout(r, 33)); // ~30fps
    }
  };
  pollCursor();
  log("overlay", "cursor polling started (HTTP /cursor)");

  // Poll state — show chars that have attention
  pollState((state) => {
    const showSessions = state.sessions.filter((s) => s.attention);
    if (dbg) {
      dbg.title = `sessions=${state.count} attention=${showSessions.length}`;
      if (showSessions.length > 0) dbg.style.background = "lime";
    }
    syncChars(showSessions);
  }, 1000);

  // Start render loop
  startRenderLoop();
  log("overlay", "render loop started");
  if (dbg) dbg.style.background = "blue"; // blue = init complete
}

// ─── Sync chars with backend state ──────────────────────────────────────────

function syncChars(sessions: Session[]): void {
  if (!container) return;

  const activeIds = new Set(sessions.map((s) => s.id));

  // Remove chars no longer needing attention
  for (const [id, char] of chars) {
    if (!activeIds.has(id)) {
      log("overlay", `removing: ${char.session.name}`);
      char.el.remove();
      chars.delete(id);
    }
  }

  // Add or update chars
  for (const session of sessions) {
    const mode = eventToMode(session.event);

    if (!chars.has(session.id)) {
      // New char — spawn near cursor
      const el = createCharElement(session);
      container.appendChild(el);
      const offsetX = (Math.random() - 0.5) * 150;
      const offsetY = (Math.random() - 0.5) * 150;

      chars.set(session.id, {
        session,
        el,
        x: cursor.x + offsetX,
        y: cursor.y + offsetY,
        vx: 0,
        vy: 0,
        mode,
        roamTarget: randomRoamTarget(),
        roamTimer: 0,
      });
      log("overlay", `added: ${session.name} (mode=${mode})`);
    } else {
      // Update existing
      const char = chars.get(session.id)!;
      char.session = session;
      char.mode = mode;
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
      return "follow"; // Needs you — follows cursor
    case "running":
    case "tool":
      return "roam"; // Working — roams freely
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

  // Label: group · name + event
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
  // Create SVG layer for connection lines
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
  // Clear old lines
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
    let targetX: number;
    let targetY: number;
    let strength: number;

    if (char.mode === "follow") {
      // Follow cursor
      targetX = cursor.x;
      targetY = cursor.y;
      strength = FOLLOW_STRENGTH;
    } else {
      // Roam to random target
      char.roamTimer++;
      if (char.roamTimer > 180 || distTo(char, char.roamTarget) < 30) {
        char.roamTarget = randomRoamTarget();
        char.roamTimer = 0;
      }
      targetX = char.roamTarget.x;
      targetY = char.roamTarget.y;
      strength = ROAM_STRENGTH;
    }

    // Move toward target
    const dx = targetX - char.x;
    const dy = targetY - char.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (char.mode === "follow") {
      // Follow but keep min distance
      if (dist > MIN_CURSOR_DIST) {
        char.vx += dx * strength;
        char.vy += dy * strength;
      } else if (dist < MIN_CURSOR_DIST * 0.4) {
        // Push away if too close
        char.vx -= dx * 0.03;
        char.vy -= dy * 0.03;
      }
    } else {
      // Roam — just move toward target
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

    // Apply
    char.x += char.vx;
    char.y += char.vy;

    // Keep on screen
    char.x = Math.max(10, Math.min(window.innerWidth - CHAR_SIZE - 10, char.x));
    char.y = Math.max(10, Math.min(window.innerHeight - CHAR_SIZE - 10, char.y));

    // Render
    char.el.style.left = `${Math.round(char.x)}px`;
    char.el.style.top = `${Math.round(char.y)}px`;

    // Animation class based on mode
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
