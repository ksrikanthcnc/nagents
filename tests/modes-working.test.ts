/**
 * Working Mode Tests
 *
 * working_mode controls how "working" sessions (event=running/tool, no attention) are placed:
 *   - "roam": skip follow entirely, go directly to roam→dot→hidden
 *   - "queue": normal waterfall (can get follow slots like any other session)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("working_mode = roam (default)", () => {
  it("working session (running, no attention) skips follow, goes to roam", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "roam" });

    // Working: event=running, attention=false (normal active session)
    const working = makeChar({ event: "running", attention: false });

    const result = computeModes([working], cfg);
    expect(result.get(working.sessionId)?.mode).toBe("roam");
  });

  it("working session (tool, no attention) skips follow, goes to roam", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "roam" });

    const tooling = makeChar({ event: "tool", attention: false });

    const result = computeModes([tooling], cfg);
    expect(result.get(tooling.sessionId)?.mode).toBe("roam");
  });

  it("working session with attention=true is NOT treated as working (uses normal waterfall)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, working_mode: "roam" });

    // Has attention → not working mode path, uses priority waterfall
    const attnRunning = makeChar({ event: "running", attention: true });

    const result = computeModes([attnRunning], cfg);
    // Level 1 priority, goes through normal waterfall, gets follow
    expect(result.get(attnRunning.sessionId)?.mode).toBe("follow");
  });

  it("working sessions fill roam→dot→hidden (never follow)", () => {
    const cfg = makeConfig({ max_followers: 5, max_roamers: 2, max_dots: 1, working_mode: "roam", working_counts_toward_max: true });

    const workers = Array.from({ length: 4 }, () =>
      makeChar({ event: "running", attention: false })
    );

    const result = computeModes(workers, cfg);
    const modes = workers.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "follow")).toHaveLength(0);
    expect(modes.filter((m) => m === "roam")).toHaveLength(2);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(1);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(1);
  });

  it("mix of working + attention: attention gets follow, working gets roam", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, working_mode: "roam" });

    const attn1 = makeAttentionChar("approval");
    const attn2 = makeAttentionChar("idle", { status: "waiting_on_user" });
    const work1 = makeChar({ event: "running", attention: false });
    const work2 = makeChar({ event: "tool", attention: false });

    const result = computeModes([work1, attn1, work2, attn2], cfg);

    // Attention sessions get follow
    expect(result.get(attn1.sessionId)?.mode).toBe("follow");
    expect(result.get(attn2.sessionId)?.mode).toBe("follow");
    // Working sessions skip to roam
    expect(result.get(work1.sessionId)?.mode).toBe("roam");
    expect(result.get(work2.sessionId)?.mode).toBe("roam");
  });
});

describe("working_mode = queue", () => {
  it("working session uses normal waterfall (can get follow)", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "queue" });

    const working = makeChar({ event: "running", attention: false });

    const result = computeModes([working], cfg);
    // With queue mode, working sessions go through normal waterfall
    expect(result.get(working.sessionId)?.mode).toBe("follow");
  });

  it("working sessions compete with attention sessions for follow slots", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, working_mode: "queue" });

    const attn = makeAttentionChar("approval"); // level 4
    const work1 = makeChar({ event: "running", attention: false }); // level 0 (no attention)
    const work2 = makeChar({ event: "running", attention: false }); // level 0

    const result = computeModes([work1, attn, work2], cfg);

    // Attention (level 4) gets first follow, working (level 0) gets remaining
    expect(result.get(attn.sessionId)?.mode).toBe("follow");
    // Two working sessions: one gets follow (slot available), one gets roam
    const workModes = [
      result.get(work1.sessionId)?.mode,
      result.get(work2.sessionId)?.mode,
    ];
    expect(workModes).toContain("follow");
    expect(workModes).toContain("roam");
  });
});

describe("working_mode edge cases", () => {
  it("idle sessions are not treated as working (regardless of working_mode)", () => {
    const cfg = makeConfig({ max_followers: 2, working_mode: "roam" });

    const idle = makeChar({ event: "idle", attention: false });

    const result = computeModes([idle], cfg);
    // idle is not running/tool, so not "working" — goes through normal waterfall
    expect(result.get(idle.sessionId)?.mode).toBe("follow");
  });

  it("null event is not treated as working", () => {
    const cfg = makeConfig({ max_followers: 2, working_mode: "roam" });

    const noEvent = makeChar({ event: null, attention: false });

    const result = computeModes([noEvent], cfg);
    expect(result.get(noEvent.sessionId)?.mode).toBe("follow");
  });
});
