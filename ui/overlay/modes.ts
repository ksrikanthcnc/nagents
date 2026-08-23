/**
 * modes.ts — Mode assignment for nagents/nagents overlay.
 *
 * Simple waterfall: all sessions sorted by priority, placed into zones by threshold.
 *
 * Priority (highest first):
 *   1. pinned (user-set or hook priority:"high")
 *   2. attention (approval/stuck — agent blocked)
 *   3. ? in response (idle + waiting_on_user or normal priority — agent asked something)
 *   4. free idle (idle + low priority — task done, no urgency)
 *   5. working (running/tool — actively processing)
 *
 * Zone placement (each has its own max):
 *   follow → max_followers slots (follows cursor)
 *   roam   → max_roamers slots (free on screen)
 *   dot    → max_dots slots (orbit cursor)
 *   hidden → everything else (badge shows count)
 *
 * Within same priority tier: sorted by follower_mode (fifo/lifo/lru/priority/round_robin).
 */

import type { Session } from "../shared/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CharMode = "follow" | "roam" | "revolve" | "hidden";

export interface ModeAssignment {
  sessionId: string;
  mode: CharMode;
  /** If set, this char is clustered around the given session (targets its position, scales down) */
  clusteredTo?: string;
  /** Hidden due to group_as_one (don't count in +N badge) */
  groupHidden?: boolean;
}

export interface CharState {
  sessionId: string;
  session: Session;
  currentMode: CharMode;
  spawnedAt: number;
  lastUserTs: number;
  interactionCount: number;
}

export interface ModeConfig {
  max_followers: number;
  max_roamers: number;
  max_dots: number;
  follower_mode: string;
  round_robin_sec: number;
  pin_counts_toward_max: boolean;
  group_as_one: boolean;
  /** How to display merged groups: "single" | "cluster" | "carousel" */
  group_display: string;
}

export const MODE_DEFAULTS: ModeConfig = {
  max_followers: 2,
  max_roamers: 3,
  max_dots: 5,
  follower_mode: "priority,lifo",
  round_robin_sec: 10,
  pin_counts_toward_max: false,
  group_as_one: false,
  group_display: "cluster",
};

// ─── Round-robin state ──────────────────────────────────────────────────────

let rrLastRotate = 0;
let rrOffset = 0;

// ─── Persistent queue order (survives across calls, for LRU/FIFO/LIFO) ─────
// Maintains insertion order so switching modes doesn't reset positions.
let queueOrder: string[] = []; // session IDs in their last-computed order

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Compute mode for each char. Pure function (no DOM).
 *
 * 1. Separate pinned (always follow, exempt from limits)
 * 2. Sort remaining by priority
 * 3. Place top N into follow, next M into roam, next K into dot, rest hidden
 */
export function computeModes(chars: CharState[], cfg: ModeConfig): Map<string, ModeAssignment> {
  const result = new Map<string, ModeAssignment>();

  // ─── Pinned: always follow ────────────────────────────────────────
  const pinned: CharState[] = [];
  let normal: CharState[] = [];

  for (const c of chars) {
    if (c.session.pinned || c.session.priority === "high") {
      pinned.push(c);
      result.set(c.sessionId, { sessionId: c.sessionId, mode: "follow" });
    } else {
      normal.push(c);
    }
  }

  // ─── Sort normal chars by priority ────────────────────────────────
  // If group_as_one: merge same-group sessions based on group_display mode
  if (cfg.group_as_one) {
    const groupMembers = new Map<string, CharState[]>();
    const ungrouped: CharState[] = [];

    for (const c of normal) {
      const group = c.session.group;
      if (!group) { ungrouped.push(c); continue; }
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      groupMembers.get(group)!.push(c);
    }

    // Sort each group's members by priority (best first)
    for (const [, members] of groupMembers) {
      members.sort((a, b) => getPriorityLevel(b) - getPriorityLevel(a));
    }

    if (cfg.group_display === "single") {
      // Only highest-priority member visible, rest hidden
      for (const [, members] of groupMembers) {
        ungrouped.push(members[0]); // representative
        for (let i = 1; i < members.length; i++) {
          result.set(members[i].sessionId, { sessionId: members[i].sessionId, mode: "hidden", groupHidden: true });
        }
      }
    } else {
      // "cluster" or "carousel" (merged): one center char, others orbit it.
      // Center rotates every round_robin_sec.
      const now = Date.now();
      for (const [, members] of groupMembers) {
        // Determine who is center (rotates by time)
        const centerIdx = Math.floor(now / (cfg.round_robin_sec * 1000)) % members.length;
        const centerChar = members[centerIdx];
        // Center goes into waterfall (gets a mode slot)
        ungrouped.push(centerChar);
        // Others cluster around center
        for (let i = 0; i < members.length; i++) {
          if (i === centerIdx) continue;
          result.set(members[i].sessionId, {
            sessionId: members[i].sessionId,
            mode: "follow", // placeholder, overridden to center's mode after waterfall
            clusteredTo: centerChar.sessionId,
          });
        }
      }
    }

    normal = ungrouped;
  }

  sortByPriority(normal, cfg.follower_mode, cfg.round_robin_sec);

  // Update persistent queue (add new IDs, remove gone ones)
  const normalIds = new Set(normal.map(c => c.sessionId));
  queueOrder = queueOrder.filter(id => normalIds.has(id));
  for (const c of normal) {
    if (!queueOrder.includes(c.sessionId)) {
      queueOrder.push(c.sessionId); // New entries go to end
    }
  }

  // ─── Place into zones by threshold ────────────────────────────────
  const followSlots = cfg.pin_counts_toward_max
    ? Math.max(0, cfg.max_followers - pinned.length)
    : cfg.max_followers;

  let followUsed = 0;
  let roamUsed = 0;
  let dotUsed = 0;

  for (const c of normal) {
    let mode: CharMode;
    if (followUsed < followSlots) {
      mode = "follow";
      followUsed++;
    } else if (roamUsed < cfg.max_roamers) {
      mode = "roam";
      roamUsed++;
    } else if (dotUsed < cfg.max_dots) {
      mode = "revolve";
      dotUsed++;
    } else {
      mode = "hidden";
    }
    result.set(c.sessionId, { sessionId: c.sessionId, mode });
  }

  // Update clustered chars to match their representative's mode
  for (const [id, assignment] of result) {
    if (assignment.clusteredTo) {
      const repAssignment = result.get(assignment.clusteredTo);
      if (repAssignment) {
        assignment.mode = repAssignment.mode;
      }
    }
  }

  return result;
}

