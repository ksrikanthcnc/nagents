/**
 * config-schema.ts — Single source of truth for all overlay settings.
 *
 * Defines type, bounds, options, defaults, and descriptions.
 * Used by:
 * - Settings UI (auto-generates form from this schema)
 * - Validation (clamp values to bounds on save)
 * - Config docs (descriptions serve as inline help)
 */

export type SettingType = "number" | "string" | "boolean" | "select";

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  description: string;
  section: string;
  /** Default value */
  default: unknown;
  /** For numbers: min bound */
  min?: number;
  /** For numbers: max bound */
  max?: number;
  /** For numbers: step increment */
  step?: number;
  /** For select: available options */
  options?: { value: string; label: string }[];
  /** If true, setting is hidden in UI (advanced) */
  advanced?: boolean;
}

export const CONFIG_SCHEMA: SettingDef[] = [
  // ─── Mode ─────────────────────────────────────────────────────────────
  {
    key: "overlay_mode", label: "Overlay Mode", type: "select", section: "mode",
    description: "Full: all features. Lite: 1 char, slow follow, minimal energy. Off: BSB only.",
    default: "full",
    options: [
      { value: "full", label: "Full" },
      { value: "lite", label: "Lite" },
      { value: "off", label: "Off (BSB only)" },
    ],
  },

  // ─── Overlay ──────────────────────────────────────────────────────────
  {
    key: "max_followers", label: "Followers", type: "number", section: "overlay",
    description: "Max chars following your cursor. Pinned chars are extra (exempt from this limit).",
    default: 2, min: 0, max: 10,
  },
  {
    key: "max_roamers", label: "Roamers", type: "number", section: "overlay",
    description: "Max chars wandering freely on screen.",
    default: 3, min: 0, max: 10,
  },
  {
    key: "max_dots", label: "Dots", type: "number", section: "overlay",
    description: "Max chars orbiting cursor as small dots.",
    default: 5, min: 0, max: 20,
  },
  {
    key: "char_size", label: "Char Size", type: "number", section: "overlay",
    description: "Base character size in pixels. All scaling is proportional.",
    default: 44, min: 24, max: 80,
  },
  {
    key: "connectors", label: "Connectors", type: "select", section: "overlay",
    description: "Show SVG lines connecting grouped characters.",
    default: "true",
    options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }],
  },
  {
    key: "working_mode", label: "Working Mode", type: "select", section: "overlay",
    description: "How working sessions (running/tool) are displayed. Roam: skip follow, always roam. Queue: normal waterfall.",
    default: "roam",
    options: [{ value: "roam", label: "Roam" }, { value: "queue", label: "Queue" }],
  },

  // ─── Physics ──────────────────────────────────────────────────────────
  {
    key: "physics_fps", label: "Physics FPS", type: "number", section: "physics",
    description: "Render loop frequency. Lower = less energy. 60=smooth, 30=fine, 10=minimal.",
    default: 60, min: 1, max: 120,
  },
  {
    key: "cursor_fps", label: "Cursor FPS", type: "number", section: "physics",
    description: "How often cursor position is polled (HTTP call). Lower = less energy but laggier follow.",
    default: 10, min: 0.2, max: 30, step: 0.5,
  },
  {
    key: "cursor_smoothing", label: "Cursor Smoothing", type: "number", section: "physics",
    description: "Lerp factor for cursor interpolation. Lower = smoother/slower drift.",
    default: 0.12, min: 0.01, max: 0.5, step: 0.01,
  },
  {
    key: "follow_strength", label: "Follow Strength", type: "number", section: "physics",
    description: "How strongly chars are pulled toward cursor. Lower = slower, dreamier follow.",
    default: 0.008, min: 0.001, max: 0.2, step: 0.001,
  },
  {
    key: "roam_strength", label: "Roam Strength", type: "number", section: "physics",
    description: "How strongly roaming chars move toward their random targets.",
    default: 0.008, min: 0.002, max: 0.05, step: 0.002,
  },
  {
    key: "collision_distance", label: "Collision Distance", type: "number", section: "physics",
    description: "Min distance between chars (pixels). 0 = no collision detection (saves energy).",
    default: 100, min: 0, max: 200,
  },
  {
    key: "revolve_radius", label: "Orbit Radius", type: "number", section: "physics",
    description: "Distance of dot orbit from cursor.",
    default: 40, min: 20, max: 150,
  },
  {
    key: "revolve_speed", label: "Orbit Speed", type: "number", section: "physics",
    description: "How fast dots orbit (radians per frame).",
    default: 0.015, min: 0.005, max: 0.05, step: 0.005, advanced: true,
  },
  {
    key: "dot_scale", label: "Dot Scale", type: "number", section: "physics",
    description: "Size multiplier for dot-mode chars. 0.5 = half size.",
    default: 0.5, min: 0.2, max: 1, step: 0.05,
  },
  {
    key: "shrink_after_min", label: "Shrink After (min)", type: "number", section: "physics",
    description: "Minutes before non-attention roamers shrink to dot. 0 = never shrink.",
    default: 5, min: 0, max: 60,
  },
  {
    key: "min_cursor_distance", label: "Min Cursor Dist", type: "number", section: "physics",
    description: "Minimum distance followers keep from cursor.",
    default: 80, min: 20, max: 200, advanced: true,
  },

  // ─── Ordering ─────────────────────────────────────────────────────────
  {
    key: "follower_mode", label: "Follower Order", type: "select", section: "ordering",
    description: "How to rank sessions for follow slots. LIFO=newest first, FIFO=oldest first.",
    default: "lifo",
    options: [
      { value: "lifo", label: "LIFO (newest)" },
      { value: "fifo", label: "FIFO (oldest)" },
      { value: "lru", label: "LRU (neglected)" },
      { value: "priority,lifo", label: "Priority+LIFO" },
      { value: "round_robin", label: "Round Robin" },
    ],
  },
  {
    key: "round_robin_sec", label: "Rotate Sec", type: "number", section: "ordering",
    description: "Seconds between round-robin rotations.",
    default: 3, min: 1, max: 60,
  },
  {
    key: "group_as_one", label: "Group as One", type: "select", section: "ordering",
    description: "Merge same-group sessions into one visual unit.",
    default: "false",
    options: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }],
  },
  {
    key: "group_display", label: "Group Display", type: "select", section: "ordering",
    description: "How grouped sessions are shown. Cluster: orbit center char. Single: one representative.",
    default: "cluster",
    options: [{ value: "cluster", label: "Cluster" }, { value: "single", label: "Single" }],
  },
  {
    key: "pin_counts_toward_max", label: "Pin Counts", type: "select", section: "ordering",
    description: "Whether pinned chars consume a follower slot or are always extra.",
    default: "false",
    options: [{ value: "false", label: "Extra (exempt)" }, { value: "true", label: "Counts toward max" }],
  },

  // ─── BSB ──────────────────────────────────────────────────────────────
  {
    key: "bsb_layout", label: "Layout", type: "select", section: "bsb",
    description: "BSB arrangement. Horizontal: one row. Vertical: one column. Grid: wrapping.",
    default: "grid",
    options: [
      { value: "grid", label: "Grid" },
      { value: "horizontal", label: "Horizontal" },
      { value: "vertical", label: "Vertical" },
    ],
  },
  {
    key: "bsb_max_chars", label: "Max Chars", type: "number", section: "bsb",
    description: "Maximum characters shown in BSB. Overflow shows +N badge.",
    default: 5, min: 1, max: 20,
  },
  {
    key: "bsb_opacity", label: "BG Opacity", type: "number", section: "bsb",
    description: "Background opacity for BSB window. 0=transparent, 1=solid dark.",
    default: 0, min: 0, max: 1, step: 0.1,
  },

  // ─── Display ──────────────────────────────────────────────────────────
  {
    key: "panel_mode", label: "Panel Mode", type: "select", section: "display",
    description: "Panel density. Compact: smaller chars, tighter spacing.",
    default: "compact",
    options: [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }],
  },
  {
    key: "panel_group_sort", label: "Group Sort", type: "select", section: "display",
    description: "Sub-group ordering. Alpha: A-Z. Recency: most recently active group first.",
    default: "recency",
    options: [{ value: "alpha", label: "Alphabetical" }, { value: "recency", label: "Recency" }],
  },
  {
    key: "font_size_group", label: "Group Font", type: "number", section: "display",
    description: "Font size for group/source labels (px).",
    default: 9, min: 6, max: 16,
  },
  {
    key: "font_size_title", label: "Title Font", type: "number", section: "display",
    description: "Font size for session title (px).",
    default: 10, min: 6, max: 16,
  },
  {
    key: "font_size_action", label: "Action Font", type: "number", section: "display",
    description: "Font size for action/status text (px).",
    default: 10, min: 6, max: 16,
  },
];

/** Get schema entries for a section. */
export function getSection(section: string): SettingDef[] {
  return CONFIG_SCHEMA.filter(s => s.section === section && !s.advanced);
}

/** Get all section names in order. */
export function getSections(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of CONFIG_SCHEMA) {
    if (!seen.has(s.section)) {
      seen.add(s.section);
      result.push(s.section);
    }
  }
  return result;
}

/** Clamp a numeric value to its schema bounds. */
export function clampValue(key: string, value: number): number {
  const def = CONFIG_SCHEMA.find(s => s.key === key);
  if (!def || def.type !== "number") return value;
  if (def.min !== undefined && value < def.min) return def.min;
  if (def.max !== undefined && value > def.max) return def.max;
  return value;
}

/** Get the default value for a setting. */
export function getDefault(key: string): unknown {
  const def = CONFIG_SCHEMA.find(s => s.key === key);
  return def?.default;
}
