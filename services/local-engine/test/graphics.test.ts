import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../src/app.ts";
import { GraphicsDirector } from "../src/live/graphics.ts";

interface P { steamId: string; name: string; side: "T" | "CT"; alive?: boolean; mvps?: number; roundKills?: number; kills?: number }
const state = (players: P[], roundPhase: MatchState["roundPhase"], observed: string | null = null, extra: Partial<MatchState> = {}) =>
  ({
    mapName: "de_dust2",
    roundNumber: 5,
    roundPhase,
    gamePhase: roundPhase,
    mapPhase: "live",
    phaseEndsInSec: roundPhase === "freezetime" ? 20 : 60,
    observer: { observedSteamId: observed },
    players: players.map((p) => ({ steamId: p.steamId, name: p.name, side: p.side, lifeState: p.alive === false ? "dead" : "alive", roundKills: p.roundKills ?? 0, matchStats: { kills: p.kills ?? 0, assists: 1, deaths: 2, mvps: p.mvps ?? 0, score: 0 } })),
    ...extra,
  }) as unknown as MatchState;

function rig() {
  let now = 0;
  let s: MatchState | null = null;
  let buys: unknown = null;
  const cues: { id: string; kind: string; title: string; subtitle: string | null; data: Record<string, unknown>; on: boolean }[] = [];
  const settings = new Map<string, unknown>();
  const e = {
    now: () => now,
    settings: { get: (k: string, d: unknown) => settings.get(k) ?? d, set: (k: string, v: unknown) => settings.set(k, v) },
    session: { state: () => s, output: () => ({ decision: { currentShot: s?.observer.observedSteamId ? `pov:${s.observer.observedSteamId}` : null }, interactions: { byPlayer: new Map() }, buys }), director: { currentMode: "automatic" } },
    autoDirector: { status: () => ({ on: true }) },
    showCue: (c: { kind: string; title: string; subtitle: string | null; data?: Record<string, unknown> }) => {
      const cue = { id: `c${cues.length}`, data: {}, ...c, on: true };
      cues.push(cue);
      return cue;
    },
    clearCue: (id: string) => {
      const c = cues.find((x) => x.id === id);
      if (c) c.on = false;
    },
    updateCue: (id: string, patch: { title?: string; data?: Record<string, unknown> }) => {
      const c = cues.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    },
    obs: { state: { connected: false } },
    logger: { warn: () => undefined },
  } as unknown as Engine;
  const g = new GraphicsDirector(e);
  const tick = (to: number, next?: MatchState) => {
    if (next) s = next;
    while (now < to) {
      now = Math.min(to, now + 250);
      (g as unknown as { tick(): void }).tick();
    }
  };
  return { tick, cues, set: (next: MatchState) => (s = next), setBuys: (b: unknown) => (buys = b), settings };
}

const team: P[] = [
  { steamId: "t1", name: "haze", side: "T" },
  { steamId: "t2", name: "riot", side: "T" },
  { steamId: "t3", name: "ember", side: "T" },
  { steamId: "c1", name: "nova", side: "CT" },
  { steamId: "c2", name: "kite", side: "CT" },
];

describe("HUD graphics timed to the shots", () => {
  it("shows the economy, then CS2's round MVP, in freeze time", () => {
    const { tick, cues } = rig();
    tick(1000, state(team, "live"));
    // haze got the MVP with 3 kills.
    tick(2000, state(team.map((p) => (p.steamId === "t1" ? { ...p, mvps: 1, roundKills: 3 } : p)), "over"));
    tick(3000, state(team.map((p) => (p.steamId === "t1" ? { ...p, mvps: 1, roundKills: 3 } : p)), "freezetime"));
    tick(4200);
    expect(cues.map((c) => c.kind)).toEqual(["economy"]);
    tick(12000);
    expect(cues.find((c) => c.kind === "mvp")).toMatchObject({ title: "haze", subtitle: "ROUND MVP · 3 kills" });
  });

  it("puts up a clutch banner for a 1v2 and takes it down when the round ends", () => {
    const { tick, cues } = rig();
    tick(500, state(team, "live"));
    const clutch = team.map((p) => (p.side === "T" && p.steamId !== "t1" ? { ...p, alive: false } : p));
    tick(1000, state(clutch, "live"));
    const banner = cues.find((c) => c.kind === "clutch")!;
    expect(banner).toMatchObject({ title: "1v2", subtitle: "haze", on: true });
    tick(1500, state(clutch, "over"));
    expect(banner.on).toBe(false);
  });

  it("shows a player's card after their view is held, and takes it down when the view changes", () => {
    const { tick, cues } = rig();
    tick(500, state(team, "live", "c1"));
    tick(6000);
    expect(cues.some((c) => c.kind === "player")).toBe(false);
    tick(7000);
    const card = cues.find((c) => c.kind === "player")!;
    expect(card).toMatchObject({ title: "nova", subtitle: "0 kills · 1 assists · 2 deaths", on: true });
    tick(7500, state(team, "live", "c2"));
    expect(card.on).toBe(false);
  });

  it("puts up each team's buy as a buy_type cue, changes it in place as it is read, and takes it down 8 s into the round", () => {
    const { tick, cues, setBuys } = rig();
    const teams = { T: { teamId: "team-a", name: "Alpha" }, CT: { teamId: "team-b", name: "Bravo" } };
    const at = (phase: MatchState["roundPhase"]) => state(team, phase, null, { roundAttemptId: "r5", teams } as Partial<MatchState>);
    const buy = (type: string, label: string) => ({ type, label });
    setBuys({ roundAttemptId: "r5", roundNumber: 5, T: buy("eco", "ECO"), CT: buy("anti_eco", "ANTI-ECO"), firm: false });
    tick(500, at("freezetime"));
    const b = cues.filter((c) => c.kind === "buy_type");
    expect(b.map((c) => [c.title, c.subtitle])).toEqual([["ECO", "Alpha"], ["ANTI-ECO", "Bravo"]]);
    expect(b[0]!.data).toMatchObject({ side: "T", team: { id: "team-a", name: "Alpha" }, label: "ECO", buyType: "eco", firm: false });
    // They bought after all: the same cues, changed in place.
    setBuys({ roundAttemptId: "r5", roundNumber: 5, T: buy("force", "FORCE BUY"), CT: buy("full", "FULL BUY"), firm: false });
    tick(1000);
    expect(cues.filter((c) => c.kind === "buy_type").map((c) => c.title)).toEqual(["FORCE BUY", "FULL BUY"]);
    // Final a second into the live round; gone 8 s in.
    setBuys({ roundAttemptId: "r5", roundNumber: 5, T: buy("force", "FORCE BUY"), CT: buy("full", "FULL BUY"), firm: true });
    tick(2500, at("live"));
    expect(b[0]!.data).toMatchObject({ firm: true, buyType: "force" });
    expect(b.every((c) => c.on)).toBe(true);
    tick(10600);
    expect(b.every((c) => !c.on)).toBe(true);
  });

  it("puts up no buy cue with the setting off", () => {
    const { tick, cues, setBuys, settings } = rig();
    settings.set("graphics.auto", { buyType: false });
    setBuys({ roundAttemptId: "r5", roundNumber: 5, T: { type: "eco", label: "ECO" }, CT: { type: "full", label: "FULL BUY" }, firm: false });
    tick(1000, state(team, "freezetime", null, { roundAttemptId: "r5", teams: { T: { teamId: null, name: null }, CT: { teamId: null, name: null } } } as Partial<MatchState>));
    expect(cues.some((c) => c.kind === "buy_type")).toBe(false);
  });
});
