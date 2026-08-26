/**
 * Integration Tests — HTTP API → State → Mode Assignment
 *
 * These tests push sessions/events via the HTTP API and verify the resulting
 * state. They test the full pipeline: HTTP → Rust state store → overlay reads.
 *
 * Requires the nagents server running on port 3335.
 * Run with: npx vitest --run tests/integration.test.ts
 *
 * NOTE: These interact with the LIVE server. They use test- prefixed IDs
 * and clean up after themselves via /test/clear.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { computeModes, MODE_DEFAULTS } from "../ui/overlay/modes";
import type { CharState, ModeConfig } from "../ui/overlay/modes";
import type { Session, StateSnapshot } from "../ui/shared/types";

const BASE = "http://127.0.0.1:3335";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getState(): Promise<StateSnapshot> {
  const resp = await fetch(`${BASE}/state`);
  if (!resp.ok) throw new Error(`GET /state failed: ${resp.status}`);
  return resp.json();
}

async function getConfig(): Promise<any> {
  const resp = await fetch(`${BASE}/config`);
  if (!resp.ok) throw new Error(`GET /config failed: ${resp.status}`);
  return resp.json();
}

async function pushSessions(sessions: Partial<Session>[]): Promise<void> {
  const full = sessions.map((s, i) => ({
    id: s.id || `test-int-${Date.now()}-${i}`,
    source: s.source || "kiro-ide",
    name: s.name || `Integration Test ${i}`,
    workspace: s.workspace || "~/test",
    group: s.group || "test-integration",
    active: s.active ?? true,
    event: s.event || null,
    attention_source: s.attention_source ?? null,
    attention: s.attention ?? false,
    tool: s.tool || null,
    file: s.file || null,
    tokens: s.tokens ?? 50000,
    maxTokens: s.maxTokens ?? 200000,
    mtime: s.mtime ?? Date.now() / 1000,
    character: s.character || "ghost",
    attention_since: null,
    on_overlay: false,
    pinned: s.pinned ?? false,
    muted: s.muted ?? false,
    tool_ok: null,
    tool_result: null,
    prompt: null,
    description: null,
    status: null,
    priority: s.priority || null,
    last_user_ts: s.last_user_ts ?? null,
    interaction_count: s.interaction_count ?? 0,
    sub_agents: 0,
    sub_agent_names: [],
    workers: [],
  }));

  const resp = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(full),
  });
  if (!resp.ok) throw new Error(`POST /sessions failed: ${resp.status}`);
}

async function pushEvent(update: Record<string, any>): Promise<void> {
  const resp = await fetch(`${BASE}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!resp.ok) throw new Error(`POST /event failed: ${resp.status}`);
}

async function clearTestSessions(): Promise<void> {
  await fetch(`${BASE}/test/clear`);
  // Also push empty batch for test-integration source to GC our sessions
  try {
    const state = await getState();
    const testSessions = state.sessions.filter(
      s => s.id.startsWith("test-int-") || s.group === "test-integration"
    );
    if (testSessions.length > 0) {
      // Push empty batch for the source to trigger GC — but since all test
      // sessions use same source as real ones, we can't easily GC them.
      // Instead we'll just verify state without cleaning up (they'll be GC'd
      // when the real scanner next reports for that source).
    }
  } catch {}
}

function sessionsToCharStates(sessions: Session[]): CharState[] {
  return sessions.map(s => ({
    sessionId: s.id,
    session: s,
    currentMode: "hidden" as const,
    spawnedAt: Date.now(),
    lastUserTs: s.last_user_ts ?? 0,
    interactionCount: s.interaction_count ?? 0,
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Server Connectivity", () => {
  it("health check", async () => {
    const resp = await fetch(`${BASE}/health`);
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.status).toBe("ok");
  });

  it("GET /state returns valid snapshot", async () => {
    const state = await getState();
    expect(state.sessions).toBeDefined();
    expect(Array.isArray(state.sessions)).toBe(true);
    expect(state.count).toBeGreaterThanOrEqual(0);
    expect(state.timestamp).toBeGreaterThan(0);
  });

  it("GET /config returns overlay settings", async () => {
    const cfg = await getConfig();
    expect(cfg.overlay).toBeDefined();
    expect(cfg.overlay.max_followers).toBeGreaterThanOrEqual(0);
    expect(cfg.overlay.working_mode).toBeDefined();
  });
});

describe("Working Mode: live state verification", () => {
  it("working sessions (running/tool, no attention) get roam with working_mode=roam", async () => {
    const state = await getState();
    const cfg = await getConfig();
    const overlay = cfg.overlay;

    // Find working sessions in live state
    const workingSessions = state.sessions.filter(
      s => s.active && !s.attention && (s.event === "running" || s.event === "tool")
    );

    if (workingSessions.length === 0) {
      console.log("  (no working sessions currently active, skipping live check)");
      return;
    }

    // Run computeModes on ALL active sessions with live config
    const allActive = state.sessions.filter(s => s.active);
    const charStates = sessionsToCharStates(allActive);

    const modeCfg: ModeConfig = {
      max_followers: overlay.max_followers ?? MODE_DEFAULTS.max_followers,
      max_roamers: overlay.max_roamers ?? MODE_DEFAULTS.max_roamers,
      max_dots: overlay.max_dots ?? MODE_DEFAULTS.max_dots,
      follower_mode: overlay.follower_mode ?? MODE_DEFAULTS.follower_mode,
      round_robin_sec: overlay.round_robin_sec ?? MODE_DEFAULTS.round_robin_sec,
      pin_counts_toward_max: overlay.pin_counts_toward_max ?? false,
      group_as_one: overlay.group_as_one ?? false,
      group_display: overlay.group_display || "cluster",
      working_mode: overlay.working_mode || "roam",
    };

    const assignments = computeModes(charStates, modeCfg);

    // With working_mode=roam, working sessions should NOT be in follow
    for (const ws of workingSessions) {
      const assignment = assignments.get(ws.id);
      if (!assignment) continue; // might be muted/dropped
      if (modeCfg.working_mode === "roam") {
        expect(assignment.mode).not.toBe("follow");
      }
    }
  });

  it("working sessions fill roam before dot before hidden", async () => {
    const state = await getState();
    const cfg = await getConfig();
    const overlay = cfg.overlay;

    const allActive = state.sessions.filter(s => s.active);
    const charStates = sessionsToCharStates(allActive);

    const modeCfg: ModeConfig = {
      max_followers: overlay.max_followers ?? 2,
      max_roamers: overlay.max_roamers ?? 3,
      max_dots: overlay.max_dots ?? 5,
      follower_mode: overlay.follower_mode ?? "lifo",
      round_robin_sec: overlay.round_robin_sec ?? 3,
      pin_counts_toward_max: overlay.pin_counts_toward_max ?? false,
      group_as_one: overlay.group_as_one ?? false,
      group_display: overlay.group_display || "cluster",
      working_mode: overlay.working_mode || "roam",
    };

    const assignments = computeModes(charStates, modeCfg);

    // Verify waterfall integrity: if any session is in dot, roam must be full
    const modes = Array.from(assignments.values()).map(a => a.mode);
    const roamCount = modes.filter(m => m === "roam").length;
    const dotCount = modes.filter(m => m === "revolve").length;
    const hiddenCount = modes.filter(m => m === "hidden").length;

    if (dotCount > 0) {
      expect(roamCount).toBe(modeCfg.max_roamers);
    }
    if (hiddenCount > 0) {
      expect(dotCount).toBe(modeCfg.max_dots);
    }
  });
});

describe("Event Push → State Update", () => {
  const testId = `test-intpin-${Date.now()}`;

  afterAll(async () => {
    await clearTestSessions();
  });

  it("POST /event creates minimal session if unknown ID", async () => {
    await pushEvent({ session_id: testId, event: "running" });

    // Wait for state to settle
    await new Promise(r => setTimeout(r, 100));

    const state = await getState();
    const session = state.sessions.find(s => s.id === testId);
    expect(session).toBeDefined();
    expect(session!.event).toBe("running");
  });

  it("POST /event updates existing session event", async () => {
    await pushEvent({ session_id: testId, event: "idle", status: "waiting_on_user" });
    await new Promise(r => setTimeout(r, 100));

    const state = await getState();
    const session = state.sessions.find(s => s.id === testId);
    expect(session).toBeDefined();
    expect(session!.event).toBe("idle");
    expect(session!.status).toBe("waiting_on_user");
  });

  it("POST /event can set pinned", async () => {
    await pushEvent({ session_id: testId, pinned: true });
    await new Promise(r => setTimeout(r, 100));

    const state = await getState();
    const session = state.sessions.find(s => s.id === testId);
    expect(session!.pinned).toBe(true);
  });

  it("POST /event can set muted (and clear pinned)", async () => {
    await pushEvent({ session_id: testId, muted: true, pinned: false });
    await new Promise(r => setTimeout(r, 100));

    const state = await getState();
    const session = state.sessions.find(s => s.id === testId);
    expect(session!.muted).toBe(true);
    expect(session!.pinned).toBe(false);
  });
});

describe("Mode Assignment with Live Config", () => {
  it("computeModes matches what overlay would produce for current state", async () => {
    const state = await getState();
    const cfg = await getConfig();
    const overlay = cfg.overlay;

    const allActive = state.sessions.filter(s => s.active);
    if (allActive.length === 0) return; // nothing to test

    const charStates = sessionsToCharStates(allActive);

    const modeCfg: ModeConfig = {
      max_followers: overlay.max_followers ?? 2,
      max_roamers: overlay.max_roamers ?? 3,
      max_dots: overlay.max_dots ?? 5,
      follower_mode: overlay.follower_mode ?? "lifo",
      round_robin_sec: overlay.round_robin_sec ?? 3,
      pin_counts_toward_max: overlay.pin_counts_toward_max ?? false,
      group_as_one: overlay.group_as_one ?? false,
      group_display: overlay.group_display || "cluster",
      working_mode: overlay.working_mode || "roam",
    };

    const assignments = computeModes(charStates, modeCfg);

    // Every active session should have an assignment
    for (const s of allActive) {
      const a = assignments.get(s.id);
      expect(a).toBeDefined();
      expect(["follow", "roam", "revolve", "hidden"]).toContain(a!.mode);
    }

    // Verify slot limits
    const followCount = Array.from(assignments.values()).filter(
      a => a.mode === "follow" && !allActive.find(s => s.id === a.sessionId)?.pinned
    ).length;
    const pinnedFollowCount = Array.from(assignments.values()).filter(
      a => a.mode === "follow" && allActive.find(s => s.id === a.sessionId)?.pinned
    ).length;

    if (!modeCfg.pin_counts_toward_max) {
      // Normal follow count should not exceed max_followers
      expect(followCount).toBeLessThanOrEqual(modeCfg.max_followers);
    } else {
      expect(followCount + pinnedFollowCount).toBeLessThanOrEqual(modeCfg.max_followers);
    }
  });
});
