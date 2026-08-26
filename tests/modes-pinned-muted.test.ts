/**
 * Pinned & Muted Tests
 *
 * Pinned sessions:
 *   - Always get mode "follow", exempt from max_followers
 *   - Unless pin_counts_toward_max is true (then they consume slots)
 *   - priority="high" is treated same as pinned=true
 *
 * Muted sessions:
 *   - Sorted last in the waterfall (after all normal sessions)
 *   - Never get follow slots (only roam/dot/hidden)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Pinned Sessions", () => {
  it("pinned session always gets follow mode", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const pinned = makeChar({ pinned: true, attention: true, event: "idle" });

    const result = computeModes([pinned], cfg);
    expect(result.get(pinned.sessionId)?.mode).toBe("follow");
  });

  it("pinned sessions are exempt from max_followers (extra slots)", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 3, max_dots: 3 });

    const pinned1 = makeChar({ pinned: true, attention: true, event: "idle" });
    const pinned2 = makeChar({ pinned: true, attention: true, event: "idle" });
    const normal = makeAttentionChar("approval");

    const result = computeModes([pinned1, pinned2, normal], cfg);

    // Both pinned get follow (exempt), plus normal also gets follow (1 slot available)
    expect(result.get(pinned1.sessionId)?.mode).toBe("follow");
    expect(result.get(pinned2.sessionId)?.mode).toBe("follow");
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
  });

  it("pin_counts_toward_max: pinned consume follow slots", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 3, pin_counts_toward_max: true });

    const pinned1 = makeChar({ pinned: true, attention: true, event: "idle" });
    const pinned2 = makeChar({ pinned: true, attention: true, event: "idle" });
    const normal = makeAttentionChar("approval");

    const result = computeModes([pinned1, pinned2, normal], cfg);

    // 2 pinned consume both follow slots → normal goes to roam
    expect(result.get(pinned1.sessionId)?.mode).toBe("follow");
    expect(result.get(pinned2.sessionId)?.mode).toBe("follow");
    expect(result.get(normal.sessionId)?.mode).toBe("roam");
  });

  it("priority=high treated same as pinned=true", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 2 });

    const highPriority = makeChar({ priority: "high", attention: true, event: "idle" });
    const normal = makeAttentionChar("approval");

    const result = computeModes([highPriority, normal], cfg);

    // highPriority is treated as pinned → always follow, exempt
    expect(result.get(highPriority.sessionId)?.mode).toBe("follow");
    // normal gets the 1 follow slot
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
  });

  it("pinned without attention still gets follow", () => {
    const cfg = makeConfig({ max_followers: 2 });
    // Pinned is always follow regardless of attention state
    const pinned = makeChar({ pinned: true, attention: false, event: null });

    const result = computeModes([pinned], cfg);
    expect(result.get(pinned.sessionId)?.mode).toBe("follow");
  });
});

describe("Muted Sessions", () => {
  /**
   * BUG: Muted sessions are extracted from `normal` into a `muted` array
   * but NEVER placed into the result map. The loop to place them after
   * normal sessions is missing from modes.ts.
   *
   * These tests assert CORRECT behavior — they FAIL until the bug is fixed.
   * Fix: add a loop after the normal waterfall that places muted sessions
   * into remaining roam→dot→hidden slots (never follow).
   */

  it("muted sessions get lowest priority but CAN get follow if slots available", () => {
    const cfg = makeConfig({ max_followers: 3, max_roamers: 3, max_dots: 3 });

    const muted = makeChar({ muted: true, attention: true, event: "approval" });

    const result = computeModes([muted], cfg);

    // Muted has lowest priority (-1) but with open slots, can still follow
    expect(result.get(muted.sessionId)).toBeDefined();
    expect(result.get(muted.sessionId)?.mode).toBe("follow");
  });

  it("muted sessions sorted after all normal sessions", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1 });

    const muted = makeChar({ muted: true, attention: true, event: "approval" });
    const normal = makeAttentionChar("idle", { priority: "low" });

    const result = computeModes([muted, normal], cfg);

    // Normal gets follow, muted gets roam (after normal)
    expect(result.get(normal.sessionId)?.mode).toBe("follow");
    expect(result.get(muted.sessionId)).toBeDefined();
    expect(result.get(muted.sessionId)?.mode).toBe("roam");
  });

  it("multiple muted sessions: lowest priority, fill waterfall normally", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 1, max_dots: 1 });

    const muted1 = makeChar({ muted: true, attention: true, event: "idle" });
    const muted2 = makeChar({ muted: true, attention: true, event: "idle" });
    const muted3 = makeChar({ muted: true, attention: true, event: "idle" });

    const result = computeModes([muted1, muted2, muted3], cfg);
    const modes = [muted1, muted2, muted3].map(
      (c) => result.get(c.sessionId)?.mode
    );

    // All get assigned a mode
    expect(modes.filter((m) => m === undefined)).toHaveLength(0);
    // Lowest priority but with open slots: follow(2) → roam(1)
    expect(modes.filter((m) => m === "follow")).toHaveLength(2);
    expect(modes.filter((m) => m === "roam")).toHaveLength(1);
  });

  it("muted + normal mix: normal fills follow, muted gets remaining", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    const normal1 = makeAttentionChar("approval");
    const normal2 = makeAttentionChar("stuck");
    const muted1 = makeChar({ muted: true, attention: true, event: "approval" });
    const muted2 = makeChar({ muted: true, attention: true, event: "approval" });

    const result = computeModes([muted1, normal1, muted2, normal2], cfg);

    // Normal sessions fill follow slots
    expect(result.get(normal1.sessionId)?.mode).toBe("follow");
    expect(result.get(normal2.sessionId)?.mode).toBe("follow");
    // Muted go to roam (never follow)
    expect(result.get(muted1.sessionId)?.mode).toBe("roam");
    expect(result.get(muted2.sessionId)?.mode).toBe("roam");
  });
});
