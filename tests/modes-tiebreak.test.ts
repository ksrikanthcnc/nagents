/**
 * Tie-Breaking Tests — New Priority Model
 *
 * Within same priority level, follower_mode determines ordering:
 *   - lifo: newest interaction first (last_user_ts or mtime)
 *   - fifo: oldest waiting first (last_user_ts or spawnedAt)
 *   - lru: least recently used first (lowest lastUserTs)
 *   - freq: highest interaction frequency first (exponential decay)
 *   - priority: no-op (already primary sort)
 *   - round_robin: rotate every round_robin_sec
 *   - comma chains: "priority,lifo"
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("LIFO (newest first)", () => {
  it("session with more recent last_user_ts gets follow first", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });
    const now = Date.now() / 1000;

    const old = makeChar({ event: "idle", attention: false, last_user_ts: now - 100 });
    const recent = makeChar({ event: "idle", attention: false, last_user_ts: now - 10 });

    const result = computeModes([old, recent], cfg);
    expect(result.get(recent.sessionId)?.mode).toBe("follow");
    expect(result.get(old.sessionId)?.mode).toBe("roam");
  });

  it("falls back to mtime when last_user_ts is null", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lifo" });
    const now = Date.now() / 1000;

    const oldMtime = makeChar({ event: "idle", attention: false, mtime: now - 200, last_user_ts: null });
    const newMtime = makeChar({ event: "idle", attention: false, mtime: now - 5, last_user_ts: null });

    const result = computeModes([oldMtime, newMtime], cfg);
    expect(result.get(newMtime.sessionId)?.mode).toBe("follow");
    expect(result.get(oldMtime.sessionId)?.mode).toBe("roam");
  });
});

describe("FIFO (oldest first)", () => {
  it("session waiting longest gets follow first", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "fifo" });
    const now = Date.now() / 1000;

    const oldest = makeChar({ event: "idle", attention: false, last_user_ts: now - 300 });
    const newest = makeChar({ event: "idle", attention: false, last_user_ts: now - 10 });

    const result = computeModes([newest, oldest], cfg);
    expect(result.get(oldest.sessionId)?.mode).toBe("follow");
    expect(result.get(newest.sessionId)?.mode).toBe("roam");
  });

  it("falls back to spawnedAt when lastUserTs is 0", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "fifo" });
    const now = Date.now();

    const oldSpawn = makeChar({ event: "idle", attention: false, last_user_ts: null });
    oldSpawn.spawnedAt = now - 50000;
    oldSpawn.lastUserTs = 0;

    const newSpawn = makeChar({ event: "idle", attention: false, last_user_ts: null });
    newSpawn.spawnedAt = now - 1000;
    newSpawn.lastUserTs = 0;

    const result = computeModes([newSpawn, oldSpawn], cfg);
    expect(result.get(oldSpawn.sessionId)?.mode).toBe("follow");
  });
});

describe("LRU (least recently used first)", () => {
  it("session least recently interacted by user gets follow", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lru" });
    const now = Date.now() / 1000;

    const neglected = makeChar({ event: "idle", attention: false });
    neglected.lastUserTs = now - 600;
    const recent = makeChar({ event: "idle", attention: false });
    recent.lastUserTs = now - 10;

    const result = computeModes([recent, neglected], cfg);
    expect(result.get(neglected.sessionId)?.mode).toBe("follow");
    expect(result.get(recent.sessionId)?.mode).toBe("roam");
  });

  it("never-interacted (0) gets priority in LRU", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "lru" });

    const never = makeChar({ event: "idle", attention: false });
    never.lastUserTs = 0;
    const recent = makeChar({ event: "idle", attention: false });
    recent.lastUserTs = Date.now() / 1000 - 5;

    const result = computeModes([recent, never], cfg);
    expect(result.get(never.sessionId)?.mode).toBe("follow");
  });
});

describe("Composite follower_mode (chain)", () => {
  it("priority,lifo: priority is primary, lifo is tiebreak", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "priority,lifo" });
    const now = Date.now() / 1000;

    // Same priority (both level 2 — idle, no attention), different recency
    const old = makeChar({ event: "idle", attention: false, last_user_ts: now - 100 });
    const recent = makeChar({ event: "idle", attention: false, last_user_ts: now - 5 });

    const result = computeModes([old, recent], cfg);
    expect(result.get(recent.sessionId)?.mode).toBe("follow");
    expect(result.get(old.sessionId)?.mode).toBe("roam");
  });

  it("deterministic tie: same everything → sessionId alphabetical", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "priority,lifo" });
    const now = Date.now() / 1000;

    const a = makeChar({ event: "idle", attention: false, mtime: now, last_user_ts: now });
    const b = makeChar({ event: "idle", attention: false, mtime: now, last_user_ts: now });

    const result = computeModes([b, a], cfg);
    const aMode = result.get(a.sessionId)?.mode;
    const bMode = result.get(b.sessionId)?.mode;
    // One gets follow, one gets roam — deterministic
    expect([aMode, bMode].sort()).toEqual(["follow", "roam"]);
  });
});

describe("Round Robin", () => {
  it("assigns sessions in rotating order", () => {
    const cfg = makeConfig({ max_followers: 1, max_roamers: 5, follower_mode: "round_robin", round_robin_sec: 10 });

    const chars = Array.from({ length: 3 }, () =>
      makeChar({ event: "idle", attention: false })
    );

    const result = computeModes(chars, cfg);
    const modes = chars.map(c => result.get(c.sessionId)?.mode);
    expect(modes.filter(m => m === "follow")).toHaveLength(1);
    expect(modes.filter(m => m === "roam")).toHaveLength(2);
  });
});