// ─── Priority Sorting ───────────────────────────────────────────────────────

/**
 * Sort chars by priority (highest first), then by follower_mode for tie-breaking.
 *
 * Priority levels:
 *   4 = attention (approval/stuck)
 *   3 = ? (idle + normal/null priority, or status=waiting_on_user)
 *   2 = free idle (idle + low priority)
 *   1 = working (running/tool)
 *   0 = no attention (shouldn't be on overlay but handle gracefully)
 */
function sortByPriority(list: CharState[], modeStr: string, rrSec: number): void {
  const now = Date.now();

  // Round-robin: special case
  if (modeStr === "round_robin") {
    if (now - rrLastRotate > rrSec * 1000) {
      rrLastRotate = now;
      rrOffset = (rrOffset + 1) % Math.max(1, list.length);
    }
    list.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const rotated = [...list.slice(rrOffset), ...list.slice(0, rrOffset)];
    list.length = 0;
    list.push(...rotated);
    return;
  }

  // Parse chain for tie-breaking (e.g. "priority,lifo")
  const tieBreakers = modeStr.split(",").map(s => s.trim());

  list.sort((a, b) => {
    // Primary: priority level
    const diff = getPriorityLevel(b) - getPriorityLevel(a);
    if (diff !== 0) return diff;

    // Tie-break by configured mode
    for (const mode of tieBreakers) {
      const d = compareTieBreak(a, b, mode);
      if (d !== 0) return d;
    }

    // Final deterministic tie-break: sessionId
    return a.sessionId.localeCompare(b.sessionId);
  });
}

function getPriorityLevel(c: CharState): number {
  const { event, attention, priority, status } = c.session;

  if (!attention) return 0;

  if (event === "approval" || event === "stuck") return 4;

  if (event === "idle") {
    if (status === "waiting_on_user" || priority === "normal" || priority === null || priority === undefined) {
      return 3; // ? — agent asked something or normal idle
    }
    if (priority === "low") return 2; // done, no urgency
  }

  // running/tool with attention = working
  return 1;
}

function compareTieBreak(a: CharState, b: CharState, mode: string): number {
  switch (mode) {
    case "fifo":
      // Oldest waiting gets priority (fairness)
      return (a.lastUserTs || a.spawnedAt) - (b.lastUserTs || b.spawnedAt);
    case "lifo":
      // Newest gets priority (latest activity most relevant) — like alt-tab
      // Use mtime (always unique, ms-precision) as primary LIFO signal,
      // with lastUserTs as boost (user interaction > automatic activity)
      const aLifo = a.session.last_user_ts || a.session.mtime || a.spawnedAt;
      const bLifo = b.session.last_user_ts || b.session.mtime || b.spawnedAt;
      return bLifo - aLifo;
    case "lru":
      // Least recently used by user gets priority (neglected → surface it)
      return (a.lastUserTs || 0) - (b.lastUserTs || 0);
    case "freq": {
      // Frequency with session-active-time decay.
      // Uses time since char appeared on overlay (spawnedAt), not wall-clock time.
      // This ignores sleep/shutdown — only counts active session time.
      const now = Date.now() / 1000;
      const aActiveHours = Math.max(1, (now - a.spawnedAt / 1000) / 3600);
      const bActiveHours = Math.max(1, (now - b.spawnedAt / 1000) / 3600);
      const aScore = a.interactionCount / aActiveHours;
      const bScore = b.interactionCount / bActiveHours;
      return bScore - aScore; // highest score first
    }
    case "priority":
      // Already handled as primary sort, skip in tie-break
      return 0;
    default:
      return 0;
  }
}
