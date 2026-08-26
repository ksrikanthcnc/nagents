/**
 * Pinned & Muted Tests — New Priority Model
 *
 * Pinned:
 *   - Always "follow", exempt from max_followers
 *   - priority="high" treated same as pinned=true
 *   - pin_counts_toward_max: true → pinned consume follow slots
 *
 * Muted:
 *   - Priority -1 (always sorted last in waterfall)
 *   - Gets whatever slots remain after all unmuted sessions placed
 *   - With attention_follows=false (default), muted with attention still -1
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Pinned Sessions", () => {
  it("pinned session always gets follow mode", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const pinned = makeChar({ pinned: true, event: "idle" });

    const result = computeModes([pinned], cfg);
    expect(result.get(pinned.sessionId)?.mode).toBe("follow");
  });

  it("pinned sessions are exempt from max_followers (default)", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 3 });

    const pinned1 = makeChar({ pinned: true, event: "idle" });
    const pinned2 = makeChar({ pinned: true, event: "idle" });
    const normal = makeChar({ event: "approval", attention: true }); // level 5

    const result = computeModes([pinned1, pinned2, normal], cfg);

    // Both pinned get follow (exempt), plus normal gets follow (1 slot available)
    expect(result.get(pinned1.sessionId)?.mode).toBe("follow");
    expect(result.get(pinned2.sessionId)?.mode).toBe("follow");
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
  });

  it("pin_counts_toward_max: pinned consume follow slots", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, pin_counts_toward_max: true });

    const pinned1 = makeChar({ pinned: true, event: "idle" });
    const pinned2 = makeChar({ pinned: true, event: "idle" });
    const normal = makeChar({ event: "approval", attention: true });

    const result = computeModes([pinned1, pinned2, normal], cfg);

    expect(result.get(pinned1.sessionId)?.mode).toBe("follow");
    expect(result.get(pinned2.sessionId)?.mode).toBe("follow");
    // 2 pinned consumed both slots → normal goes to roam
    expect(result.get(normal.sessionId)?.mode).toBe("roam");
  });

  it("priority=high treated same as pinned=true", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 2 });

    const highPriority = makeChar({ priority: "high", event: "idle" });
    const normal = makeChar({ event: "approval", attention: true });

    const result = computeModes([highPriority, normal], cfg);

    expect(result.get(highPriority.sessionId)?.mode).toBe("follow");
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
  });

  it("pinned without attention or event still gets follow", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const pinned = makeChar({ pinned: true, attention: false, event: null });

    const result = computeModes([pinned], cfg);
    expect(result.get(pinned.sessionId)?.mode).toBe("follow");
  });
});

describe("Muted Sessions", () => {
  it("muted session gets lowest priority (-1), sorts last", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5 });

    // Muted with approval event — would be level 5 unmuted
    const muted = makeChar({ muted: true, event: "approval", attention: true });
    // Normal idle — level 2
    const normal = makeChar({ event: "idle", attention: false });

    const result = computeModes([muted, normal], cfg);

    // Normal (level 2) beats muted (level -1) for follow
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
    expect(result.get(muted.sessionId)?.mode).toBe("roam");
  });

  it("muted can get follow if slots available and no competition", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3 });
    const muted = makeChar({ muted: true, event: "idle", attention: true });

    const result = computeModes([muted], cfg);

    // Only session, slots available → gets follow
    expect(result.get(muted.sessionId)).toBeDefined();
    expect(result.get(muted.sessionId)?.mode).toBe("follow");
  });

  it("multiple muted fill waterfall normally (lowest priority)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 1, max_dots: 1 });

    const muted1 = makeChar({ muted: true, event: "idle", attention: true });
    const muted2 = makeChar({ muted: true, event: "idle", attention: true });
    const muted3 = makeChar({ muted: true, event: "idle", attention: true });
    const muted4 = makeChar({ muted: true, event: "idle", attention: true });

    const result = computeModes([muted1, muted2, muted3, muted4], cfg);
    const modes = [muted1, muted2, muted3, muted4].map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(2);
    expect(modes.filter(m => m === "roam")).toHaveLength(1);
    expect(modes.filter(m => m === "revolve")).toHaveLength(1);
  });

  it("muted + normal mix: normal fills first, muted gets remaining", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2 });

    const normal1 = makeChar({ event: "approval", attention: true }); // level 5
    const normal2 = makeChar({ event: "stuck", attention: true }); // level 4
    const muted1 = makeChar({ muted: true, event: "approval", attention: true });
    const muted2 = makeChar({ muted: true, event: "approval", attention: true });

    const result = computeModes([muted1, normal1, muted2, normal2], cfg);

    expect(result.get(normal1.sessionId)?.mode).toBe("follow");
    expect(result.get(normal2.sessionId)?.mode).toBe("follow");
    expect(result.get(muted1.sessionId)?.mode).toBe("roam");
    expect(result.get(muted2.sessionId)?.mode).toBe("roam");
  });

  it("muted sessions present in result (not dropped)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 5 });

    const muted1 = makeChar({ muted: true, event: "idle" });
    const muted2 = makeChar({ muted: true, event: "running" });
    const muted3 = makeChar({ muted: true, event: "approval" });

    const result = computeModes([muted1, muted2, muted3], cfg);

    expect(result.has(muted1.sessionId)).toBe(true);
    expect(result.has(muted2.sessionId)).toBe(true);
    expect(result.has(muted3.sessionId)).toBe(true);
  });
});

describe("Pin/Mute Interactions", () => {
  it("pinned+muted treated as pinned (pinned wins)", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const both = makeChar({ pinned: true, muted: true, event: "idle" });

    const result = computeModes([both], cfg);
    // Pinned check happens first → always follow
    expect(result.get(both.sessionId)?.mode).toBe("follow");
  });
});
