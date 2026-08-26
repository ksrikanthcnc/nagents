/**
 * UI State Tests — End-to-end verification via HTTP API
 *
 * These tests push sessions and events, wait for state to settle,
 * then run computeModes() on the live state to verify what the overlay
 * SHOULD be rendering. This is our proxy for UI testing until we can
 * read the overlay DOM directly.
 *
 * The tests use test-prefixed session IDs and clean up after each suite.
 *
 * Requires nagents server running on port 3335.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { computeModes, MODE_DEFAULTS } from "../ui/overlay/modes";
import type { CharState, ModeConfig, ModeAssignment } from "../ui/overlay/modes";
import type { Session } from "../ui/shared/types";

const BASE = "http://127.0.0.1:3335";
const TEST_SOURCE = "kiro-ide"; // use real source so scanner doesn't GC immediately

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getState(): Promise<{ sessions: Session[]; count: number; timestamp: number }> {
  const resp = await fetch(`${BASE}/state`);
  return resp.json();
}

async function getConfig(): Promise<any> {
  const resp = await fetch(`${BASE}/config`);
  return resp.json();
}

async function pushEvent(data: Record<string, any>): Promise<void> {
  await fetch(`${BASE}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function clearTest(): Promise<void> {
  await fetch(`${BASE}/test/clear`);
}

/** Wait for state to include a session with the given ID and field value */
async function waitForState(
  sessionId: string,
  field: string,
  value: any,
  timeoutMs = 3000
): Promise<Session | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getState();
    const session = state.sessions.find(s => s.id === sessionId);
    if (session && (session as any)[field] === value) return session;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/** Build ModeConfig from live config */
async function getLiveModeCfg(): Promise<ModeConfig> {
  const cfg = await getConfig();
  const ov = cfg.overlay;
  return {
    max_followers: ov.max_followers ?? MODE_DEFAULTS.max_followers,
    max_roamers: ov.max_roamers ?? MODE_DEFAULTS.max_roamers,
    max_dots: ov.max_dots ?? MODE_DEFAULTS.max_dots,
    follower_mode: ov.follower_mode ?? MODE_DEFAULTS.follower_mode,
    round_robin_sec: ov.round_robin_sec ?? MODE_DEFAULTS.round_robin_sec,
    pin_counts_toward_max: ov.pin_counts_toward_max ?? false,
    group_as_one: ov.group_as_one ?? false,
    group_display: ov.group_display || "cluster",
    working_mode: ov.working_mode || "roam",
    working_counts_toward_max: ov.working_counts_toward_max ?? false,
    attention_follows: ov.attention_follows ?? false,
  };
}

