/**
 * Overlay — transparent fullscreen window with cursor-following characters.
 *
 * Only sessions with `attention: true` appear here.
 * Characters follow the cursor with simple physics (spring + collision avoidance).
 *
 * This module is loaded by overlay.html (separate Tauri window).
 */

import type { Session, CursorPosition } from "../shared/types";
import { pollState, onCursorMove, log } from "../shared/bridge";
import { getCharacter } from "../characters/registry";
import type { CharacterAction } from "../characters/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverlayChar {
  session: Session;
  el: HTMLElement;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let cursor: CursorPosition = { x: 0, y: 0 };
let chars: Map<string, OverlayChar> = new Map();
let container: HTMLElement | null = null;
let animFrameId: number | null = null;

// ─── Config ─────────────────────────────────────────────────────────────────

const FOLLOW_STRENGTH = 0.03;
const DAMPING = 0.85;
const MIN_DISTANCE = 60;
const MAX_DISTANCE = 250;
const COLLISION_DISTANCE = 50;
const CHAR_SIZE = 40;

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initOverlay(el: HTMLElement): Promise<void> {
  container = el;
  log("overlay", "initializing");

  // Listen to cursor events
  await onCursorMove((pos) => {
    cursor = pos;
  });
  log("overlay", "cursor listener attached");

  // Poll state for attention sessions
  pollState((state) => {
    const attentionSessions = state.sessions.filter((s) => s.attention);
    syncChars(attentionSessions);
  }, 1500);

  // Start physics loop
  startPhysicsLoop();
  log("overlay", "physics loop started");
}

// ─── Sync characters with state ─────────────────────────────────────────────

function syncChars(sessions: Session[]): void {
  if (!container) return;

  const activeIds = new Set(sessions.map((s) => s.id));

  // Remove chars no longer needing attention
  for (const [id, char] of chars) {
    if (!activeIds.has(id)) {
      log("overlay", `removing char: ${id}`);
      char.el.remove();
      chars.delete(id);
    }
  }

  // Add new chars
  for (const session of sessions) {
    if (!chars.has(session.id)) {
      const el = createCharElement(session);
      container.appendChild(el);

      // Spawn near cursor with slight random offset
      const offset = (Math.random() - 0.5) * 200;
      chars.set(session.id, {
        session,
        el,
        x: cursor.x + offset,
        y: cursor.y + offset,
        targetX: cursor.x,
        targetY: cursor.y,
        vx: 0,
        vy: 0,
      });
      log("overlay", `added char: ${session.id} (${session.name})`);
    } else {
      // Update session data
      chars.get(session.id)!.session = session;
    }
  }
}

function createCharElement(session: Session): HTMLElement {
  const charDef = getCharacter(session.character ?? "ghost");
  const action: CharacterAction = "alert"; // Overlay chars are always in alert state
  const actionDef = charDef.actions[action];
  const animClass = actionDef?.cssClass ?? "";

  const el = document.createElement("div");
  el.className = `overlay-char ${animClass}`;
  el.dataset.sessionId = session.id;
  el.innerHTML = `
    <div class="overlay-char-svg">${charDef.svg}</div>
    <div class="overlay-char-label">${session.name}</div>
  `;
  el.style.position = "absolute";
  el.style.width = `${CHAR_SIZE}px`;
  el.style.height = `${CHAR_SIZE}px`;
  el.style.pointerEvents = "none";
  return el;
}

// ─── Physics Loop ───────────────────────────────────────────────────────────

function startPhysicsLoop(): void {
  function tick() {
    updatePositions();
    animFrameId = requestAnimationFrame(tick);
  }
  tick();
}

function updatePositions(): void {
  const charArray = Array.from(chars.values());

  for (const char of charArray) {
    // Target: follow cursor at a distance
    const dx = cursor.x - char.x;
    const dy = cursor.y - char.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > MIN_DISTANCE) {
      // Attract toward cursor
      const strength = Math.min(FOLLOW_STRENGTH, (dist - MIN_DISTANCE) / 1000);
      char.vx += dx * strength;
      char.vy += dy * strength;
    } else if (dist < MIN_DISTANCE * 0.5) {
      // Push away if too close
      char.vx -= dx * 0.02;
      char.vy -= dy * 0.02;
    }

    // Collision avoidance with other chars
    for (const other of charArray) {
      if (other === char) continue;
      const cdx = char.x - other.x;
      const cdy = char.y - other.y;
      const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      if (cdist < COLLISION_DISTANCE && cdist > 0) {
        const push = (COLLISION_DISTANCE - cdist) / cdist * 0.1;
        char.vx += cdx * push;
        char.vy += cdy * push;
      }
    }

    // Apply damping
    char.vx *= DAMPING;
    char.vy *= DAMPING;

    // Clamp max speed
    const speed = Math.sqrt(char.vx * char.vx + char.vy * char.vy);
    if (speed > 8) {
      char.vx = (char.vx / speed) * 8;
      char.vy = (char.vy / speed) * 8;
    }

    // Update position
    char.x += char.vx;
    char.y += char.vy;

    // Keep on screen
    char.x = Math.max(0, Math.min(window.innerWidth - CHAR_SIZE, char.x));
    char.y = Math.max(0, Math.min(window.innerHeight - CHAR_SIZE, char.y));

    // Apply to DOM
    char.el.style.transform = `translate(${char.x}px, ${char.y}px)`;
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export function destroyOverlay(): void {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
  }
  chars.clear();
  if (container) container.innerHTML = "";
}
