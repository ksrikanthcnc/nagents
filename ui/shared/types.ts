/**
 * Shared types — mirrors the Rust backend Session/State/Config schemas.
 * This is the single source of truth for frontend TypeScript code.
 */

// ─── Sources ────────────────────────────────────────────────────────────────

/** Known source identifiers. Extensible — new sources just add a string. */
export type Source = "kiro-ide" | "kiro-cli" | "crew" | string;

// ─── Session ────────────────────────────────────────────────────────────────

/** A single agent session (from Rust state). */
export interface Session {
  id: string;
  source: Source;
  name: string;
  workspace: string;
  group: string;
  active: boolean;
  event: string | null;
  /** Source-provided attention (null = let core rules decide). */
  attention_source: boolean | null;
  /** Computed attention (hybrid: source + core rules). */
  attention: boolean;
  attention_reason: string | null;
  tool: string | null;
  file: string | null;
  tokens: number;
  maxTokens: number;
  mtime: number;
  character: string | null;
  /** Epoch when attention was first set. */
  attention_since: number | null;
  /** Is this session currently on the overlay? */
  on_overlay: boolean;
}

// ─── State Snapshot ─────────────────────────────────────────────────────────

/** Full state from GET /state or get_state command. */
export interface StateSnapshot {
  sessions: Session[];
  count: number;
  timestamp: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface SourceConfig {
  scanner: string | null;
  interval_sec: number;
  hook: boolean;
  enabled: boolean;
}

export interface AttentionRules {
  idle_threshold_sec: number;
  tool_stuck_sec: number;
  running_stuck_sec: number;
  waiting_statuses: string[];
}

export interface OverlayConfig {
  follow_strength: number;
  roam_strength: number;
  roam_max_speed: number;
  follow_max_speed: number;
  min_cursor_distance: number;
  revolve_radius: number;
  revolve_speed: number;
  shrink_after_min: number;
}

export interface Config {
  sources: Record<string, SourceConfig>;
  attention_rules: AttentionRules;
  panel_order: string[];
  characters: Record<string, string>;
  overlay: OverlayConfig;
  http_port: number;
  log_level: string;
}

// ─── Panel Grouping ─────────────────────────────────────────────────────────

/** A group of sessions displayed together in the panel. */
export interface SessionGroup {
  id: string;
  label: string;
  source: Source;
  sessions: Session[];
}

// ─── Cursor Position ────────────────────────────────────────────────────────

export interface CursorPosition {
  x: number;
  y: number;
}