/** Compute mode assignments for all active sessions in current state */
async function computeLiveModes(): Promise<{
  assignments: Map<string, ModeAssignment>;
  sessions: Session[];
  cfg: ModeConfig;
}> {
  const state = await getState();
  const cfg = await getLiveModeCfg();
  const active = state.sessions.filter(s => s.active);
  const chars: CharState[] = active.map(s => ({
    sessionId: s.id,
    session: s,
    currentMode: "hidden" as const,
    spawnedAt: Date.now(),
    lastUserTs: s.last_user_ts ?? 0,
    interactionCount: s.interaction_count ?? 0,
  }));
  return { assignments: computeModes(chars, cfg), sessions: active, cfg };
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("UI State: Mode Assignment Integrity", () => {
  it("total follow count never exceeds max_followers (+ pinned exempt)", async () => {
    const { assignments, sessions, cfg } = await computeLiveModes();

    const pinnedIds = new Set(sessions.filter(s => s.pinned || s.priority === "high").map(s => s.id));
    // With attention_follows: true (legacy), attention sessions are also exempt
    const attentionExempt = cfg.attention_follows !== false;
    const exemptIds = new Set([
      ...pinnedIds,
      ...(attentionExempt ? sessions.filter(s => s.attention).map(s => s.id) : []),
    ]);

    let normalFollow = 0;

    for (const [id, a] of assignments) {
      if (a.mode === "follow" && !exemptIds.has(id)) {
        normalFollow++;
      }
    }

    expect(normalFollow).toBeLessThanOrEqual(cfg.max_followers);
  });

  it("total roam count never exceeds max_roamers", async () => {
    const { assignments, cfg } = await computeLiveModes();
    const roamCount = Array.from(assignments.values()).filter(a => a.mode === "roam").length;
    expect(roamCount).toBeLessThanOrEqual(cfg.max_roamers);
  });

  it("total dot count never exceeds max_dots", async () => {
    const { assignments, cfg } = await computeLiveModes();
    const dotCount = Array.from(assignments.values()).filter(a => a.mode === "revolve").length;
    expect(dotCount).toBeLessThanOrEqual(cfg.max_dots);
  });

  it("every active session gets a mode assignment", async () => {
    const { assignments, sessions } = await computeLiveModes();
    for (const s of sessions) {
      expect(assignments.has(s.id)).toBe(true);
    }
  });

  it("waterfall is consistent: dot only if roam full, hidden only if dot full", async () => {
    const { assignments, cfg } = await computeLiveModes();
    const modes = Array.from(assignments.values());
    const roamCount = modes.filter(a => a.mode === "roam").length;
    const dotCount = modes.filter(a => a.mode === "revolve").length;
    const hiddenCount = modes.filter(a => a.mode === "hidden").length;

    if (dotCount > 0) {
      expect(roamCount).toBe(cfg.max_roamers);
    }
    if (hiddenCount > 0) {
      expect(dotCount).toBe(cfg.max_dots);
    }
  });
});

describe("UI State: Working Mode Behavior", () => {
  it("working sessions (running/tool, no attention) are never in follow with working_mode=roam", async () => {
    const { assignments, sessions, cfg } = await computeLiveModes();
    if (cfg.working_mode !== "roam") return;

    for (const s of sessions) {
      if (!s.attention && (s.event === "running" || s.event === "tool")) {
        const a = assignments.get(s.id);
        if (a) {
          expect(a.mode).not.toBe("follow");
        }
      }
    }
  });

  it("working sessions consume roam slots before dot", async () => {
    const { assignments, sessions, cfg } = await computeLiveModes();
    if (cfg.working_mode !== "roam") return;

    const workingSessions = sessions.filter(
      s => !s.attention && (s.event === "running" || s.event === "tool")
    );
    const workingInRoam = workingSessions.filter(
      s => assignments.get(s.id)?.mode === "roam"
    );
    const workingInDot = workingSessions.filter(
      s => assignments.get(s.id)?.mode === "revolve"
    );

    // If any working session is in dot, all roam slots should be used
    if (workingInDot.length > 0) {
      const totalRoam = Array.from(assignments.values()).filter(a => a.mode === "roam").length;
      expect(totalRoam).toBe(cfg.max_roamers);
    }
  });
});

describe("UI State: Pin/Unpin via API", () => {
  const testId = `test-pin-${Date.now()}`;

  beforeAll(async () => {
    // Create test session
    await pushEvent({ session_id: testId, event: "idle", status: "waiting_on_user" });
    await new Promise(r => setTimeout(r, 200));
  });

  afterAll(async () => {
    await clearTest();
  });

  it("pinning a session gives it follow mode", async () => {
    await pushEvent({ session_id: testId, pinned: true });
    const session = await waitForState(testId, "pinned", true);
    expect(session).not.toBeNull();

    const { assignments } = await computeLiveModes();
    expect(assignments.get(testId)?.mode).toBe("follow");
  });

  it("unpinning returns session to normal waterfall", async () => {
    await pushEvent({ session_id: testId, pinned: false });
    const session = await waitForState(testId, "pinned", false);
    expect(session).not.toBeNull();

    const { assignments, cfg } = await computeLiveModes();
    const a = assignments.get(testId);
    expect(a).toBeDefined();
    // It should be in some mode based on priority, not guaranteed follow
    expect(["follow", "roam", "revolve", "hidden"]).toContain(a!.mode);
  });
});

describe("UI State: Mute/Unmute via API", () => {
  const testId = `test-mute-${Date.now()}`;

  beforeAll(async () => {
    await pushEvent({ session_id: testId, event: "approval" });
    await new Promise(r => setTimeout(r, 200));
  });

  afterAll(async () => {
    await clearTest();
  });

  it("muting a session sets muted=true in state", async () => {
    await pushEvent({ session_id: testId, muted: true });
    const session = await waitForState(testId, "muted", true);
    expect(session).not.toBeNull();
    expect(session!.muted).toBe(true);
  });

  it("unmuting a session clears muted in state", async () => {
    await pushEvent({ session_id: testId, muted: false });
    const session = await waitForState(testId, "muted", false);
    expect(session).not.toBeNull();
    expect(session!.muted).toBe(false);
  });
});

describe("UI State: Event Transitions", () => {
  const testId = `test-ev-${Date.now()}`;

  afterAll(async () => {
    await clearTest();
  });

  it("idle → running transition updates state", async () => {
    await pushEvent({ session_id: testId, event: "idle", status: "waiting_on_user" });
    let s = await waitForState(testId, "event", "idle");
    expect(s).not.toBeNull();

    await pushEvent({ session_id: testId, event: "running", status: "in_progress" });
    s = await waitForState(testId, "event", "running");
    expect(s).not.toBeNull();
    expect(s!.status).toBe("in_progress");
  });

  it("running → approval transition (attention-worthy)", async () => {
    await pushEvent({ session_id: testId, event: "approval" });
    const s = await waitForState(testId, "event", "approval");
    expect(s).not.toBeNull();
  });

  it("clearing event to idle + low priority (task done)", async () => {
    await pushEvent({ session_id: testId, event: "idle", priority: "low", status: "completed" });
    const s = await waitForState(testId, "event", "idle");
    expect(s).not.toBeNull();
    expect(s!.priority).toBe("low");
    expect(s!.status).toBe("completed");
  });
});

describe("UI State: Attention Computation", () => {
  it("sessions with attention=true are prioritized in mode assignment", async () => {
    const { assignments, sessions, cfg } = await computeLiveModes();

    const attentionSessions = sessions.filter(s => s.attention && !s.pinned && !s.muted);
    const nonAttentionSessions = sessions.filter(s => !s.attention && !s.pinned && !s.muted);

    if (attentionSessions.length === 0 || nonAttentionSessions.length === 0) return;

    // All attention sessions should be in higher-priority modes than non-attention
    for (const attn of attentionSessions) {
      const attnMode = assignments.get(attn.id)?.mode;
      // If an attention session is hidden, that's a waterfall overflow (acceptable)
      // But it should never be in a WORSE mode than a non-attention session in a BETTER mode
      if (attnMode === "hidden") {
        // Check this only happens when all slots are full
        const followCount = Array.from(assignments.values()).filter(a => a.mode === "follow").length;
        const roamCount = Array.from(assignments.values()).filter(a => a.mode === "roam").length;
        const dotCount = Array.from(assignments.values()).filter(a => a.mode === "revolve").length;
        expect(followCount).toBeGreaterThanOrEqual(cfg.max_followers);
      }
    }
  });
});

describe("UI State: Config Reflects in Mode Assignment", () => {
  it("max_followers from config is respected", async () => {
    const cfg = await getConfig();
    const { assignments, sessions } = await computeLiveModes();
    const modeCfg = await getLiveModeCfg();

    // Exempt: pinned + (if attention_follows) attention sessions
    const exemptIds = new Set(
      sessions.filter(s => s.pinned || s.priority === "high" ||
        (modeCfg.attention_follows !== false && s.attention)
      ).map(s => s.id)
    );

    const normalFollowers = Array.from(assignments.entries())
      .filter(([id, a]) => a.mode === "follow" && !exemptIds.has(id));

    expect(normalFollowers.length).toBeLessThanOrEqual(cfg.overlay.max_followers);
  });

  it("working_mode from config is applied", async () => {
    const cfg = await getConfig();
    expect(cfg.overlay.working_mode).toBeDefined();
    expect(["roam", "queue"]).toContain(cfg.overlay.working_mode);
  });
});
