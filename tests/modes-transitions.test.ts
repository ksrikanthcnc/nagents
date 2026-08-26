/**
 * State Transition Tests — New Priority Model
 *
 * Tests pin/unpin, mute/unmute transitions and verifies computeModes
 * handles state changes correctly between calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Pin → Unpin Transition", () => {
  it("unpinning respects max_followers on next computation", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3 });

    // State 1: 2 pinned + 2 normal = 4 followers total (pinned exempt)
    const p1 = makeChar({ pinned: true, event: "idle" });
    const p2 = makeChar({ pinned: true, event: "idle" });
    const n1 = makeChar({ event: "approval", attention: true }); // level 5
    const n2 = makeChar({ event: "stuck", attention: true }); // level 4

    const result1 = computeModes([p1, p2, n1, n2], cfg);
    expect(result1.get(p1.sessionId)?.mode).toBe("follow");
    expect(result1.get(p2.sessionId)?.mode).toBe("follow");
    expect(result1.get(n1.sessionId)?.mode).toBe("follow");
    expect(result1.get(n2.sessionId)?.mode).toBe("follow");

    // State 2: unpin p2 → now normal, competes for 2 follow slots
    p2.session.pinned = false;
    const result2 = computeModes([p1, p2, n1, n2], cfg);

    // p1 still pinned → follow (exempt)
    expect(result2.get(p1.sessionId)?.mode).toBe("follow");
    // 3 normal competing for 2 slots: n1(level5) > n2(level4) > p2(level2 idle)
    expect(result2.get(n1.sessionId)?.mode).toBe("follow");
    expect(result2.get(n2.sessionId)?.mode).toBe("follow");
    expect(result2.get(p2.sessionId)?.mode).toBe("roam");
  });

  it("pin_counts_toward_max: unpin frees a slot", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, pin_counts_toward_max: true });

    const p1 = makeChar({ pinned: true, event: "idle" });
    const p2 = makeChar({ pinned: true, event: "idle" });
    const n1 = makeChar({ event: "approval", attention: true });

    const result1 = computeModes([p1, p2, n1], cfg);
    expect(result1.get(n1.sessionId)?.mode).toBe("roam"); // no follow slots left

    p2.session.pinned = false;
    const result2 = computeModes([p1, p2, n1], cfg);
    expect(result2.get(p1.sessionId)?.mode).toBe("follow");
    // Now 1 slot available: n1(level5) beats p2(level2)
    expect(result2.get(n1.sessionId)?.mode).toBe("follow");
    expect(result2.get(p2.sessionId)?.mode).toBe("roam");
  });

  it("rapid pin/unpin: final state is authoritative", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 3 });

    const session = makeChar({ pinned: false, event: "approval", attention: true });
    const other = makeChar({ event: "idle", attention: false }); // level 2

    // Not pinned: session(level5) gets follow over other(level2)
    const r1 = computeModes([session, other], cfg);
    expect(r1.get(session.sessionId)?.mode).toBe("follow");

    // Pin it → still follow (exempt)
    session.session.pinned = true;
    const r2 = computeModes([session, other], cfg);
    expect(r2.get(session.sessionId)?.mode).toBe("follow");
    // other gets the normal follow slot now
    expect(r2.get(other.sessionId)?.mode).toBe("follow");

    // Unpin → back to normal
    session.session.pinned = false;
    const r3 = computeModes([session, other], cfg);
    // session(level5) beats other(level2)
    expect(r3.get(session.sessionId)?.mode).toBe("follow");
    expect(r3.get(other.sessionId)?.mode).toBe("roam");
  });
});

describe("Mute/Unmute Transitions", () => {
  it("muting a session demotes it (unmuted sessions promote)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3 });

    const s1 = makeChar({ event: "approval", attention: true }); // level 5
    const s2 = makeChar({ event: "stuck", attention: true }); // level 4
    const s3 = makeChar({ event: "idle", attention: true }); // level 3

    // State 1: s1+s2 follow, s3 roams
    const r1 = computeModes([s1, s2, s3], cfg);
    expect(r1.get(s1.sessionId)?.mode).toBe("follow");
    expect(r1.get(s2.sessionId)?.mode).toBe("follow");
    expect(r1.get(s3.sessionId)?.mode).toBe("roam");

    // State 2: mute s2 → drops to -1, s3 promotes
    s2.session.muted = true;
    const r2 = computeModes([s1, s2, s3], cfg);
    expect(r2.get(s1.sessionId)?.mode).toBe("follow");
    expect(r2.get(s3.sessionId)?.mode).toBe("follow"); // promoted
    expect(r2.get(s2.sessionId)?.mode).toBe("roam"); // demoted
  });

  it("unmuting restores normal priority", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5 });

    const s1 = makeChar({ event: "idle", attention: false, muted: true }); // muted: -1
    const s2 = makeChar({ event: "idle", attention: false }); // level 2

    const r1 = computeModes([s1, s2], cfg);
    expect(r1.get(s2.sessionId)?.mode).toBe("follow"); // s2 wins
    expect(r1.get(s1.sessionId)?.mode).toBe("roam"); // muted last

    // Unmute s1 → now both level 2, tiebreak decides
    s1.session.muted = false;
    const r2 = computeModes([s1, s2], cfg);
    // Both level 2, one gets follow, one gets roam (deterministic by tiebreak)
    const modes = [r2.get(s1.sessionId)?.mode, r2.get(s2.sessionId)?.mode].sort();
    expect(modes).toEqual(["follow", "roam"]);
  });
});

describe("Event Transitions", () => {
  it("idle → running: session moves from follow to roam (working_mode=roam)", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, working_mode: "roam" });

    const session = makeChar({ event: "idle", attention: false }); // level 2 → follow

    const r1 = computeModes([session], cfg);
    expect(r1.get(session.sessionId)?.mode).toBe("follow");

    // Starts working → becomes working, skips follow
    session.session.event = "running";
    const r2 = computeModes([session], cfg);
    expect(r2.get(session.sessionId)?.mode).toBe("roam");
  });

  it("running → approval: session moves from roam to follow", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, working_mode: "roam" });

    const session = makeChar({ event: "running", attention: false }); // working → roam

    const r1 = computeModes([session], cfg);
    expect(r1.get(session.sessionId)?.mode).toBe("roam");

    // Gets stuck → approval event
    session.session.event = "approval";
    session.session.attention = true;
    const r2 = computeModes([session], cfg);
    // No longer isWorking (attention=true), level 5 → follow
    expect(r2.get(session.sessionId)?.mode).toBe("follow");
  });

  it("waiting_on_user always gets highest priority regardless of event", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5 });

    const waiting = makeChar({ status: "waiting_on_user", event: "idle", attention: false });
    const approval = makeChar({ event: "approval", attention: true }); // level 5

    const result = computeModes([approval, waiting], cfg);
    // waiting_on_user (level 6) beats approval (level 5)
    expect(result.get(waiting.sessionId)?.mode).toBe("follow");
    expect(result.get(approval.sessionId)?.mode).toBe("roam");
  });
});
