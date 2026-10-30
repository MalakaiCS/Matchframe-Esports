import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import { BUSY_LAG_MS, lhmGamePayload, lhmUrgentKey, MAX_UPDATE_MS, UPDATE_MS, updateCoalescer, updatePacer } from "../src/hud/lhm-runtime.ts";

/** A game-data packet: `t` changes the clock and positions only; the rest is what viewers see switch. */
const packet = (t: number, opts: { observed?: string; phase?: string; dead?: number } = {}) => ({
  provider: { timestamp: t },
  player: { steamid: opts.observed ?? "765A" },
  round: { phase: "live" },
  phase_countdowns: { phase: opts.phase ?? "live", phase_ends_in: String(60 - t / 1000) },
  map: { round: 7, phase: "live", team_ct: { score: 3 }, team_t: { score: 4 } },
  allplayers: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { state: { health: i < (opts.dead ?? 0) ? 0 : 100 }, position: `${t}, 0, 0` }])),
});

describe("game data to LHM HUDs", () => {
  afterEach(() => vi.useRealTimers());

  it("sends 50 packets a second as about 20, always the latest", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    expect(UPDATE_MS).toBe(50);
    const c = updateCoalescer((p) => sent.push((p.provider as { timestamp: number }).timestamp), undefined, () => Date.now());
    for (let t = 0; t < 1000; t += 20) {
      c.push(packet(t));
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(200);
    expect(sent.length).toBeGreaterThanOrEqual(20);
    expect(sent.length).toBeLessThanOrEqual(22);
    // Evenly: never more than 50 ms between two (the minimap dots glide instead of surging).
    expect(Math.max(...sent.slice(1).map((t, i) => t - sent[i]!))).toBeLessThanOrEqual(60);
    // The last packet always arrives.
    expect(sent.at(-1)).toBe(980);
    c.dispose();
  });

  it("sends a POV switch, a phase change and a death at once", () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const c = updateCoalescer((p) => sent.push(p), 100, () => Date.now());
    c.push(packet(0));
    vi.advanceTimersByTime(20);
    c.push(packet(20, { observed: "765B" }));
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(20);
    c.push(packet(40, { observed: "765B", phase: "bomb" }));
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(20);
    c.push(packet(60, { observed: "765B", phase: "bomb", dead: 1 }));
    expect(sent).toHaveLength(4);
    c.dispose();
  });

  it("keys on what viewers see switch, not on the clock or positions", () => {
    expect(lhmUrgentKey(packet(0))).toBe(lhmUrgentKey(packet(500)));
    expect(lhmUrgentKey(packet(0))).not.toBe(lhmUrgentKey(packet(0, { observed: "765C" })));
  });
});

describe("pacing an LHM HUD whose page can't keep up", () => {
  it("halves the updates while the page's tasks wait, down to five a second, and comes back once it has room", () => {
    let t = 0;
    const p = updatePacer(() => t);
    const out = {};
    const report = (lag: number) => {
      t += 5000;
      return p.report("kai", out, lag);
    };
    expect(p.everyMs("kai")).toBe(UPDATE_MS);
    expect(report(2)).toBeNull();
    expect(report(BUSY_LAG_MS + 10)).toMatchObject({ everyMs: 100, was: 50 });
    // The next report may still cover the faster pace: no second step until a full one at the new pace.
    expect(report(30)).toBeNull();
    expect(report(30)).toMatchObject({ everyMs: MAX_UPDATE_MS });
    expect(report(30)).toBeNull();
    expect(p.everyMs("kai")).toBe(200);
    // After being slowed down: a minute of calm (twelve reports) before each step faster.
    for (let i = 0; i < 11; i++) expect(report(3)).toBeNull();
    expect(report(3)).toMatchObject({ everyMs: 100 });
    for (let i = 0; i < 2; i++) expect(report(3)).toBeNull();
    expect(report(3)).toMatchObject({ everyMs: 50 });
    // Slowed again (a full report after the last change), then its outputs stop reporting (closed):
    // back to the normal rate after 30 s.
    expect(report(30)).toBeNull();
    expect(report(30)).toMatchObject({ everyMs: 100 });
    t += 29_000;
    expect(p.everyMs("kai")).toBe(100);
    t += 2000;
    expect(p.everyMs("kai")).toBe(UPDATE_MS);
    // Other HUDs and pages without a HUD keep the normal rate.
    expect(p.everyMs("other")).toBe(UPDATE_MS);
    expect(p.everyMs(null)).toBe(UPDATE_MS);
  });

  it("goes by the busiest of the HUD's outputs, forgetting one that stopped reporting", () => {
    let t = 0;
    const p = updatePacer(() => t);
    const obs = {};
    const desktop = {};
    t = 5000;
    p.report("kai", desktop, 1);
    expect(p.report("kai", obs, 25)).toMatchObject({ everyMs: 100 });
    // The busy OBS source closes; the desktop page alone is calm.
    t = 20_000;
    for (let i = 0; i < 12; i++) {
      t += 5000;
      p.report("kai", desktop, 1);
    }
    expect(p.everyMs("kai")).toBe(UPDATE_MS);
  });

  it("feeds a paced HUD at its interval", () => {
    vi.useFakeTimers();
    let every = 200;
    const sent: number[] = [];
    const c = updateCoalescer((p) => sent.push((p.provider as { timestamp: number }).timestamp), () => every, () => Date.now());
    for (let t = 0; t < 1000; t += 20) {
      c.push(packet(t));
      vi.advanceTimersByTime(20);
    }
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent.length).toBeLessThanOrEqual(6);
    every = 50;
    sent.length = 0;
    for (let t = 1000; t < 2000; t += 20) {
      c.push(packet(t));
      vi.advanceTimersByTime(20);
    }
    expect(sent.length).toBeGreaterThanOrEqual(19);
    c.dispose();
  });
});

describe("player numbers and coaches in LHM game data", () => {
  it("gives each player their number key, and leaves coaches out", () => {
    const raw = {
      player: { steamid: "a", observer_slot: 0 },
      allplayers: { a: { name: "A", observer_slot: 0 }, b: { name: "B", observer_slot: 9 }, c: { name: "Coach", observer_slot: 5 }, x: { name: "Unknown", observer_slot: 3 } },
    };
    const state = { players: [{ steamId: "a", observerKey: 1, coach: false }, { steamId: "b", observerKey: 0, coach: false }, { steamId: "c", observerKey: null, coach: true }] } as unknown as MatchState;
    const out = lhmGamePayload(raw, state) as typeof raw;
    expect(out.allplayers).toEqual({ a: { name: "A", observer_slot: 1 }, b: { name: "B", observer_slot: 0 }, x: { name: "Unknown", observer_slot: 3 } });
    expect(out.player).toEqual({ steamid: "a", observer_slot: 1 });
    // The raw packet is left as it was.
    expect(raw.allplayers.a.observer_slot).toBe(0);
    expect(lhmGamePayload(raw, null)).toBe(raw);
  });
});
