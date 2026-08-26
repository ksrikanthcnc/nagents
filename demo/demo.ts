/**
 * nagents demo — standalone GitHub Pages showcase.
 *
 * Full physics engine + real character SVGs. No backend needed.
 * Simulates sessions spawning, transitioning states, and being managed
 * by the overlay's follow→roam→dot→hidden waterfall.
 *
 * Cursor: tracks actual mouse position (chars nag your cursor).
 */

import type { Session, OverlayConfig } from "@/shared/types";
import { getCharacter, listCharacters } from "@/characters/registry";
import { computeModes, type CharMode, type CharState, type ModeConfig, MODE_DEFAULTS } from "@/overlay/modes";

// Import character animation CSS
import "@/characters/ghost/animations.css";
import "@/characters/cat/animations.css";
import "@/characters/skeleton/animations.css";
import "@/characters/robot/animations.css";
import "@/characters/owl/animations.css";
import "@/characters/mushroom/animations.css";
import "@/characters/flame/animations.css";
import "@/characters/crystal/animations.css";
import "@/characters/cloud/animations.css";
import "@/characters/blob/animations.css";

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
  modeSetAt: number;
  clusteredTo: string | null;
}

// ─── State ──────────────────────────────────────────────────────────────────

const cursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const chars: Map<string, OverlayChar> = new Map();
let container: HTMLElement | null = null;
let globalRevolveAngle = 0;
let hiddenBadgeEl: HTMLElement | null = null;
let nextId = 1;
let connectorsEnabled = false;

// ─── Config ─────────────────────────────────────────────────────────────────

const cfg: OverlayConfig = {
  // Using values from config.yaml (tuned smooth)
  follow_strength: 0.008,
  roam_strength: 0.008,
  roam_max_speed: 3,
  follow_max_speed: 6,
  min_cursor_distance: 80,
  collision_distance: 100,
  revolve_radius: 40,
  revolve_speed: 0.015,
  shrink_after_min: 5,
  dot_scale: 0.5,
  cursor_fps: 60,
  cursor_smoothing: 0.12,
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
  follower_mode: "lifo",
  round_robin_sec: 3,
};

const DAMPING = 0.88;
const CHAR_SIZE = 44;

// ─── Simulation Data ────────────────────────────────────────────────────────

const SOURCES = ["ide", "cli", "crew"] as const;
const GROUPS = ["webapp", "backend", "infra", "data-pipeline", "frontend", "ops", "ml-train", "deploy"];
const TASKS = [
  "fix-pipeline", "add-logging", "update-deps", "refactor-auth", "scale-pods",
  "debug-crash", "write-tests", "migrate-db", "optimize-query", "review-pr",
  "build-api", "deploy-staging", "fix-flaky-test", "add-metrics", "clean-cache",
];
const EVENTS = ["running", "idle", "approval", "stuck", "tool"] as const;
const TOOLS = ["fs_write", "execute_bash", "read_file", "grep_search", "invoke_sub_agent", "web_fetch"];
const FILES = ["main.ts", "overlay.ts", "config.yaml", "pipeline.py", "auth.rs", "deploy.sh"];

// ─── Logging ────────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 30;

