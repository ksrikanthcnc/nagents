/**
 * rendering.ts — Character animation, facing direction, and eye tracking.
 */

import type { CharacterAction } from "../characters/types";
import { getCharacter } from "../characters/registry";
import { cursor, CHAR_SIZE } from "./overlay-state";
import type { OverlayChar } from "./overlay-state";

// ─── Character Animation ────────────────────────────────────────────────────

export function applyCharAnim(char: OverlayChar, action: CharacterAction): void {
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

// ─── Facing Direction ───────────────────────────────────────────────────────

export function applyFacing(char: OverlayChar): void {
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

export function trackEyes(char: OverlayChar): void {
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
