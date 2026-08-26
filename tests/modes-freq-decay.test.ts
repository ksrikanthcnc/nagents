/**
 * Frequency Decay Tiebreaker Tests
 *
 * The "freq" follower_mode uses exponential decay:
 *   score = interactionCount * exp(-decay * age)
 *   where decay = ln(2) / halfLifeSec
 *
 * This means recent interactions are worth more than old ones.
 * Default half-life: 60 minutes (freq_half_life_min=60).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("Frequency Decay (freq tiebreaker)", () => {
  it("higher interaction count with same recency wins", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq" });
    const now = Date.now();

    const highCount = makeChar({ event: "idle", attention: false });
    highCount.interactionCount = 20;
    highCount.lastUserTs = now - 1000; // 1s ago

    const lowCount = makeChar({ event: "idle", attention: false });
    lowCount.interactionCount = 5;
    lowCount.lastUserTs = now - 1000; // same recency

    const result = computeModes([lowCount, highCount], cfg);
    expect(result.get(highCount.sessionId)?.mode).toBe("follow");
    expect(result.get(lowCount.sessionId)?.mode).toBe("roam");
  });

  it("recent interactions beat old ones (decay)", () => {
    const cfg = makeConfig({
      max_followers: 1, max_roamers: 5, follower_mode: "freq",
      freq_half_life_min: 60, // 1 hour half-life
    });
    const now = Date.now();

    // Old: 100 interactions from 4 hours ago (heavily decayed)
    const old = makeChar({ event: "idle", attention: false });
    old.interactionCount = 100;
    old.lastUserTs = now - 4 * 3600 * 1000; // 4 hours ago → score ≈ 100 * 0.0625 = 6.25

    // New: 10 interactions from 10 minutes ago (barely decayed)
    const recent = makeChar({ event: "idle", attention: false });
    recent.interactionCount = 10;
    recent.lastUserTs = now - 10 * 60 * 1000; // 10 min ago → score ≈ 10 * 0.89 = 8.9

    const result = computeModes([old, recent], cfg);
    // Recent wins despite fewer interactions (less decay)
    expect(result.get(recent.sessionId)?.mode).toBe("follow");
    expect(result.get(old.sessionId)?.mode).toBe("roam");
  });

  it("zero interactions always loses", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq" });
    const now = Date.now();

    const active = makeChar({ event: "idle", attention: false });
    active.interactionCount = 1;
    active.lastUserTs = now - 60000;

    const never = makeChar({ event: "idle", attention: false });
    never.interactionCount = 0;
    never.lastUserTs = now - 1000;

    const result = computeModes([never, active], cfg);
    expect(result.get(active.sessionId)?.mode).toBe("follow");
    expect(result.get(never.sessionId)?.mode).toBe("roam");
  });

  it("shorter half-life makes decay faster (recent matters more)", () => {
    const now = Date.now();

    // Same sessions, different half-life
    const makeTestChars = () => {
      const old = makeChar({ event: "idle", attention: false });
      old.interactionCount = 50;
      old.lastUserTs = now - 2 * 3600 * 1000; // 2hr ago
      const recent = makeChar({ event: "idle", attention: false });
      recent.interactionCount = 10;
      recent.lastUserTs = now - 5 * 60 * 1000; // 5min ago
      return [old, recent];
    };

    // Long half-life (4hr): old interactions still have weight
    const cfgLong = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq", freq_half_life_min: 240 });
    resetIds();
    const [old1, recent1] = makeTestChars();
    const r1 = computeModes([old1, recent1], cfgLong);
    const longWinner = r1.get(old1.sessionId)?.mode === "follow" ? "old" : "recent";

    // Short half-life (30min): old interactions heavily decayed
    const cfgShort = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq", freq_half_life_min: 30 });
    resetIds();
    const [old2, recent2] = makeTestChars();
    const r2 = computeModes([old2, recent2], cfgShort);
    const shortWinner = r2.get(old2.sessionId)?.mode === "follow" ? "old" : "recent";

    // With short half-life, recent should win (old decayed more)
    expect(shortWinner).toBe("recent");
    // With long half-life, old should win (50 interactions still have weight)
    expect(longWinner).toBe("old");
  });
});
