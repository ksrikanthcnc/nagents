/**
 * Working Mode Tests — Updated for new model
 *
 * Key changes:
 *   - working_mode: "roam" (default) — working sessions skip follow, go to roam
 *   - working_counts_toward_max: false (default) — working roamers are FREE (don't consume max_roamers)
 *   - working_counts_toward_max: true — working roamers count toward max_roamers (overflow to dot/hidden)
 *   - isWorking = !attention && (event === "running" || event === "tool")
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("working_mode = roam (default)", () => {
  it("working session skips follow, goes to roam", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "roam" });
    const working = makeChar({ event: "running", attention: false });

    const result = computeModes([working], cfg);
    expect(result.get(working.sessionId)?.mode).toBe("roam");
  });

  it("tool event also treated as working", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "roam" });
    const tooling = makeChar({ event: "tool", attention: false });

    const result = computeModes([tooling], cfg);
    expect(result.get(tooling.sessionId)?.mode).toBe("roam");
  });

  it("working session WITH attention is NOT working (goes through waterfall)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, working_mode: "roam" });
    const attnRunning = makeChar({ event: "running", attention: true });

    const result = computeModes([attnRunning], cfg);
    // attention=true → isWorking=false → normal waterfall → follow
    expect(result.get(attnRunning.sessionId)?.mode).toBe("follow");
  });

  it("idle event is NOT working", () => {
    const cfg = makeConfig({ max_followers: 2, working_mode: "roam" });
    const idle = makeChar({ event: "idle", attention: false });

    const result = computeModes([idle], cfg);
    // Not working → normal waterfall → follow
    expect(result.get(idle.sessionId)?.mode).toBe("follow");
  });

  it("null event is NOT working", () => {
    const cfg = makeConfig({ max_followers: 2, working_mode: "roam" });
    const noEvent = makeChar({ event: null, attention: false });

    const result = computeModes([noEvent], cfg);
    expect(result.get(noEvent.sessionId)?.mode).toBe("follow");
  });
});

describe("working_counts_toward_max = false (default, FREE roam)", () => {
  it("working roamers do NOT count toward max_roamers", () => {
    const cfg = makeConfig({
      max_followers: 0, max_roamers: 2, max_dots: 5,
      working_mode: "roam", working_counts_toward_max: false,
    });

    // 5 working sessions — all get free roam (no limit)
    const workers = Array.from({ length: 5 }, () =>
      makeChar({ event: "running", attention: false })
    );

    const result = computeModes(workers, cfg);
    const modes = workers.map(c => result.get(c.sessionId)?.mode);

    // ALL roam (free, don't count toward max_roamers=2)
    expect(modes.every(m => m === "roam")).toBe(true);
  });

  it("non-working sessions still respect max_roamers", () => {
    const cfg = makeConfig({
      max_followers: 0, max_roamers: 2, max_dots: 5,
      working_mode: "roam", working_counts_toward_max: false,
    });

    // 3 idle sessions (not working) — limited to max_roamers=2
    const idles = Array.from({ length: 3 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(idles, cfg);
    const modes = idles.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "roam")).toHaveLength(2);
    expect(modes.filter(m => m === "revolve")).toHaveLength(1);
  });

  it("mix: working get free roam, non-working respect limits", () => {
    const cfg = makeConfig({
      max_followers: 1, max_roamers: 1, max_dots: 1,
      working_mode: "roam", working_counts_toward_max: false,
    });

    const worker1 = makeChar({ event: "running", attention: false });
    const worker2 = makeChar({ event: "tool", attention: false });
    const idle1 = makeChar({ event: "idle", attention: false });
    const idle2 = makeChar({ event: "idle", attention: false });
    const idle3 = makeChar({ event: "idle", attention: false });

    const result = computeModes([worker1, worker2, idle1, idle2, idle3], cfg);

    // Workers: both get free roam
    expect(result.get(worker1.sessionId)?.mode).toBe("roam");
    expect(result.get(worker2.sessionId)?.mode).toBe("roam");
    // Idles: waterfall with max_followers=1, max_roamers=1, max_dots=1
    const idleModes = [idle1, idle2, idle3].map(c => result.get(c.sessionId)?.mode);
    expect(idleModes.filter(m => m === "follow")).toHaveLength(1);
    expect(idleModes.filter(m => m === "roam")).toHaveLength(1);
    expect(idleModes.filter(m => m === "revolve")).toHaveLength(1);
  });
});

describe("working_counts_toward_max = true", () => {
  it("working roamers count toward max_roamers, overflow to dot/hidden", () => {
    const cfg = makeConfig({
      max_followers: 0, max_roamers: 2, max_dots: 1,
      working_mode: "roam", working_counts_toward_max: true,
    });

    const workers = Array.from({ length: 4 }, () =>
      makeChar({ event: "running", attention: false })
    );

    const result = computeModes(workers, cfg);
    const modes = workers.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "roam")).toHaveLength(2);
    expect(modes.filter(m => m === "revolve")).toHaveLength(1);
    expect(modes.filter(m => m === "hidden")).toHaveLength(1);
  });
});

describe("working_mode = queue", () => {
  it("working sessions go through normal waterfall (can get follow)", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, working_mode: "queue" });
    const working = makeChar({ event: "running", attention: false });

    const result = computeModes([working], cfg);
    // In queue mode, working sessions use normal waterfall
    expect(result.get(working.sessionId)?.mode).toBe("follow");
  });

  it("working sessions compete by priority in queue mode", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 3, working_mode: "queue" });
    const idle = makeChar({ event: "idle", attention: false }); // level 2
    const running = makeChar({ event: "running", attention: false }); // level 0

    const result = computeModes([running, idle], cfg);
    // Idle (level 2) beats running (level 0) for the follow slot
    expect(result.get(idle.sessionId)?.mode).toBe("follow");
    expect(result.get(running.sessionId)?.mode).toBe("roam");
  });
});

describe("attention_follows interaction with working", () => {
  it("attention_follows=false: attention+running goes through waterfall", () => {
    const cfg = makeConfig({
      max_followers: 2, max_roamers: 3,
      working_mode: "roam", attention_follows: false,
    });

    // attention=true AND event=running → isWorking = !attention && ... = false
    // So it goes through NORMAL waterfall (not working-roam path)
    const attnRunning = makeChar({ event: "running", attention: true });

    const result = computeModes([attnRunning], cfg);
    expect(result.get(attnRunning.sessionId)?.mode).toBe("follow");
  });

  it("attention_follows=true: attention sessions auto-follow (exempt)", () => {
    const cfg = makeConfig({
      max_followers: 1, max_roamers: 3,
      attention_follows: true,
    });

    const attn1 = makeChar({ event: "approval", attention: true });
    const attn2 = makeChar({ event: "stuck", attention: true });
    const normal = makeChar({ event: "idle", attention: false });

    const result = computeModes([normal, attn1, attn2], cfg);

    // Both attention sessions auto-follow (exempt from max_followers)
    expect(result.get(attn1.sessionId)?.mode).toBe("follow");
    expect(result.get(attn2.sessionId)?.mode).toBe("follow");
    // Normal still gets follow since max_followers=1 and attention didn't consume it
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
  });
});