function logEvent(type: "spawn" | "transition" | "mode" | "remove", msg: string): void {
  const logEl = document.getElementById("event-log");
  if (!logEl) return;

  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-${type}">${msg}</span>`;
  logEl.appendChild(entry);

  // Trim old entries
  while (logEl.children.length > MAX_LOG_ENTRIES) {
    logEl.removeChild(logEl.firstChild!);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function updateCounts(): void {
  const counts = { follow: 0, roam: 0, revolve: 0, hidden: 0 };
  for (const c of chars.values()) {
    if (c.mode in counts) counts[c.mode as keyof typeof counts]++;
  }
  const el = (id: string) => document.getElementById(id);
  el("count-follow")!.textContent = String(counts.follow);
  el("count-roam")!.textContent = String(counts.roam);
  el("count-dot")!.textContent = String(counts.revolve);
  el("count-hidden")!.textContent = String(counts.hidden);

  // Update attention queue
  updateAttentionQueue();
}

function updateAttentionQueue(): void {
  const listEl = document.getElementById("attention-list");
  if (!listEl) return;

  // Get chars that are following AND need attention (not just running)
  const followers = Array.from(chars.values()).filter(
    c => c.mode === "follow" && c.session.attention === true
  );

  listEl.innerHTML = "";
  if (followers.length === 0) {
    listEl.innerHTML = `<span style="font-size:9px;color:rgba(255,255,255,0.25)">none right now</span>`;
    return;
  }

  for (const char of followers) {
    const charDef = getCharacter(char.session.character || "ghost");
    const item = document.createElement("div");
    item.className = "attention-item";
    item.innerHTML = `
      <span class="att-char">${charDef.svg}</span>
      <span class="att-name">${char.session.name}</span>
      <span class="att-state">${char.session.event === "idle" ? "done" : char.session.event}</span>
    `;
    item.addEventListener("click", () => {
      // Respond: transition to running, agent goes back to work
      updateSession(char.session.id, {
        event: "running",
        attention: false,
        attention_reason: null,
        tool: null,
        file: null,
        status: "in_progress",
        mtime: Date.now(),
      });
      logEvent("mode", `responded to ${char.session.character}:${char.session.name} → working`);
    });
    listEl.appendChild(item);
  }
}

// ─── Session Factory ────────────────────────────────────────────────────────

function createMockSession(overrides?: Partial<Session>): Session {
  const id = `demo-${nextId++}`;
  const source = SOURCES[Math.floor(Math.random() * SOURCES.length)];
  const group = GROUPS[Math.floor(Math.random() * GROUPS.length)];
  const name = TASKS[Math.floor(Math.random() * TASKS.length)];
  const event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  const characters = listCharacters();
  const character = characters[Math.floor(Math.random() * characters.length)].id;

  const isAttention = event === "idle" || event === "approval" || event === "stuck";
  const tool = event === "tool" ? TOOLS[Math.floor(Math.random() * TOOLS.length)] : null;
  const file = (event === "tool" || event === "running") ? FILES[Math.floor(Math.random() * FILES.length)] : null;

  return {
    id,
    source,
    name,
    workspace: "/demo",
    group,
    active: true,
    event,
    attention_source: null,
    attention: isAttention,
    attention_reason: isAttention ? "demo" : null,
    tool,
    file,
    tokens: Math.floor(Math.random() * 50000),
    maxTokens: 100000,
    mtime: Date.now(),
    character,
    attention_since: isAttention ? Date.now() : null,
    on_overlay: true,
    pinned: false,
    muted: false,
    tool_ok: null,
    tool_result: null,
    prompt: null,
    description: event === "idle" ? "Task completed successfully" : null,
    status: event === "idle" ? "completed" : event === "approval" ? "waiting_on_user" : "in_progress",
    priority: null,
    last_user_ts: Date.now() - Math.random() * 60000,
    interaction_count: Math.floor(Math.random() * 20),
    sub_agents: 0,
    sub_agent_names: [],
    ...overrides,
  };
}

// ─── Overlay Engine (adapted from ui/overlay/overlay.ts) ────────────────────

function initOverlay(el: HTMLElement): void {
  container = el;

  hiddenBadgeEl = document.createElement("div");
  hiddenBadgeEl.className = "overlay-hidden-badge";
  hiddenBadgeEl.style.display = "none";
  el.appendChild(hiddenBadgeEl);

  startRenderLoop();
}

function addCharToOverlay(session: Session): void {
  if (!container || chars.has(session.id)) return;

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
  applyModes();
}

function removeCharFromOverlay(sessionId: string): void {
  const char = chars.get(sessionId);
  if (!char) return;

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

  setTimeout(() => {
    char.el.remove();
    chars.delete(sessionId);
    applyModes();
    updateCounts();
  }, 1500);
}

function updateSession(sessionId: string, updates: Partial<Session>): void {
  const char = chars.get(sessionId);
  if (!char) return;
  Object.assign(char.session, updates);

  // Update labels
  const actionEl = char.el.querySelector(".overlay-char-action");
  if (actionEl) {
    const icon = getToolIcon(char.session.tool, char.session.event);
    const text = getActionText(char.session);
    actionEl.innerHTML = `${icon ? `<span class="action-icon">${icon}</span>` : ""}${text}`;
  }

  applyModes();
}

// ─── Mode Assignment ────────────────────────────────────────────────────────

function applyModes(): void {
  const charArray = Array.from(chars.values());

  const states: CharState[] = charArray.map(c => ({
    sessionId: c.session.id,
    session: c.session,
    currentMode: c.mode,
    spawnedAt: c.spawnedAt,
    lastUserTs: c.session.last_user_ts ?? c.spawnedAt,
    interactionCount: c.session.interaction_count ?? 0,
  }));

  const modeCfg: ModeConfig = {
    max_followers: cfg.max_followers,
    max_roamers: cfg.max_roamers,
    max_dots: cfg.max_dots,
    follower_mode: cfg.follower_mode,
    round_robin_sec: cfg.round_robin_sec,
    pin_counts_toward_max: cfg.pin_counts_toward_max,
    group_as_one: cfg.group_as_one,
    group_display: "cluster",
    working_mode: "roam",
    working_counts_toward_max: false,
    attention_follows: true,
  };

  const assignments = computeModes(states, modeCfg);

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
      }
      if (newMode === "roam" && prevMode !== "roam") {
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
    }

    char.mode = newMode;

    if (newMode === "hidden") {
      char.el.style.display = "none";
      hiddenCount++;
    } else {
      char.el.style.display = "";
    }
  }

  updateHiddenBadge(hiddenCount);
  updateCounts();
}

