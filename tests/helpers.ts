/**
 * Test helpers — factories for building CharState and ModeConfig
 * with sensible defaults that can be overridden per-test.
 */

import type { Session } from "../ui/shared/types";
import type { CharState, ModeConfig } from "../ui/overlay/modes";
import { MODE_DEFAULTS } from "../ui/overlay/modes";

// ─── Session Factory ────────────────────────────────────────────────────────

let idCounter = 0;

export function makeSession(overrides: Partial<Session> = {}): Session {
  idCounter++;
  return {
    id: `test-${String(idCounter).padStart(3, "0")}`,
    source: "kiro-ide",
    name: `Test Session ${idCounter}`,
    workspace: "~/test",
    group: "",
    active: true,
    event: null,
    attention_source: null,
    attention: false,
    attention_reason: null,
    tool: null,
    file: null,
    tokens: 50000,
    maxTokens: 200000,
    mtime: Date.now() / 1000,
    character: "ghost",
    attention_since: null,
    on_overlay: false,
    pinned: false,
    muted: false,
    tool_ok: null,
    tool_result: null,
    prompt: null,
    description: null,
    status: null,
    priority: null,
    last_user_ts: null,
    interaction_count: 0,
    sub_agents: 0,
    sub_agent_names: [],
    ...overrides,
  };
}

// ─── CharState Factory ──────────────────────────────────────────────────────

export function makeChar(
  sessionOverrides: Partial<Session> = {},
  charOverrides: Partial<Omit<CharState, "session" | "sessionId">> = {}
): CharState {
  const session = makeSession(sessionOverrides);
  return {
    sessionId: session.id,
    session,
    currentMode: "hidden",
    spawnedAt: Date.now(),
    lastUserTs: session.last_user_ts || 0,
    interactionCount: session.interaction_count || 0,
    ...charOverrides,
  };
}

/**
 * Build a CharState with specific event/status/priority combo.
 * Shorthand for common test patterns.
 */
export function makeAttentionChar(
  event: string,
  opts: { priority?: string | null; status?: string | null; mtime?: number; last_user_ts?: number | null; attention?: boolean } = {}
): CharState {
  return makeChar({
    attention: opts.attention ?? true,
    event,
    priority: opts.priority ?? null,
    status: opts.status ?? null,
    mtime: opts.mtime ?? Date.now() / 1000,
    last_user_ts: opts.last_user_ts ?? null,
  });
}

// ─── Config Factory ─────────────────────────────────────────────────────────

export function makeConfig(overrides: Partial<ModeConfig> = {}): ModeConfig {
  return { ...MODE_DEFAULTS, ...overrides };
}

// ─── Reset counter between test files ───────────────────────────────────────

export function resetIds(): void {
  idCounter = 0;
}
