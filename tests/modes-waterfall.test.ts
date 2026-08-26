/**
 * Waterfall Placement Tests — New Priority Model
 *
 * Verifies sessions are placed into zones:
 *   follow (max_followers) → roam (max_roamers) → revolve (max_dots) → hidden
 *
 * With attention_follows=false (default), attention sessions compete normally.
 * With working_mode=roam + working_counts_toward_max=false, working get free roam.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Waterfall Zone Filling", () => {
  it("sessions fill follow first, then roam, then dot, then hidden", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    // 7 idle sessions (level 2) — all go through waterfall
    const chars = Array.from({ length: 7 }, (_, i) =>
      makeChar({ event: "idle", attention: false, mtime: 1000 + i })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(2);
    expect(modes.filter(m => m === "roam")).toHaveLength(2);
    expect(modes.filter(m => m === "revolve")).toHaveLength(2);
    expect(modes.filter(m => m === "hidden")).toHaveLength(1);
  });

  it("with max_followers=0, all go to roam/dot/hidden", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 3, max_dots: 2 });

    const chars = Array.from({ length: 6 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(0);
    expect(modes.filter(m => m === "roam")).toHaveLength(3);
    expect(modes.filter(m => m === "revolve")).toHaveLength(2);
    expect(modes.filter(m => m === "hidden")).toHaveLength(1);
  });

  it("with all slots=1, only 3 visible", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 1, max_dots: 1 });

    const chars = Array.from({ length: 5 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(1);
    expect(modes.filter(m => m === "roam")).toHaveLength(1);
    expect(modes.filter(m => m === "revolve")).toHaveLength(1);
    expect(modes.filter(m => m === "hidden")).toHaveLength(2);
  });

  it("zero sessions returns empty map", () => {
    const cfg = makeConfig();
    const result = computeModes([], cfg);
    expect(result.size).toBe(0);
  });

  it("single session gets follow", () => {
    const cfg = makeConfig({ max_followers: 2 });
    const char = makeChar({ event: "approval", attention: true });

    const result = computeModes([char], cfg);
    expect(result.get(char.sessionId)?.mode).toBe("follow");
  });

  it("exact fit: sessions equal total slots, none hidden", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 2, max_dots: 2 });

    const chars = Array.from({ length: 6 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "hidden")).toHaveLength(0);
  });
});

describe("Overflow Scenarios", () => {
  it("overflow follow→roam when max_followers exceeded", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 5, max_dots: 5 });

    const chars = Array.from({ length: 3 }, () =>
      makeChar({ event: "approval", attention: true }) // all level 5
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(2);
    expect(modes.filter(m => m === "roam")).toHaveLength(1);
  });

  it("overflow roam→dot when max_roamers exceeded", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 2, max_dots: 5 });

    const chars = Array.from({ length: 4 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "roam")).toHaveLength(2);
    expect(modes.filter(m => m === "revolve")).toHaveLength(2);
  });

  it("overflow dot→hidden when max_dots exceeded", () => {
    const cfg = makeConfig({ max_followers: 0, max_roamers: 0, max_dots: 2 });

    const chars = Array.from({ length: 4 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "revolve")).toHaveLength(2);
    expect(modes.filter(m => m === "hidden")).toHaveLength(2);
  });

  it("large session count: 20 sessions with limited slots", () => {
    const cfg = makeConfig({ max_followers: 2, max_roamers: 3, max_dots: 5 });

    const chars = Array.from({ length: 20 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);

    expect(modes.filter(m => m === "follow")).toHaveLength(2);
    expect(modes.filter(m => m === "roam")).toHaveLength(3);
    expect(modes.filter(m => m === "revolve")).toHaveLength(5);
    expect(modes.filter(m => m === "hidden")).toHaveLength(10);
  });
});

describe("Working Sessions + Free Roam", () => {
  it("working sessions get free roam (dont affect non-working slot counts)", () => {
    const cfg = makeConfig({
      max_followers: 2, max_roamers: 2, max_dots: 2,
      working_mode: "roam", working_counts_toward_max: false,
    });

    // 3 working (free roam) + 6 idle (waterfall: 2 follow + 2 roam + 2 dot)
    const workers = Array.from({ length: 3 }, () =>
      makeChar({ event: "running", attention: false })
    );
    const idles = Array.from({ length: 6 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes([...workers, ...idles], cfg);

    // Workers: all free roam
    for (const w of workers) {
      expect(result.get(w.sessionId)?.mode).toBe("roam");
    }
    // Idles: waterfall 2+2+2
    const idleModes = idles.map(c => result.get(c.sessionId)?.mode);
    expect(idleModes.filter(m => m === "follow")).toHaveLength(2);
    expect(idleModes.filter(m => m === "roam")).toHaveLength(2);
    expect(idleModes.filter(m => m === "revolve")).toHaveLength(2);
  });
});