// ─── Render Loop ────────────────────────────────────────────────────────────

function startRenderLoop(): void {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;";
  container!.appendChild(svg);

  const frameInterval = 1000 / cfg.physics_fps;
  let lastFrame = 0;
  let frameCount = 0;

  function tick(now: number) {
    requestAnimationFrame(tick);
    if (now - lastFrame < frameInterval) return;
    lastFrame = now;
    frameCount++;
    updatePhysics();
    if (frameCount % 3 === 0) drawConnections(svg);
  }
  requestAnimationFrame(tick);
}

function updatePhysics(): void {
  const charArray = Array.from(chars.values());
  if (charArray.length === 0) return;

  const dotChars = charArray.filter(c => c.mode === "revolve");
  const dotCount = dotChars.length;
  globalRevolveAngle += cfg.revolve_speed;

  for (const char of charArray) {
    if (char.el.style.display === "none") continue;

    let targetX: number, targetY: number, strength: number;

    if (char.mode === "revolve") {
      const dotIndex = dotChars.indexOf(char);
      const angle = globalRevolveAngle + (2 * Math.PI * dotIndex) / Math.max(1, dotCount);
      targetX = cursor.x + Math.cos(angle) * cfg.revolve_radius;
      targetY = cursor.y + Math.sin(angle) * cfg.revolve_radius;
      strength = 0.2;

      const dotScale = cfg.dot_scale;
      const cx = CHAR_SIZE / 2;
      const cy = CHAR_SIZE / 2;
      char.el.style.transform = `translate(${-cx}px, ${-cy}px) scale(${dotScale})`;
      char.el.style.transformOrigin = `${cx}px ${cy}px`;
      char.el.classList.add("char-dot");
      char.el.classList.remove("char-following", "char-roaming", "char-working");
    } else if (char.mode === "follow") {
      const hw = CHAR_SIZE / 2;
      const hh = CHAR_SIZE / 2;
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
      strength = 0.08;
      char.el.classList.remove("char-dot");
      char.el.style.transform = "";
      char.el.style.width = `${CHAR_SIZE}px`;
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
    }

    // Physics: pull toward target
    const dx = targetX - char.x;
    const dy = targetY - char.y;
    char.vx += dx * strength;
    char.vy += dy * strength;

    // Ring exclusion
    if (char.mode !== "revolve" && dotCount > 0) {
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

    // Collisions
    if (char.mode !== "revolve") {
      for (const other of charArray) {
        if (other === char || other.el.style.display === "none") continue;
        if (other.mode === "revolve" && char.mode === "roam") continue;
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

    // Damping + velocity clamping
    const damping = char.mode === "revolve" ? 0.75 : (char.mode === "follow" ? 0.8 : DAMPING);
    char.vx *= damping;
    char.vy *= damping;

    if (char.mode === "roam") {
      const maxSpeed = cfg.roam_max_speed;
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

    // Render
    const newLeft = Math.round(char.x);
    const newTop = Math.round(char.y);
    char.el.style.left = `${newLeft}px`;
    char.el.style.top = `${newTop}px`;

    char.el.classList.toggle("char-following", char.mode === "follow");
    char.el.classList.toggle("char-roaming", char.mode === "roam");
    const isWorking = char.session.event === "running" || char.session.event === "tool";
    char.el.classList.toggle("char-working", isWorking);

    applyCharAnim(char, char.mode === "follow" ? "alert" : "walk");
    applyFacing(char);
    if (char.mode === "follow") trackEyes(char);
  }

  // Hidden badge
  if (hiddenBadgeEl && hiddenBadgeEl.style.display !== "none") {
    hiddenBadgeEl.style.left = `${Math.round(cursor.x - 12)}px`;
    hiddenBadgeEl.style.top = `${Math.round(cursor.y - 24)}px`;
  }
}

// ─── Anim + Facing ──────────────────────────────────────────────────────────

function applyCharAnim(char: OverlayChar, action: "alert" | "walk"): void {
  const slotForMode = action === "alert" ? "char-slot-alert" : "char-slot-walk";
  const svgWrap = char.el.querySelector(".overlay-char-svg") as HTMLElement | null;
  if (svgWrap && !svgWrap.classList.contains(slotForMode)) {
    svgWrap.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
    svgWrap.classList.add(slotForMode);
  }
  if (!char.el.classList.contains(slotForMode)) {
    char.el.classList.remove("char-slot-idle", "char-slot-active", "char-slot-alert", "char-slot-walk");
    char.el.classList.add(slotForMode);
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

function trackEyes(char: OverlayChar): void {
  const eyes = char.el.querySelectorAll("svg .eye");
  if (eyes.length === 0) return;
  const cx = char.x + CHAR_SIZE / 2;
  const cy = char.y + CHAR_SIZE / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;
  const ox = (dx / dist) * 2;
  const oy = (dy / dist) * 2;
  const flip = char.el.dataset.flip === "-1" ? -1 : 1;
  for (const eye of eyes) {
    (eye as SVGElement).style.translate = `${ox * flip}px ${oy}px`;
  }
}

// ─── Connections ────────────────────────────────────────────────────────────

function drawConnections(svg: SVGSVGElement): void {
  svg.innerHTML = "";
  if (!connectorsEnabled) return;
  const charArray = Array.from(chars.values());
  const groups = new Map<string, OverlayChar[]>();

  for (const c of charArray) {
    if (c.el.style.display === "none" || !c.session.group) continue;
    if (!groups.has(c.session.group)) groups.set(c.session.group, []);
    groups.get(c.session.group)!.push(c);
  }

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const visited = new Set<number>();
    let current = 0;
    visited.add(0);

    for (let step = 0; step < members.length - 1; step++) {
      let nearest = -1;
      let nearestDist = Infinity;
      for (let j = 0; j < members.length; j++) {
        if (visited.has(j)) continue;
        const ddx = members[current].x - members[j].x;
        const ddy = members[current].y - members[j].y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < nearestDist) { nearestDist = d; nearest = j; }
      }
      if (nearest === -1) break;
      visited.add(nearest);

      const a = members[current], b = members[nearest];
      const ax = a.x + CHAR_SIZE / 2, ay = a.y + CHAR_SIZE / 2;
      const bx = b.x + CHAR_SIZE / 2, by = b.y + CHAR_SIZE / 2;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(ax));
      line.setAttribute("y1", String(ay));
      line.setAttribute("x2", String(bx));
      line.setAttribute("y2", String(by));
      line.setAttribute("stroke", "rgba(255,255,255,0.15)");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "6 4");
      svg.appendChild(line);

      current = nearest;
    }
  }
}

// ─── DOM Helpers ────────────────────────────────────────────────────────────

function createCharElement(session: Session): HTMLElement {
  const charId = session.character || "ghost";
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
      invoke_sub_agent: "\uD83E\uDD16",
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
      case "execute_bash": return "bash";
      case "grep_search": case "file_search": return "searching";
      case "invoke_sub_agent": return "sub-agent";
      default: return session.tool.length > 15 ? session.tool.slice(0, 14) + "\u2026" : session.tool;
    }
  }
  if (session.event === "idle") return "\u2713 done";
  if (session.event === "approval") return "? approval";
  if (session.event === "stuck") return "stuck";
  return session.event || "";
}

