/**
 * connections.ts — SVG connector lines between grouped characters.
 */

import { chars, CHAR_SIZE } from "./overlay-state";
import type { OverlayChar } from "./overlay-state";

// ─── Public API ─────────────────────────────────────────────────────────────

export function drawConnections(svg: SVGSVGElement): void {
  svg.innerHTML = "";
  const charArray = Array.from(chars.values());

  // Group visible chars by group
  const groups = new Map<string, OverlayChar[]>();
  for (const c of charArray) {
    if (c.el.style.display === "none" || c.el.dataset.leaving || !c.session.group) continue;
    if (!groups.has(c.session.group)) groups.set(c.session.group, []);
    groups.get(c.session.group)!.push(c);
  }

  // For each group, draw chain connections (nearest-neighbor chain, not N*N)
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
