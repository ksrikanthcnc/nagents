/**
 * State Transition Tests
 *
 * Tests for issues discovered during testing:
 * 1. Pin→unpin: formerly pinned session should respect max_followers after unpin
 * 2. Muted sessions should not get follow mode (prevents overlay/panel desync)
 *
 * These verify that mode assignments are correct when state changes between calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Pin → Unpin Transition", () => {
  it("unpinning a session respects max_followers on next computation", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 3 });

    // State 1: 2 pinned + 2 normal attention sessions = 4 followers total
    const p1 = makeChar({ pinned: true, attention: true, event: "idle", status: "waiting_on_user" });
    const p2 = makeChar({ pinned: true, attention: true, event: "idle", status: "waiting_on_user" });
    const n1 = makeAttentionChar("approval");
    const n2 = makeAttentionChar("stuck");

    const result1 = computeModes([p1, p2, n1, n2], cfg);
    // Pinned exempt: all 4 should be following
    expect(result1.get(p1.sessionId)?.mode).toBe("follow");
    expect(result1.get(p2.sessionId)?.mode).toBe("follow");
    expect(result1.get(n1.sessionId)?.mode).toBe("follow");
    expect(result1.get(n2.sessionId)?.mode).toBe("follow");

    // State 2: unpin p2 → now only 1 pinned, but p2 becomes normal with attention
    p2.session.pinned = false;
    const result2 = computeModes([p1, p2, n1, n2], cfg);

    // p1 still pinned → follow (exempt)
    expect(result2.get(p1.sessionId)?.mode).toBe("follow");
    // Only 2 follow slots for normal (max_followers=2)
    // 3 normal sessions competing: p2, n1, n2
    const normalModes = [
      result2.get(p2.sessionId)?.mode,
      result2.get(n1.sessionId)?.mode,
      result2.get(n2.sessionId)?.mode,
    ];
    // At most 2 should be "follow", 1 should be "roam"
    expect(normalModes.filter((m) => m === "follow")).toHaveLength(2);
    expect(normalModes.filter((m) => m === "roam")).toHaveLength(1);
    // Total followers: 1 pinned + 2 normal = 3 (not 4!)
  });

  it("pin_counts_toward_max: unpin frees a slot for normal sessions", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, pin_counts_toward_max: true });

    // State 1: 2 pinned consume all follow slots, normal session in roam
    const p1 = makeChar({ pinned: true, attention: true, event: "idle" });
    const p2 = makeChar({ pinned: true, attention: true, event: "idle" });
    const n1 = makeAttentionChar("approval");

    const result1 = computeModes([p1, p2, n1], cfg);
    expect(result1.get(p1.sessionId)?.mode).toBe("follow");
    expect(result1.get(p2.sessionId)?.mode).toBe("follow");
    // With pin_counts_toward_max, 2 pinned = 0 follow slots left
    expect(result1.get(n1.sessionId)?.mode).toBe("roam");

    // State 2: unpin p2 → frees a slot
    p2.session.pinned = false;
    const result2 = computeModes([p1, p2, n1], cfg);
    expect(result2.get(p1.sessionId)?.mode).toBe("follow"); // still pinned
    // Now 1 pinned = 1 follow slot available for normal
    // Both p2 (now normal) and n1 compete — n1 has higher priority (approval > idle)
    expect(result2.get(n1.sessionId)?.mode).toBe("follow");
    expect(result2.get(p2.sessionId)?.mode).toBe("roam");
  });

  it("rapid pin/unpin: final state is authoritative", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 3 });

    const session = makeChar({ pinned: false, attention: true, event: "approval" });
    const other = makeAttentionChar("idle", { status: "waiting_on_user" });

    // Initially not pinned: session gets follow (higher priority)
    const r1 = computeModes([session, other], cfg);
    expect(r1.get(session.sessionId)?.mode).toBe("follow");

    // Pin it → still follow (but as pinned, exempt)
    session.session.pinned = true;
    const r2 = computeModes([session, other], cfg);
    expect(r2.get(session.sessionId)?.mode).toBe("follow");
    expect(r2.get(other.sessionId)?.mode).toBe("follow"); // slot freed for other

    // Unpin it → back to normal waterfall
    session.session.pinned = false;
    const r3 = computeModes([session, other], cfg);
    // Only 1 follow slot for normal now. session (level 4) beats other (level 3)
    expect(r3.get(session.sessionId)?.mode).toBe("follow");
    expect(r3.get(other.sessionId)?.mode).toBe("roam");
  });
});

describe("Muted + Overlay/Panel Sync", () => {
  it("muted session should NOT get follow when competing with unmuted sessions", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 3 });

    const unmuted1 = makeAttentionChar("approval"); // level 4
    const unmuted2 = makeAttentionChar("idle", { status: "waiting_on_user" }); // level 3
    const muted = makeChar({ muted: true, attention: true, event: "approval" }); // priority -1

    const result = computeModes([muted, unmuted1, unmuted2], cfg);

    // Unmuted sessions take the follow slots
    expect(result.get(unmuted1.sessionId)?.mode).toBe("follow");
    expect(result.get(unmuted2.sessionId)?.mode).toBe("follow");
    // Muted goes to roam (not follow!) — sorted last by priority -1
    expect(result.get(muted.sessionId)?.mode).toBe("roam");
  });

  it("muted alone gets follow (lowest priority but slots available)", () => {
    // Muted = lowest priority, but still participates in waterfall.
    // If follow slots are open, muted can use them.
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3 });
    const muted = makeChar({ muted: true, attention: true, event: "idle" });

    const result = computeModes([muted], cfg);

    expect(result.get(muted.sessionId)?.mode).toBe("follow");
  });

  it("muting a following session should move it out of follow on recomputation", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3 });

    const s1 = makeAttentionChar("approval");
    const s2 = makeAttentionChar("stuck");
    const s3 = makeAttentionChar("idle", { status: "waiting_on_user" });

    // State 1: s1 and s2 follow (level 4), s3 roams (level 3)
    const r1 = computeModes([s1, s2, s3], cfg);
    expect(r1.get(s1.sessionId)?.mode).toBe("follow");
    expect(r1.get(s2.sessionId)?.mode).toBe("follow");
    expect(r1.get(s3.sessionId)?.mode).toBe("roam");

    // State 2: mute s2 → should drop to roam, s3 promotes to follow
    s2.session.muted = true;
    const r2 = computeModes([s1, s2, s3], cfg);
    expect(r2.get(s1.sessionId)?.mode).toBe("follow"); // unchanged
    expect(r2.get(s3.sessionId)?.mode).toBe("follow"); // promoted!
    expect(r2.get(s2.sessionId)?.mode).toBe("roam"); // muted → demoted
  });
});