function basename(path: string): string { return path.split("/").pop() || path; }

function randomRoamTarget(): { x: number; y: number } {
  return { x: 80 + Math.random() * (window.innerWidth - 160), y: 80 + Math.random() * (window.innerHeight - 160) };
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
  const ddx = char.x - target.x;
  const ddy = char.y - target.y;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

// ─── Simulation Loop ────────────────────────────────────────────────────────

const SPAWN_INTERVAL_BASE = 5000; // base: ~5s between spawns
const SPAWN_JITTER = 4000; // ±4s jitter (so 3-9s range)
const MAX_AGENTS = 12;
const STATE_CHANGE_BASE = 6000; // base: ~6s between transitions
const STATE_CHANGE_JITTER = 5000; // ±5s jitter (so 3.5-11s range)

function runSimulation(): void {
  // Spawn agents with randomized timing
  function scheduleSpawn() {
    const delay = SPAWN_INTERVAL_BASE + (Math.random() - 0.3) * SPAWN_JITTER;
    setTimeout(() => {
      const maxAgents = (window as any).__demoMaxAgents || MAX_AGENTS;
      if (chars.size >= maxAgents) {
        // Occasionally remove one to show the walk-off
        if (Math.random() < 0.4) {
          const ids = Array.from(chars.keys());
          const victimId = ids[Math.floor(Math.random() * ids.length)];
          const victim = chars.get(victimId);
          if (victim) {
            logEvent("remove", `${victim.session.character} left (${victim.session.group}:${victim.session.name})`);
            removeCharFromOverlay(victimId);
          }
        }
      } else {
        const session = createMockSession();
        addCharToOverlay(session);
        logEvent("spawn", `+${session.character} → ${session.group}:${session.name} [${session.event}]`);
      }
      scheduleSpawn();
    }, Math.max(2000, delay));
  }

  // Random state transitions with jitter
  function scheduleTransition() {
    const delay = STATE_CHANGE_BASE + (Math.random() - 0.3) * STATE_CHANGE_JITTER;
    setTimeout(() => {
      if (chars.size > 0) {
        const ids = Array.from(chars.keys());
        const targetId = ids[Math.floor(Math.random() * ids.length)];
        const char = chars.get(targetId);
        if (char && !char.el.classList.contains("char-hiding")) {
          const prevEvent = char.session.event;
          const newEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)];
          const isAttention = newEvent === "idle" || newEvent === "approval" || newEvent === "stuck";
          const tool = newEvent === "tool" ? TOOLS[Math.floor(Math.random() * TOOLS.length)] : null;
          const file = tool ? FILES[Math.floor(Math.random() * FILES.length)] : null;

          updateSession(targetId, {
            event: newEvent,
            attention: isAttention,
            attention_reason: isAttention ? "demo" : null,
            tool,
            file,
            priority: null,
            status: newEvent === "idle" ? "completed" : newEvent === "approval" ? "waiting_on_user" : "in_progress",
            mtime: Date.now(),
          });

          logEvent("transition", `${char.session.character}: ${prevEvent} → ${newEvent}`);
        }
      }
      scheduleTransition();
    }, Math.max(2500, delay));
  }

  scheduleSpawn();
  scheduleTransition();

  // Tool cycling: running agents change tools (simulates actual work)
  function scheduleToolCycle() {
    const delay = 2000 + Math.random() * 3000; // every 2-5s
    setTimeout(() => {
      const running = Array.from(chars.values()).filter(
        c => (c.session.event === "running" || c.session.event === "tool") && !c.el.classList.contains("char-hiding")
      );
      if (running.length > 0) {
        const target = running[Math.floor(Math.random() * running.length)];
        const newTool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
        const newFile = FILES[Math.floor(Math.random() * FILES.length)];
        // Occasionally show sub-agent activity
        const hasSubAgent = Math.random() < 0.15;
        updateSession(target.session.id, {
          event: "tool",
          tool: newTool,
          file: newFile,
          sub_agents: hasSubAgent ? 1 : 0,
          sub_agent_names: hasSubAgent ? ["context-gatherer"] : [],
          mtime: Date.now(),
        });
      }
      scheduleToolCycle();
    }, delay);
  }
  scheduleToolCycle();
}

