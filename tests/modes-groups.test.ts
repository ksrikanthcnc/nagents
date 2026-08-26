/**
 * Group-as-one Tests
 *
 * When group_as_one=true:
 *   - Sessions with the same `group` are merged
 *   - group_display="single": only highest-priority member visible, rest hidden (groupHidden=true)
 *   - group_display="cluster": one center char (rotates every round_robin_sec), others clusteredTo center
 *   - Ungrouped sessions (group="") are unaffected
 */

import { describe, it, expect, beforeEach } from "vitest";
import { computeModes } from "../ui/overlay/modes";
import { makeAttentionChar, makeConfig, resetIds } from "./helpers";

beforeEach(() => resetIds());

describe("group_as_one + single display", () => {
  it("only one representative per group is visible", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: true,
      group_display: "single",
    });

    const g1a = makeAttentionChar("idle", { status: "waiting_on_user" }); // level 6 (highest)
    g1a.session.group = "project-A";
    const g1b = makeAttentionChar("approval"); // level 5
    g1b.session.group = "project-A";
    const g1c = makeAttentionChar("stuck"); // level 4
    g1c.session.group = "project-A";

    const result = computeModes([g1a, g1b, g1c], cfg);

    // g1a (highest priority, level 6) is the representative → gets a zone mode
    const repMode = result.get(g1a.sessionId)?.mode;
    expect(repMode).toBe("follow");

    // Others are groupHidden
    expect(result.get(g1b.sessionId)?.groupHidden).toBe(true);
    expect(result.get(g1b.sessionId)?.mode).toBe("hidden");
    expect(result.get(g1c.sessionId)?.groupHidden).toBe(true);
    expect(result.get(g1c.sessionId)?.mode).toBe("hidden");
  });

  it("ungrouped sessions are unaffected by group_as_one", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: true,
      group_display: "single",
    });

    const ungrouped1 = makeAttentionChar("approval");
    ungrouped1.session.group = "";
    const ungrouped2 = makeAttentionChar("idle", { status: "waiting_on_user" });
    ungrouped2.session.group = "";

    const result = computeModes([ungrouped1, ungrouped2], cfg);

    // Both visible — no grouping applied
    expect(result.get(ungrouped1.sessionId)?.mode).toBe("follow");
    expect(result.get(ungrouped2.sessionId)?.mode).toBe("follow");
    expect(result.get(ungrouped1.sessionId)?.groupHidden).toBeUndefined();
    expect(result.get(ungrouped2.sessionId)?.groupHidden).toBeUndefined();
  });

  it("multiple groups: one rep each", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: true,
      group_display: "single",
    });

    const ga1 = makeAttentionChar("approval");
    ga1.session.group = "group-A";
    const ga2 = makeAttentionChar("idle", { priority: "low" });
    ga2.session.group = "group-A";

    const gb1 = makeAttentionChar("stuck");
    gb1.session.group = "group-B";
    const gb2 = makeAttentionChar("idle", { priority: "low" });
    gb2.session.group = "group-B";

    const result = computeModes([ga1, ga2, gb1, gb2], cfg);

    // Representatives get modes
    expect(["follow", "roam", "revolve"]).toContain(result.get(ga1.sessionId)?.mode);
    expect(["follow", "roam", "revolve"]).toContain(result.get(gb1.sessionId)?.mode);
    // Others hidden
    expect(result.get(ga2.sessionId)?.groupHidden).toBe(true);
    expect(result.get(gb2.sessionId)?.groupHidden).toBe(true);
  });
});

describe("group_as_one + cluster display", () => {
  it("one center char enters waterfall, others are clusteredTo it", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: true,
      group_display: "cluster",
      round_robin_sec: 10,
    });

    const g1 = makeAttentionChar("approval");
    g1.session.group = "cluster-group";
    const g2 = makeAttentionChar("idle", { status: "waiting_on_user" });
    g2.session.group = "cluster-group";
    const g3 = makeAttentionChar("idle", { priority: "low" });
    g3.session.group = "cluster-group";

    const result = computeModes([g1, g2, g3], cfg);

    // Find which one is the center (no clusteredTo)
    const allIds = [g1.sessionId, g2.sessionId, g3.sessionId];
    const center = allIds.find((id) => !result.get(id)?.clusteredTo);
    const satellites = allIds.filter((id) => result.get(id)?.clusteredTo);

    expect(center).toBeDefined();
    expect(satellites).toHaveLength(2);

    // Satellites should point to center
    for (const satId of satellites) {
      expect(result.get(satId)?.clusteredTo).toBe(center);
    }
  });

  it("clustered satellites inherit center's mode", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: true,
      group_display: "cluster",
      round_robin_sec: 10,
    });

    const g1 = makeAttentionChar("approval");
    g1.session.group = "test-cluster";
    const g2 = makeAttentionChar("idle", { status: "waiting_on_user" });
    g2.session.group = "test-cluster";

    const result = computeModes([g1, g2], cfg);

    const allIds = [g1.sessionId, g2.sessionId];
    const centerId = allIds.find((id) => !result.get(id)?.clusteredTo)!;
    const satId = allIds.find((id) => result.get(id)?.clusteredTo)!;

    // Satellite's mode should equal center's mode
    expect(result.get(satId)?.mode).toBe(result.get(centerId)?.mode);
  });

  it("ungrouped sessions mixed with cluster group", () => {
    const cfg = makeConfig({
      max_followers: 2,
      max_roamers: 2,
      group_as_one: true,
      group_display: "cluster",
      round_robin_sec: 10,
    });

    const g1 = makeAttentionChar("approval");
    g1.session.group = "my-group";
    const g2 = makeAttentionChar("idle", { status: "waiting_on_user" });
    g2.session.group = "my-group";

    const ungrouped = makeAttentionChar("stuck");
    ungrouped.session.group = "";

    const result = computeModes([g1, g2, ungrouped], cfg);

    // Ungrouped should get its own mode normally
    const ungroupedMode = result.get(ungrouped.sessionId)?.mode;
    expect(["follow", "roam"]).toContain(ungroupedMode);
    expect(result.get(ungrouped.sessionId)?.clusteredTo).toBeUndefined();
  });
});

describe("group_as_one = false (disabled)", () => {
  it("same-group sessions treated independently when group_as_one=false", () => {
    const cfg = makeConfig({
      max_followers: 3,
      max_roamers: 3,
      group_as_one: false,
    });

    const g1 = makeAttentionChar("approval");
    g1.session.group = "same-group";
    const g2 = makeAttentionChar("stuck");
    g2.session.group = "same-group";

    const result = computeModes([g1, g2], cfg);

    // Both get their own slots independently
    expect(result.get(g1.sessionId)?.mode).toBe("follow");
    expect(result.get(g2.sessionId)?.mode).toBe("follow");
    expect(result.get(g1.sessionId)?.groupHidden).toBeUndefined();
    expect(result.get(g2.sessionId)?.groupHidden).toBeUndefined();
  });
});
