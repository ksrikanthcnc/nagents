/**
 * physics.ts — Physics simulation: velocity, collision, position updates, BSB rendering.
 *
 * updatePhysics() is called every frame from the render loop in overlay.ts.
 */

import { getCharacter } from "../characters/registry";
import { log } from "../shared/bridge";
import {
  cursor, cursorTarget, chars, container,
  globalRevolveAngle, advanceRevolveAngle,
  hiddenBadgeEl, lastSummaryLog, setLastSummaryLog,
  cfg, CHAR_SIZE, DAMPING,
} from "./overlay-state";
import type { OverlayChar } from "./overlay-state";
import { applyCharAnim, applyFacing, trackEyes } from "./rendering";
import { renderSatellites, satellites } from "./satellites";
import { randomRoamTarget, distTo, getActionText } from "./dom";

// ─── BSB Box (Battery Saver Box) ────────────────────────────────────────────

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

// ─── Main Physics Update ────────────────────────────────────────────────────

export function updatePhysics(batterySaver: boolean, hiddenUntil: number): void {
  // Lerp cursor toward target (smooths jumps from slow poll rate)
  const smoothing = cfg.cursor_smoothing || 0.12;
  cursor.x += (cursorTarget.x - cursor.x) * smoothing;
  cursor.y += (cursorTarget.y - cursor.y) * smoothing;

  const charArray = Array.from(chars.values());
  const now = Date.now();

  // Check overlay hide flag (set by panel)
  if (hiddenUntil === Infinity || (hiddenUntil > 0 && now < hiddenUntil)) {
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
    setLastSummaryLog(now);
    const counts = { follow: 0, roam: 0, revolve: 0, hidden: 0 };
    for (const c of charArray) if (c.mode in counts) counts[c.mode as keyof typeof counts]++;
    log("overlay", `[summary] total=${charArray.length} follow=${counts.follow}/${cfg.max_followers} roam=${counts.roam}/${cfg.max_roamers} dot=${counts.revolve}/${cfg.max_dots} hidden=${counts.hidden}`);
  }

  const dotChars = charArray.filter(c => c.mode === "revolve" && !c.clusteredTo);
  const dotCount = dotChars.length;
  advanceRevolveAngle(cfg.revolve_speed);

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
      const lerpFactor = 0.15;
      char.x += (orbitX - char.x) * lerpFactor;
      char.y += (orbitY - char.y) * lerpFactor;
      char.vx = 0;
      char.vy = 0;
      // Apply dot visual — scale and center on orbit point
      const dotScale = cfg.dot_scale || 0.4;
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
      char.el.style.transform = `translate(${-cx}px, ${-cy}px) scale(${dotScale})`;
      char.el.style.transformOrigin = `${cx}px ${cy}px`;
      char.el.classList.add("char-dot");
      char.el.classList.remove("char-following", "char-roaming", "char-working");
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
        const ringOuter = cfg.revolve_radius + CHAR_SIZE;
        const charCx = char.x + hw;
        const charCy = char.y + hh;
        const dx = charCx - cursor.x;
        const dy = charCy - cursor.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          targetX = cursor.x + (dx / dist) * ringOuter - hw;
          targetY = cursor.y + (dy / dist) * ringOuter - hh;
        } else {
          targetX = cursor.x + ringOuter - hw;
          targetY = cursor.y - hh;
        }
      } else {
        targetX = cursor.x - hw;
        targetY = cursor.y - hh;
      }
      strength = cfg.follow_strength || 0.04;
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
      strength = Math.max(cfg.roam_strength, 0.02);
      char.el.classList.remove("char-dot");
      char.el.style.transform = "";
      char.el.style.width = `${CHAR_SIZE}px`;
      char.el.style.fontSize = "";
    }

    // ─── Cluster override: fixed position around center char ────────────
    if (char.clusteredTo) {
      const rep = chars.get(char.clusteredTo);
      if (rep && rep.el.style.display !== "none") {
        if (rep.mode === "revolve") {
          char.el.style.display = "none";
          continue;
        }
        const clusterMembers = charArray.filter(c => c.clusteredTo === char.clusteredTo && c.el.style.display !== "none");
        const clusterIdx = clusterMembers.indexOf(char);
        const clusterCount = clusterMembers.length;
        const orbitAngle = (2 * Math.PI * clusterIdx) / Math.max(1, clusterCount);
        const orbitRadius = CHAR_SIZE * 0.8;
        char.x = rep.x + Math.cos(orbitAngle) * orbitRadius;
        char.y = rep.y + Math.sin(orbitAngle) * orbitRadius;
        char.vx = 0;
        char.vy = 0;
        const clusterScale = (cfg.dot_scale || 0.55) * 0.7;
        char.el.style.transform = `scale(${clusterScale})`;
        char.el.style.transformOrigin = "center center";
        char.el.style.opacity = "";
        char.el.style.zIndex = "0";
        char.el.classList.add("char-clustered");
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
      const ringRadius = cfg.revolve_radius + CHAR_SIZE * 0.75;
      if (toCursorDist < ringRadius) {
        const penetration = ringRadius - toCursorDist;
        const norm = Math.max(1, toCursorDist);
        const pushForce = Math.min(penetration * 0.5, 8);
        char.vx += (toCursorX / norm) * pushForce;
        char.vy += (toCursorY / norm) * pushForce;
      }
    }

    // ─── Collision ───────────────────────────────────────────────────
    if ((char.mode as string) !== "revolve" && !batterySaver) {
      for (const other of charArray) {
        if (other === char || other.el.style.display === "none") continue;
        if (other.mode === "revolve" && char.mode === "roam") continue;
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

    // Accelerating pulse
    if (char.session.attention && char.session.attention_since) {
      const waitingSec = (Date.now() / 1000) - char.session.attention_since;
      const speed = Math.max(0.6, 2.5 - (waitingSec / 300) * 1.9);
      char.el.style.setProperty("--pulse-speed", `${speed.toFixed(2)}s`);
    }

    applyCharAnim(char, char.mode === "follow" && char.session.attention ? "alert" : char.mode === "follow" ? "idle" : "walk");
    applyFacing(char);
    if (char.mode === "follow") trackEyes(char);
  }

  // ─── Sub-agent satellites: orbit parent chars ──────────────────────
  renderSatellites(charArray);

  // Hidden badge follows cursor
  if (hiddenBadgeEl && hiddenBadgeEl.style.display !== "none") {
    hiddenBadgeEl.style.left = `${Math.round(cursor.x - 12)}px`;
    hiddenBadgeEl.style.top = `${Math.round(cursor.y - 24)}px`;
  }
}
