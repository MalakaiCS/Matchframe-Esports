// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlayerState } from "@matchframe/contracts";
import { RosterCard, telemetryMissing } from "./RosterCard.tsx";

afterEach(cleanup);

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
  steamId: "76561198000000101",
  playerId: null,
  name: "kindle",
  observerSlot: 1,
  side: "T",
  teamId: null,
  lifeState: "alive",
  health: 87,
  armor: 100,
  helmet: true,
  defuseKit: null,
  flashed: 0.6,
  smoked: 0,
  burning: 0,
  money: 3250,
  equipValue: 4700,
  roundKills: 1,
  roundKillsHeadshot: 0,
  roundDamage: null,
  matchStats: { kills: 7, assists: 2, deaths: 5, mvps: 1, score: 15 },
  weapons: [
    { slotKey: "w0", name: "weapon_ak47", type: "Rifle", state: "active", ammoClip: 25, ammoClipMax: 30, ammoReserve: 90 },
    { slotKey: "w1", name: "weapon_flashbang", type: "Grenade", state: "holstered", ammoClip: null, ammoClipMax: null, ammoReserve: null },
    { slotKey: "w2", name: "weapon_c4", type: "C4", state: "holstered", ammoClip: null, ammoClipMax: null, ammoReserve: null },
  ],
  activeWeapon: { slotKey: "w0", name: "weapon_ak47", type: "Rifle", state: "active", ammoClip: 25, ammoClipMax: 30, ammoReserve: 90 },
  position: null,
  forward: null,
  positionObservedAtMonotonicMs: null,
  lastSeenMonotonicMs: 0,
  provenance: {},
  ...over,
});

describe("RosterCard", () => {
  it("shows reported values, flash state and on-air role", () => {
    render(<RosterCard p={player()} roles={["confirmed"]} onRequest={() => undefined} disabledReason={null} busy={false} />);
    expect(screen.getByText("HP 87")).toBeTruthy();
    expect(screen.getByText("$3,250")).toBeTruthy();
    expect(screen.getByText("AK-47")).toBeTruthy();
    expect(screen.getByText("FL")).toBeTruthy();
    expect(screen.getByText("C4")).toBeTruthy();
    expect(screen.getByText("FLASHED 60%")).toBeTruthy();
    expect(screen.getByText("ON AIR")).toBeTruthy();
  });

  it("shows TELEMETRY MISSING instead of inventing values", () => {
    const p = player({ health: null, armor: null, money: null, activeWeapon: null, weapons: [], flashed: null, roundKills: null, matchStats: { kills: null, assists: null, deaths: null, mvps: null, score: null } });
    expect(telemetryMissing(p)).toBe(true);
    render(<RosterCard p={p} roles={[]} onRequest={() => undefined} disabledReason={null} busy={false} />);
    expect(screen.getByText("TELEMETRY MISSING")).toBeTruthy();
    expect(screen.queryByText(/HP 0/)).toBeNull();
    expect(screen.getByTitle("Kills / assists / deaths (cumulative counters)").textContent).toBe("K — · A — · D —");
  });

  it("requests the POV on click and explains that it is not a video feed", () => {
    const onRequest = vi.fn();
    render(<RosterCard p={player()} roles={["desired"]} onRequest={onRequest} disabledReason={null} busy={false} />);
    const card = screen.getByRole("button");
    expect(card.getAttribute("title")).toMatch(/not a video feed/);
    expect(screen.getByText("DIRECTOR PICK")).toBeTruthy();
    fireEvent.click(card);
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it("marks dead players and missing control capability as unavailable", () => {
    render(<RosterCard p={player({ lifeState: "dead", health: 0 })} roles={[]} onRequest={() => undefined} disabledReason={null} busy={false} />);
    expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("true");
    cleanup();
    render(<RosterCard p={player()} roles={[]} onRequest={() => undefined} disabledReason="Player selection: unverified — configure the observer adapter and run the player-selection test in Setup" busy={false} />);
    expect(screen.getByRole("button").getAttribute("title")).toMatch(/^Player selection: unverified/);
  });
});
