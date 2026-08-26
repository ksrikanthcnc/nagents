/**
 * satellites.ts — Sub-agent satellite rendering (small orbiting chars around parents).
 */

import { getCharacter } from "../characters/registry";
import { container, CHAR_SIZE } from "./overlay-state";
import type { OverlayChar } from "./overlay-state";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Source -> glow color for satellites */
function getSourceColor(source: string): string {
  if (source.includes("crew")) return "rgba(167, 139, 250, 0.7)";
  if (source.includes("cli")) return "rgba(168, 230, 207, 0.7)";
  if (source.includes("ide")) return "rgba(96, 165, 250, 0.7)";
  return "rgba(167, 139, 250, 0.5)";
}

/** Worker type -> character ID mapping */
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

/** Extract worker type from name (e.g. "cg: Exploring auth" -> "cg") */
function getWorkerType(name: string): string {
  const colonIdx = name.indexOf(":");
  if (colonIdx > 0) return name.slice(0, colonIdx).trim();
  return name.trim();
}

// ─── State ──────────────────────────────────────────────────────────────────

/** Satellite elements keyed by "parentId-sat-index" */
export const satellites: Map<string, HTMLElement> = new Map();
let satelliteAngle = 0;

// ─── Public API ─────────────────────────────────────────────────────────────

/** Satellite size scales with main char size (~40% of CHAR_SIZE) */
export function getSatSize(): number { return Math.round(CHAR_SIZE * 0.4); }

export function renderSatellites(charArray: OverlayChar[]): void {
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
