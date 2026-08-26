/**
 * Waterfall Placement Tests
 *
 * Verifies sessions are placed into zones in order:
 *   follow (max_followers) → roam (max_roamers) → dot/revolve (max_dots) → hidden
 *
 * When a zone fills up, remaining sessions spill to the next zone.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Waterfall Zone Filling", () => {
  it("sessions fill follow first, then roam, then dot, then hidden", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    // 7 sessions — all same priority (level 3, idle waiting)
    const chars = Array.from({ length: 7 }, (_, i) =>
      makeAttentionChar("idle", { status: "waiting_on_user", mtime: 1000 + i })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    // First 2 → follow, next 2 → roam, next 2 → revolve, last → hidden
    expect(modes.filter((m) => m === "follow")).toHaveLength(2);
    expect(modes.filter((m) => m === "roam")).toHaveLength(2);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(2);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(1);
  });

  it("with max_followers=0, all go to roam/dot/hidden", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 3, max_dots: 2 });

    const chars = Array.from({ length: 6 }, () =>
      makeAttentionChar("idle", { status: "waiting_on_user" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "follow")).toHaveLength(0);
    expect(modes.filter((m) => m === "roam")).toHaveLength(3);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(2);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(1);
  });

  it("with all slots=1, only 3 visible (1 follow + 1 roam + 1 dot)", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1 });

    const chars = Array.from({ length: 5 }, () =>
      makeAttentionChar("idle", { status: "waiting_on_user" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "follow")).toHaveLength(1);
    expect(modes.filter((m) => m === "roam")).toHaveLength(1);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(1);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(2);
  });

  it("zero sessions returns empty map", () => {
    const cfg = makeConfig();
    const result = computeModes([], cfg);
    expect(result.size).toBe(0);
  });

  it("single session gets follow", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const char = makeAttentionChar("approval");

    const result = computeModes([char], cfg);
    expect(result.get(char.sessionId)?.mode).toBe("follow");
  });

  it("exact fit: sessions equal total slots, none hidden", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    // Exactly 6 sessions = 2+2+2, none should be hidden
    const chars = Array.from({ length: 6 }, () =>
      makeAttentionChar("idle", { status: "waiting_on_user" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "hidden")).toHaveLength(0);
  });
});

describe("Overflow Scenarios", () => {
  it("overflow follow→roam when max_followers exceeded", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 5, max_dots: 5 });

    // 3 attention sessions, only 2 follow slots
    const chars = Array.from({ length: 3 }, () =>
      makeAttentionChar("approval")
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "follow")).toHaveLength(2);
    expect(modes.filter((m) => m === "roam")).toHaveLength(1);
  });

  it("overflow roam→dot when max_roamers exceeded", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 2, max_dots: 5 });

    const chars = Array.from({ length: 4 }, () =>
      makeAttentionChar("idle", { priority: "low" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "roam")).toHaveLength(2);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(2);
  });

  it("overflow dot→hidden when max_dots exceeded", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 0, max_dots: 2 });

    const chars = Array.from({ length: 4 }, () =>
      makeAttentionChar("idle", { priority: "low" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "revolve")).toHaveLength(2);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(2);
  });

  it("large session count: 20 sessions with limited slots", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 5 });

    const chars = Array.from({ length: 20 }, () =>
      makeAttentionChar("idle", { status: "waiting_on_user" })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);

    expect(modes.filter((m) => m === "follow")).toHaveLength(2);
    expect(modes.filter((m) => m === "roam")).toHaveLength(3);
    expect(modes.filter((m) => m === "revolve")).toHaveLength(5);
    expect(modes.filter((m) => m === "hidden")).toHaveLength(10);
  });
});
