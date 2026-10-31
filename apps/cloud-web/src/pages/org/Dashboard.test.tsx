// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { SyncStatus } from "../../api/types.ts";
import { at, err, fakeFetch, makeMe, renderWithSession } from "../../test/helpers.tsx";
import { Dashboard, sharedItems } from "./Dashboard.tsx";

const plan = { id: "free", name: "Free", description: "", priceMonthlyCents: 0, currency: "usd", includedAutoDirectorHours: 2, features: { autoDirector: true, learnedDirectorShadow: false, fullActionObserver: false, maxDevices: 1, maxMembers: 2 }, stripePriceId: null, public: true, sortOrder: 0 };
const allowance = { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", includedSeconds: 7200, creditSeconds: 0, usedSeconds: 0, remainingSeconds: 7200, overageAllowed: false };
const items = (over: Partial<SyncStatus["items"]> = {}): SyncStatus["items"] => ({ team: 0, player: 0, roster: 0, event: 0, match: 0, map: 0, veto: 0, asset: 0, hud: 0, ...over });

function show(sync: Parameters<typeof fakeFetch>[0][string]) {
  at("/orgs/org_1");
  fakeFetch({
    "GET /v1/orgs/org_1": { body: { id: "org_1", name: "Northside Broadcast", createdAt: "2026-10-01T00:00:00.000Z", role: "member", plan, subscriptionStatus: "none" } },
    "GET /v1/orgs/org_1/usage": { body: { allowance, range: { from: allowance.periodStart, to: allowance.periodEnd }, daily: [], byDevice: [], sessions: [] } },
    "GET /v1/orgs/org_1/devices": { body: [] },
    "GET /v1/orgs/org_1/sync": sync,
    "GET /v1/downloads": { body: { windows: null, notesUrl: null, version: "0.10.0" } },
  });
  renderWithSession(<Dashboard scope={{ orgId: "org_1", role: "member" }} />, makeMe({ orgs: [{ id: "org_1", name: "Northside Broadcast", role: "member", planId: "free", planName: "Free", subscriptionStatus: "none" }] }));
  return within(screen.getByRole("region", { name: "Shared with your computers" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard: what the organisation's computers share", () => {
  it("counts players, teams, matches and HUDs, and the space their files use", async () => {
    const card = show({ body: { cursor: 41, items: items({ player: 12, team: 4, match: 3, hud: 2, roster: 4 }), blobBytes: 140 * 1024 ** 2, quotaBytes: 2 * 1024 ** 3 } });
    expect(await card.findByText("12 players, 4 teams, 3 matches, 2 HUDs · 140 MB of 2 GB")).toBeTruthy();
  });

  it("says when nothing is shared yet, and shows errors with a retry", async () => {
    expect(await show({ body: { cursor: 0, items: items(), blobBytes: 0, quotaBytes: 2 * 1024 ** 3 } }).findByText(/Nothing shared yet/)).toBeTruthy();
    cleanup();
    expect(await show(err(500, "internal", "internal error")).findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("writes one of each in the singular", () => {
    expect(sharedItems(items({ player: 1, team: 1, match: 1, hud: 1 }))).toBe("1 player, 1 team, 1 match, 1 HUD");
  });
});
