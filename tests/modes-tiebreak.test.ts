/**
 * Tie-Breaking Tests
 *
 * When multiple sessions have the same priority level, the follower_mode
 * config determines ordering:
 *   - lifo: newest interaction first (last_user_ts or mtime, highest wins)
 *   - fifo: oldest waiting first (last_user_ts or spawnedAt, lowest wins)
 *   - lru: least recently used by user first (lastUserTs, lowest wins)
 *   - freq: highest interaction frequency first (count/active-hours)
 *   - priority: already primary sort, no-op in tiebreak
 *   - round_robin: rotate through sessions every round_robin_sec
 *   - comma-separated chains: "priority,lifo" — try each in order
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("LIFO (newest first)", () => {
  it("session with more recent last_user_ts gets follow first", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });

    const now = Date.now() / 1000;
    const old = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 100 });
    const recent = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 10 });

    const result = computeModes([old, recent], cfg);

    // LIFO: most recent gets follow
    expect(result.get(recent.sessionId)?.mode).toBe("follow");
    expect(result.get(old.sessionId)?.mode).toBe("roam");
  });

  it("falls back to mtime when last_user_ts is null", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });

    const now = Date.now() / 1000;
    const oldMtime = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now - 200, last_user_ts: null });
    const newMtime = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now - 5, last_user_ts: null });

    const result = computeModes([oldMtime, newMtime], cfg);

    expect(result.get(newMtime.sessionId)?.mode).toBe("follow");
    expect(result.get(oldMtime.sessionId)?.mode).toBe("roam");
  });

  it("last_user_ts takes priority over mtime in LIFO", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });

    const now = Date.now() / 1000;
    // Higher mtime but older user interaction
    const highMtime = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now, last_user_ts: now - 500 });
    // Lower mtime but recent user interaction
    const recentUser = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now - 100, last_user_ts: now - 1 });

    const result = computeModes([highMtime, recentUser], cfg);

    // LIFO uses last_user_ts (or mtime) — the one with most recent last_user_ts wins
    expect(result.get(recentUser.sessionId)?.mode).toBe("follow");
  });
});

describe("FIFO (oldest first)", () => {
  it("session waiting longest gets follow first", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "fifo" });

    const now = Date.now() / 1000;
    const oldest = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 300 });
    const newest = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 10 });

    const result = computeModes([newest, oldest], cfg);

    // FIFO: oldest waiting gets priority
    expect(result.get(oldest.sessionId)?.mode).toBe("follow");
    expect(result.get(newest.sessionId)?.mode).toBe("roam");
  });

  it("falls back to spawnedAt when lastUserTs is 0", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "fifo" });

    const now = Date.now();
    const oldSpawn = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: null });
    // Override spawnedAt (charOverrides)
    oldSpawn.spawnedAt = now - 50000;
    oldSpawn.lastUserTs = 0;

    const newSpawn = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: null });
    newSpawn.spawnedAt = now - 1000;
    newSpawn.lastUserTs = 0;

    const result = computeModes([newSpawn, oldSpawn], cfg);

    // FIFO: oldest spawnedAt gets priority when lastUserTs is 0
    expect(result.get(oldSpawn.sessionId)?.mode).toBe("follow");
  });
});

describe("LRU (least recently used first)", () => {
  it("session least recently interacted by user gets follow", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lru" });

    const now = Date.now() / 1000;
    const neglected = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 600 });
    neglected.lastUserTs = now - 600;

    const recent = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 10 });
    recent.lastUserTs = now - 10;

    const result = computeModes([recent, neglected], cfg);

    // LRU: least recently used (lowest lastUserTs) wins
    expect(result.get(neglected.sessionId)?.mode).toBe("follow");
    expect(result.get(recent.sessionId)?.mode).toBe("roam");
  });

  it("session with lastUserTs=0 (never interacted) gets priority in LRU", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lru" });

    const never = makeAttentionChar("idle", { status: "waiting_on_user" });
    never.lastUserTs = 0;

    const recent = makeAttentionChar("idle", { status: "waiting_on_user" });
    recent.lastUserTs = Date.now() / 1000 - 5;

    const result = computeModes([recent, never], cfg);

    // LRU: 0 (never used) is lowest, gets priority
    expect(result.get(never.sessionId)?.mode).toBe("follow");
  });
});

describe("Frequency (most active first)", () => {
  it("session with higher interaction frequency gets follow", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq" });

    const now = Date.now();
    const highFreq = makeAttentionChar("idle", { status: "waiting_on_user" });
    highFreq.interactionCount = 20;
    highFreq.spawnedAt = now - 3600000; // 1 hour ago → 20/hr

    const lowFreq = makeAttentionChar("idle", { status: "waiting_on_user" });
    lowFreq.interactionCount = 5;
    lowFreq.spawnedAt = now - 3600000; // 1 hour ago → 5/hr

    const result = computeModes([lowFreq, highFreq], cfg);

    // Freq: highest score (count/hours) first
    expect(result.get(highFreq.sessionId)?.mode).toBe("follow");
    expect(result.get(lowFreq.sessionId)?.mode).toBe("roam");
  });

  it("time decay: old session with many interactions can be beaten by newer session", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "freq" });

    const now = Date.now();
    // Old: 10 interactions over 10 hours = 1/hr
    const oldHigh = makeAttentionChar("idle", { status: "waiting_on_user" });
    oldHigh.interactionCount = 10;
    oldHigh.spawnedAt = now - 36000000; // 10 hours

    // New: 5 interactions over 1 hour = 5/hr
    const newActive = makeAttentionChar("idle", { status: "waiting_on_user" });
    newActive.interactionCount = 5;
    newActive.spawnedAt = now - 3600000; // 1 hour

    const result = computeModes([oldHigh, newActive], cfg);

    expect(result.get(newActive.sessionId)?.mode).toBe("follow");
  });
});

describe("Composite follower_mode (chain)", () => {
  it("priority,lifo: priority is primary, lifo is tiebreak", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "priority,lifo" });

    const now = Date.now() / 1000;
    // Same priority level (both level 3), different recency
    const old3 = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 100 });
    const new3 = makeAttentionChar("idle", { status: "waiting_on_user", last_user_ts: now - 5 });

    const result = computeModes([old3, new3], cfg);

    // Both level 3, LIFO tiebreak → newest wins
    expect(result.get(new3.sessionId)?.mode).toBe("follow");
    expect(result.get(old3.sessionId)?.mode).toBe("roam");
  });

  it("deterministic tie: when all tiebreakers equal, sessionId is final sort", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "priority,lifo" });

    const now = Date.now() / 1000;
    // Identical timestamps and priority
    const a = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now, last_user_ts: now });
    const b = makeAttentionChar("idle", { status: "waiting_on_user", mtime: now, last_user_ts: now });

    const result = computeModes([b, a], cfg);

    // Final tiebreak is sessionId.localeCompare — deterministic
    const aMode = result.get(a.sessionId)?.mode;
    const bMode = result.get(b.sessionId)?.mode;
    // One gets follow, one gets roam — and it's stable
    expect([aMode, bMode].sort()).toEqual(["follow", "roam"]);
  });
});

describe("Round Robin", () => {
  it("round_robin mode assigns sessions in rotating order", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "round_robin", round_robin_sec: 10 });

    const chars = Array.from({ length: 3 }, () =>
      makeAttentionChar("idle", { status: "waiting_on_user" })
    );

    const result = computeModes(chars, cfg);

    // One session gets follow, rest get roam
    const modes = chars.map((c) => result.get(c.sessionId)?.mode);
    expect(modes.filter((m) => m === "follow")).toHaveLength(1);
    expect(modes.filter((m) => m === "roam")).toHaveLength(2);
  });
});