// ─── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const overlayEl = document.getElementById("overlay")!;

  // Track mouse as cursor
  document.addEventListener("mousemove", (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
  });

  // Init overlay engine
  initOverlay(overlayEl);

  // Live clock in menu bar
  const updateClock = () => {
    const el = document.getElementById("menu-time");
    if (el) {
      const now = new Date();
      const day = now.toLocaleDateString("en-US", { weekday: "short" });
      const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      el.textContent = `${day} ${time}`;
    }
  };
  updateClock();
  setInterval(updateClock, 30000);

  // Config sliders
  const wireSlider = (id: string, key: "max_followers" | "max_roamers" | "max_dots") => {
    const slider = document.getElementById(id) as HTMLInputElement;
    const valEl = document.getElementById(`${id}-val`)!;
    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      valEl.textContent = String(v);
      cfg[key] = v;
      applyModes();
    });
  };
  wireSlider("cfg-followers", "max_followers");
  wireSlider("cfg-roamers", "max_roamers");
  wireSlider("cfg-dots", "max_dots");

  // Max agents slider
  const maxSlider = document.getElementById("cfg-max") as HTMLInputElement;
  const maxVal = document.getElementById("cfg-max-val")!;
  maxSlider.addEventListener("input", () => {
    maxVal.textContent = maxSlider.value;
    (window as any).__demoMaxAgents = Number(maxSlider.value);
  });

  // Follower mode selector
  const modeSelect = document.getElementById("cfg-mode") as HTMLSelectElement;
  modeSelect.addEventListener("change", () => {
    cfg.follower_mode = modeSelect.value;
    applyModes();
    logEvent("mode", `follower mode → ${modeSelect.value}`);
  });

  // Connectors toggle
  const connCheck = document.getElementById("cfg-connectors") as HTMLInputElement;
  connCheck.addEventListener("change", () => {
    connectorsEnabled = connCheck.checked;
  });

  // Burst button
  document.getElementById("btn-burst")?.addEventListener("click", () => {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        const session = createMockSession();
        addCharToOverlay(session);
        logEvent("spawn", `+${session.character} → ${session.group}:${session.name} [${session.event}]`);
      }, i * 300);
    }
  });

  // Clear button
  document.getElementById("btn-clear")?.addEventListener("click", () => {
    const ids = Array.from(chars.keys());
    ids.forEach((id, i) => {
      setTimeout(() => removeCharFromOverlay(id), i * 150);
    });
    logEvent("remove", `cleared all (${ids.length})`);
  });

  // Start simulation
  logEvent("spawn", "simulation starting...");
  runSimulation();

  // Spawn initial batch (2 agents with a gap)
  for (let i = 0; i < 2; i++) {
    setTimeout(() => {
      const session = createMockSession();
      addCharToOverlay(session);
      logEvent("spawn", `+${session.character} → ${session.group}:${session.name} [${session.event}]`);
    }, i * 1000);
  }
});
