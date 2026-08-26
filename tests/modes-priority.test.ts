/**
 * Queue Priority Tests
 *
 * Verifies that computeModes correctly ranks sessions by priority level:
 *   Level 4: attention + event=approval/stuck (agent blocked)
 *   Level 3: attention + event=idle + normal/null priority or status=waiting_on_user
 *   Level 2: attention + event=idle + priority=low (task done)
 *   Level 1: attention + event=running/tool (working with attention)
 *   Level 0: no attention (shouldn't normally appear)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Priority Scoring", () => {
  const cfg = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1 });

  it("approval (level 4) beats idle-waiting (level 3)", () => {
    const approval = makeAttentionChar("approval");
    const waiting = makeAttentionChar("idle", { status: "waiting_on_user" });

    const result = computeModes([waiting, approval], cfg);

    // approval should get the single follow slot
    expect(result.get(approval.sessionId)?.mode).toBe("follow");
    expect(result.get(waiting.sessionId)?.mode).toBe("roam");
  });

  it("stuck (level 4) beats idle-waiting (level 3)", () => {
    const stuck = makeAttentionChar("stuck");
    const waiting = makeAttentionChar("idle", { status: "waiting_on_user" });

    const result = computeModes([waiting, stuck], cfg);

    expect(result.get(stuck.sessionId)?.mode).toBe("follow");
    expect(result.get(waiting.sessionId)?.mode).toBe("roam");
  });

  it("idle-waiting (level 3) beats idle-low (level 2)", () => {
    const waiting = makeAttentionChar("idle", { status: "waiting_on_user" });
    const low = makeAttentionChar("idle", { priority: "low" });

    const result = computeModes([low, waiting], cfg);

    expect(result.get(waiting.sessionId)?.mode).toBe("follow");
    expect(result.get(low.sessionId)?.mode).toBe("roam");
  });

  it("idle with null priority is level 3 (not level 2)", () => {
    const nullPriority = makeAttentionChar("idle", { priority: null });
    const low = makeAttentionChar("idle", { priority: "low" });

    const result = computeModes([low, nullPriority], cfg);

    expect(result.get(nullPriority.sessionId)?.mode).toBe("follow");
    expect(result.get(low.sessionId)?.mode).toBe("roam");
  });

  it("idle with priority=normal is level 3", () => {
    const normal = makeAttentionChar("idle", { priority: "normal" });
    const low = makeAttentionChar("idle", { priority: "low" });

    const result = computeModes([low, normal], cfg);

    expect(result.get(normal.sessionId)?.mode).toBe("follow");
    expect(result.get(low.sessionId)?.mode).toBe("roam");
  });

  it("idle-low (level 2) beats working (level 1)", () => {
    const low = makeAttentionChar("idle", { priority: "low" });
    const working = makeAttentionChar("running");

    const result = computeModes([working, low], cfg);

    expect(result.get(low.sessionId)?.mode).toBe("follow");
    expect(result.get(working.sessionId)?.mode).toBe("roam");
  });

  it("working with attention (level 1) beats no-attention (level 0)", () => {
    const working = makeAttentionChar("running");
    const noAttention = makeChar({ attention: false, event: "idle" });

    const result = computeModes([noAttention, working], cfg);

    expect(result.get(working.sessionId)?.mode).toBe("follow");
    expect(result.get(noAttention.sessionId)?.mode).toBe("roam");
  });

  it("full priority cascade: 4 > 3 > 2 > 1 > 0 in correct order", () => {
    // Only 1 follow slot — highest priority gets it, rest cascade
    const cfg5 = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1 });

    const level4 = makeAttentionChar("approval");
    const level3 = makeAttentionChar("idle", { status: "waiting_on_user" });
    const level2 = makeAttentionChar("idle", { priority: "low" });
    const level1 = makeAttentionChar("running");
    const level0 = makeChar({ attention: false, event: "idle" });

    // Pass in reverse order to prove sorting works
    const result = computeModes([level0, level1, level2, level3, level4], cfg5);

    expect(result.get(level4.sessionId)?.mode).toBe("follow");
    expect(result.get(level3.sessionId)?.mode).toBe("roam");
    expect(result.get(level2.sessionId)?.mode).toBe("revolve");
    expect(result.get(level1.sessionId)?.mode).toBe("hidden");
    expect(result.get(level0.sessionId)?.mode).toBe("hidden");
  });

  it("multiple level-4 sessions fill follow slots in order", () => {
    const cfg2 = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    const a = makeAttentionChar("approval");
    const b = makeAttentionChar("stuck");
    const c = makeAttentionChar("approval");

    const result = computeModes([c, a, b], cfg2);

    // All are level 4 — first 2 get follow, last gets roam
    const modes = [
      result.get(a.sessionId)?.mode,
      result.get(b.sessionId)?.mode,
      result.get(c.sessionId)?.mode,
    ];
    expect(modes.filter((m) => m === "follow")).toHaveLength(2);
    expect(modes.filter((m) => m === "roam")).toHaveLength(1);
  });
});

describe("Priority Edge Cases", () => {
  const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

  it("session with attention=false is level 0 regardless of event", () => {
    const noAttn = makeChar({ attention: false, event: "approval" });
    const attn = makeAttentionChar("idle", { priority: "low" });

    const result = computeModes([noAttn, attn], cfg);

    // attn (level 2) should rank higher than noAttn (level 0)
    expect(result.get(attn.sessionId)?.mode).toBe("follow");
  });

  it("tool event with attention is level 1 (same as running)", () => {
    const tool = makeAttentionChar("tool");
    const running = makeAttentionChar("running");

    // Both level 1 — should get equivalent treatment
    const result = computeModes([tool, running], cfg);
    const toolMode = result.get(tool.sessionId)?.mode;
    const runMode = result.get(running.sessionId)?.mode;

    // Both should be in follow (2 slots available)
    expect(toolMode).toBe("follow");
    expect(runMode).toBe("follow");
  });
});
