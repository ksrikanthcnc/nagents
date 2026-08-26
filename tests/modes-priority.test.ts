/**
 * Queue Priority Tests — New Priority Model
 *
 * Priority levels (highest first):
 *   6: status === "waiting_on_user" (agent explicitly asked, needs you)
 *   5: event === "approval" (tool stuck >30s, probably needs approval)
 *   4: event === "stuck" (running >120s, might be stuck)
 *   3: attention && event === "idle" (idle with attention)
 *   2: event === "idle" (idle, no attention — done/normal)
 *   1: default (null event, inactive)
 *   0: event === "running" or "tool" (actively working, doesn't need you)
 *  -1: muted (always last)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Priority Level Assignment", () => {
  const cfg = makeConfig({ max_followers: 1, max_roamers: 5, max_dots: 5 });

  it("level 6: status=waiting_on_user is highest", () => {
    const waiting = makeChar({ status: "waiting_on_user", event: "idle", attention: true });
    const approval = makeChar({ event: "approval", attention: true });

    const result = computeModes([approval, waiting], cfg);
    expect(result.get(waiting.sessionId)?.mode).toBe("follow");
    expect(result.get(approval.sessionId)?.mode).toBe("roam");
  });

  it("level 5: event=approval beats stuck", () => {
    const approval = makeChar({ event: "approval", attention: true });
    const stuck = makeChar({ event: "stuck", attention: true });

    const result = computeModes([stuck, approval], cfg);
    expect(result.get(approval.sessionId)?.mode).toBe("follow");
    expect(result.get(stuck.sessionId)?.mode).toBe("roam");
  });

  it("level 4: event=stuck beats idle+attention", () => {
    const stuck = makeChar({ event: "stuck", attention: true });
    const idleAttn = makeChar({ event: "idle", attention: true });

    const result = computeModes([idleAttn, stuck], cfg);
    expect(result.get(stuck.sessionId)?.mode).toBe("follow");
    expect(result.get(idleAttn.sessionId)?.mode).toBe("roam");
  });

  it("level 3: idle+attention beats idle without attention", () => {
    const idleAttn = makeChar({ event: "idle", attention: true });
    const idleNoAttn = makeChar({ event: "idle", attention: false });

    const result = computeModes([idleNoAttn, idleAttn], cfg);
    expect(result.get(idleAttn.sessionId)?.mode).toBe("follow");
    expect(result.get(idleNoAttn.sessionId)?.mode).toBe("roam");
  });

  it("level 2: event=idle (no attention) beats null event", () => {
    const idle = makeChar({ event: "idle", attention: false });
    const nullEvent = makeChar({ event: null, attention: false });

    const result = computeModes([nullEvent, idle], cfg);
    expect(result.get(idle.sessionId)?.mode).toBe("follow");
    expect(result.get(nullEvent.sessionId)?.mode).toBe("roam");
  });

  it("level 1: null event beats running/tool", () => {
    // working_mode=queue to prevent working skip
    const cfgQueue = makeConfig({ max_followers: 1, max_roamers: 5, working_mode: "queue" });
    const nullEvent = makeChar({ event: null, attention: false });
    const running = makeChar({ event: "running", attention: false });

    const result = computeModes([running, nullEvent], cfgQueue);
    expect(result.get(nullEvent.sessionId)?.mode).toBe("follow");
    expect(result.get(running.sessionId)?.mode).toBe("roam");
  });

  it("level 0: running/tool is lowest non-muted priority", () => {
    const cfgQueue = makeConfig({ max_followers: 1, max_roamers: 5, working_mode: "queue" });
    const running = makeChar({ event: "running", attention: false });
    const muted = makeChar({ event: "idle", attention: true, muted: true });

    const result = computeModes([muted, running], cfgQueue);
    expect(result.get(running.sessionId)?.mode).toBe("follow");
    expect(result.get(muted.sessionId)?.mode).toBe("roam");
  });

  it("level -1: muted is always last regardless of event", () => {
    const cfgQueue = makeConfig({ max_followers: 1, max_roamers: 5, working_mode: "queue" });
    const mutedApproval = makeChar({ event: "approval", attention: true, muted: true });
    const running = makeChar({ event: "running", attention: false });

    const result = computeModes([mutedApproval, running], cfgQueue);
    // Even though approval would be level 5, muted overrides to -1
    expect(result.get(running.sessionId)?.mode).toBe("follow");
    expect(result.get(mutedApproval.sessionId)?.mode).toBe("roam");
  });
});

describe("Full Priority Cascade", () => {
  it("all levels sort correctly: 6 > 5 > 4 > 3 > 2 > 1 > 0 > -1", () => {
    const cfgQueue = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1, working_mode: "queue" });

    const level6 = makeChar({ status: "waiting_on_user", event: "idle", attention: true });
    const level5 = makeChar({ event: "approval", attention: true });
    const level4 = makeChar({ event: "stuck", attention: true });
    const level3 = makeChar({ event: "idle", attention: true });
    const level2 = makeChar({ event: "idle", attention: false });
    const level1 = makeChar({ event: null, attention: false });
    const level0 = makeChar({ event: "running", attention: false });
    const levelNeg = makeChar({ event: "approval", attention: true, muted: true });

    // Randomize input order
    const all = [level0, levelNeg, level4, level2, level6, level1, level3, level5];
    const result = computeModes(all, cfgQueue);

    // level6 gets follow (slot 1), level5 gets roam (slot 1), level4 gets revolve (slot 1), rest hidden
    expect(result.get(level6.sessionId)?.mode).toBe("follow");
    expect(result.get(level5.sessionId)?.mode).toBe("roam");
    expect(result.get(level4.sessionId)?.mode).toBe("revolve");
    expect(result.get(level3.sessionId)?.mode).toBe("hidden");
    expect(result.get(level2.sessionId)?.mode).toBe("hidden");
    expect(result.get(level1.sessionId)?.mode).toBe("hidden");
    expect(result.get(level0.sessionId)?.mode).toBe("hidden");
    expect(result.get(levelNeg.sessionId)?.mode).toBe("hidden");
  });

  it("same priority level uses tiebreaker (LIFO by default)", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });
    const now = Date.now() / 1000;

    // Both level 5 (approval), different mtime
    const old = makeChar({ event: "approval", attention: true, mtime: now - 100 });
    const recent = makeChar({ event: "approval", attention: true, mtime: now - 5 });

    const result = computeModes([old, recent], cfg);
    // LIFO: most recent mtime wins
    expect(result.get(recent.sessionId)?.mode).toBe("follow");
    expect(result.get(old.sessionId)?.mode).toBe("roam");
  });
});

describe("Status vs Event Priority", () => {
  it("waiting_on_user (level 6) beats approval even if event differs", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5 });

    // waiting_on_user can come with any event
    const waiting = makeChar({ status: "waiting_on_user", event: "running", attention: true });
    const approval = makeChar({ event: "approval", attention: true });

    const result = computeModes([approval, waiting], cfg);
    expect(result.get(waiting.sessionId)?.mode).toBe("follow");
  });

  it("waiting_on_user without attention still gets level 6", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5 });

    const waiting = makeChar({ status: "waiting_on_user", event: "idle", attention: false });
    const idleAttn = makeChar({ event: "idle", attention: true }); // level 3

    const result = computeModes([idleAttn, waiting], cfg);
    expect(result.get(waiting.sessionId)?.mode).toBe("follow");
  });
});
