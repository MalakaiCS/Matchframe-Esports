import { describe, expect, it } from "vitest";
import type { MatchState, Vec3 } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import type { ClutchState, InteractionFeatures } from "../src/index.ts";
import { ClutchDirector, DEFAULT_DIRECTOR_CONFIG, roundContext } from "../src/index.ts";
import { CT, player, Sim, T } from "./helpers.ts";

/**
 * Clutch direction, step by step: a CT clutcher against Ts on a flat synthetic map, with sightlines
 * and walks given by the test, and a stand-in camera that shows whoever the director picks 300 ms
 * later (a selection landing). The real maps are in clutch-maps.test.ts.
 */
const cfg = DEFAULT_DIRECTOR_CONFIG.clutch;
const CLUTCHER = CT(6);
const H1 = T(1);
const H2 = T(2);
const SITE_X = 1000;

interface Step {
  /** Hunter positions this tick (the clutcher stands at the origin); the second hunter waits far off unless given. */
  h1: Vec3;
  h2?: Vec3;
  /** Sightline between a hunter and the clutcher: now, or opening in so many seconds. */
  sight?: Partial<Record<string, { now?: boolean; soonSec?: number }>>;
  bomb?: { state: string; position?: Vec3; player?: string; countdown?: number };
  /** Round clock left (s). */
  left?: number;
  clutcherAt?: Vec3;
  side?: "CT" | "T";
}

function rig(opts: { walk?: (goal: Vec3, from: readonly Vec3[]) => (number | null)[]; side?: "CT" | "T"; config?: Partial<typeof cfg> } = {}) {
  const sim = new Sim();
  const cd = new ClutchDirector();
  const c = { ...cfg, ...opts.config };
  const clutchSide = opts.side ?? "CT";
  const hunterSide = clutchSide === "CT" ? "T" : "CT";
  let onAir: string | null = CLUTCHER;
  let landing: { who: string; at: number } | null = null;
  const log: { at: number; onAir: string | null; s: ClutchState | null }[] = [];
  const step = (s: Step): ClutchState | null => {
    const at = s.clutcherAt ?? { x: 0, y: 0, z: 0 };
    const players: SyntheticPlayer[] = [
      player(CLUTCHER, clutchSide, 6, at),
      player(H1, hunterSide, 1, s.h1),
      player(H2, hunterSide, 2, s.h2 ?? { x: 3500, y: -3500, z: 0 }),
      player(CT(7), clutchSide, 7, { x: 9000, y: 9000, z: 0 }, null, { health: 0 }),
      player(T(3), hunterSide, 3, { x: -9000, y: 9000, z: 0 }, null, { health: 0 }),
    ];
    const state: MatchState = sim.push(players, { observed: onAir, phaseEndsIn: s.left ?? 80, spec: s.bomb ? { bomb: s.bomb } : {} });
    const siteAt = (p: Vec3) => (p.x >= SITE_X ? ("A" as const) : null);
    const pairs = [H1, H2].map((h) => {
      const sg = s.sight?.[h];
      const tId = hunterSide === "T" ? h : CLUTCHER;
      const ctId = hunterSide === "T" ? CLUTCHER : h;
      return { t: tId, ct: ctId, sight: { now: sg?.now ?? false, soonSec: sg?.soonSec ?? null }, contact: { "1": sg?.now ? 0.9 : 0.1 } };
    });
    const out = cd.update({
      state,
      now: sim.now,
      cfg: c,
      round: roundContext(state, sim.now, siteAt),
      interactions: { pairs } as unknown as InteractionFeatures,
      onAir,
      walk: opts.walk ? (goal, from) => opts.walk!(goal, from) : undefined,
      siteAt,
    });
    // The camera shows the director's pick 300 ms later.
    if (out && out.focus !== onAir && landing?.who !== out.focus) landing = { who: out.focus, at: sim.now + 300 };
    if (landing && sim.now >= landing.at) {
      onAir = landing.who;
      landing = null;
    }
    log.push({ at: sim.now, onAir, s: out });
    return out;
  };
  return { step, log, now: () => sim.now };
}

/** A straight line from `a` to `b` over `ms`, sampled every 100 ms. */
const walkLine = (a: Vec3, b: Vec3, ms: number) => Array.from({ length: Math.round(ms / 100) }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / (ms / 100), y: a.y + ((b.y - a.y) * (i + 1)) / (ms / 100), z: 0 }));
const FAR = { x: -3000, y: 2000, z: 0 };

/** On-air spans: who, from when, for how long. */
function spans(log: { at: number; onAir: string | null }[]) {
  const out: { who: string | null; from: number; ms: number }[] = [];
  for (const e of log) {
    const last = out[out.length - 1];
    if (last && last.who === e.onAir) last.ms = e.at - last.from;
    else out.push({ who: e.onAir, from: e.at, ms: 0 });
  }
  return out;
}

describe("clutch direction", () => {
  it("starts on the clutcher and says so", () => {
    const r = rig();
    const s = r.step({ h1: FAR })!;
    expect(s.focus).toBe(CLUTCHER);
    expect(s.versus).toBe(2);
    expect(s.lastSwitch!.note).toMatch(/1v2: on .*default view/);
  });

  it("looks at a hunter closing in for 2–4 s, then goes back to the clutcher", () => {
    const r = rig();
    for (let i = 0; i < 45; i++) r.step({ h1: { x: -1700, y: 0, z: 0 } });
    // Walking in at 250 units a second.
    const path = walkLine({ x: -1700, y: 0, z: 0 }, { x: -500, y: 0, z: 0 }, 4800);
    for (const p of path) r.step({ h1: p });
    const look = r.log.find((e) => e.s?.focus === H1)!;
    expect(look, "a look at the hunter").toBeDefined();
    expect(look.s!.reasons).toEqual(["CLUTCH_HUNTER_CLOSING"]);
    expect(look.s!.lastSwitch!.note).toMatch(/\(closing in\): \d+ units away, closing at \d+ u\/s, in range in ~\d/);
    const onHunter = spans(r.log).filter((x) => x.who === H1);
    expect(onHunter).toHaveLength(1);
    expect(onHunter[0]!.ms).toBeGreaterThanOrEqual(1900);
    expect(onHunter[0]!.ms).toBeLessThanOrEqual(4400);
    // Back to the clutcher, with the reason, at once.
    const back = r.log.find((e) => e.at > look.at && e.s?.focus === CLUTCHER)!;
    expect(back.s!.reasons).toEqual(["CLUTCH_LOOK_OVER"]);
    expect(back.s!.urgent).toBe(true);
    expect(r.log[r.log.length - 1]!.onAir).toBe(CLUTCHER);
  });

  it("goes back to the clutcher before contact, however short the look", () => {
    const r = rig();
    for (let i = 0; i < 45; i++) r.step({ h1: { x: -1700, y: 0, z: 0 } });
    const path = walkLine({ x: -1700, y: 0, z: 0 }, { x: -600, y: 0, z: 0 }, 4400);
    let lookedAt: number | null = null;
    let contactAt: number | null = null;
    for (const p of path) {
      // A sightline is about to open 1 s after the look came on air.
      const opening = lookedAt !== null && r.now() - lookedAt >= 1000;
      const s = r.step({ h1: p, sight: opening ? { [H1]: { soonSec: 0.8 } } : {} });
      if (opening) contactAt ??= r.now();
      if (lookedAt === null && r.log[r.log.length - 1]!.onAir === H1) lookedAt = r.now();
      if (opening && s) {
        expect(s.focus).toBe(CLUTCHER);
        expect(s.contactSoon).toBe(true);
      }
    }
    expect(lookedAt).not.toBeNull();
    const back = r.log.find((e) => e.at === contactAt)!;
    expect(back.s!.reasons).toEqual(["CLUTCH_BACK_BEFORE_CONTACT"]);
    expect(back.s!.urgent).toBe(true);
    expect(back.s!.lastSwitch!.note).toMatch(/about to meet them \(a sightline opens in 0\.8 s\)/);
    // On the clutcher within the 300 ms the camera takes, before the sightline opens.
    expect(r.log.find((e) => e.at >= contactAt! + 300)!.onAir).toBe(CLUTCHER);
  });

  it("never leaves the clutcher while a hunter is in sight or a few steps away", () => {
    const r = rig();
    for (let i = 0; i < 100; i++) r.step({ h1: { x: -1500 + i * 25, y: 0, z: 0 }, sight: { [H1]: { now: true } } });
    for (let i = 0; i < 60; i++) r.step({ h1: { x: -400, y: 0, z: 0 } });
    expect(r.log.every((e) => e.s?.focus === CLUTCHER)).toBe(true);
  });

  it("holds the clutcher's view 4 s before a look, 10 s between looks at one hunter, and never goes hunter to hunter: no ping-pong", () => {
    const r = rig();
    // Two hunters walking in and back out, over and over, for a minute.
    for (let t = 0; t < 60000; t += 100) {
      const phase = (t % 6000) / 6000;
      const d = 1700 - 1100 * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
      r.step({ h1: { x: -d, y: 0, z: 0 }, h2: { x: 0, y: d + 300, z: 0 } });
    }
    const sp = spans(r.log).filter((x) => x.ms > 0);
    for (const [i, x] of sp.entries()) {
      if (x.who === CLUTCHER) continue;
      // A look lasts 2–4 s, and the camera is on the clutcher before and after it.
      expect(x.ms, JSON.stringify(sp)).toBeLessThanOrEqual(4400);
      expect(sp[i - 1]?.who ?? CLUTCHER).toBe(CLUTCHER);
      if (sp[i + 1]) expect(sp[i + 1]!.who).toBe(CLUTCHER);
      if (i >= 2) expect(sp[i - 1]!.ms, "time on the clutcher before a look").toBeGreaterThanOrEqual(3900);
    }
    for (const h of [H1, H2]) {
      const starts = sp.filter((x) => x.who === h).map((x) => x.from);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(cfg.hunterCooldownMs - 100);
    }
    const switches = sp.length - 1;
    expect(switches).toBeGreaterThan(0);
    expect(switches).toBeLessThanOrEqual(20);
  });

  it("looks at a hunter starting the plant at once, for about the plant's length", () => {
    const r = rig();
    for (let i = 0; i < 25; i++) r.step({ h1: { x: 2600, y: 1800, z: 0 }, bomb: { state: "carried", player: H1 } });
    let first: ClutchState | null = null;
    for (let i = 0; i < 40; i++) {
      const s = r.step({ h1: { x: 2600, y: 1800, z: 0 }, bomb: { state: "planting", position: { x: 2600, y: 1800, z: 0 }, player: H1 } })!;
      if (!first && s.focus === H1) first = s;
    }
    expect(first!.reasons).toEqual(["CLUTCH_HUNTER_PLANTING"]);
    expect(first!.urgent).toBe(true);
    expect(first!.lastSwitch!.note).toMatch(/look at .* \(planting\)/);
    const onPlanter = spans(r.log).find((x) => x.who === H1)!;
    // Three seconds from when it came on air, and the 300 ms the camera takes to come back.
    expect(onPlanter.ms).toBeGreaterThanOrEqual(2900);
    expect(onPlanter.ms).toBeLessThanOrEqual(3400);
    expect(r.log[r.log.length - 1]!.onAir).toBe(CLUTCHER);
  });

  it("looks at a hunter starting a defuse, and goes back when the defuse stops or the clutcher closes in", () => {
    const r = rig({ side: "T" });
    const bomb = { x: 2000, y: 0, z: 0 };
    for (let i = 0; i < 25; i++) r.step({ h1: { x: 2600, y: 0, z: 0 }, bomb: { state: "planted", position: bomb, countdown: 30 } });
    for (let i = 0; i < 15; i++) r.step({ h1: { x: 2050, y: 0, z: 0 }, bomb: { state: "defusing", position: bomb, player: H1, countdown: 28 } });
    expect(r.log[r.log.length - 1]!.s!.focus).toBe(H1);
    expect(r.log.find((e) => e.s?.focus === H1)!.s!.reasons).toEqual(["CLUTCH_HUNTER_DEFUSING"]);
    // The clutcher swings round the corner: in sight of the defuser.
    const s = r.step({ h1: { x: 2050, y: 0, z: 0 }, bomb: { state: "defusing", position: bomb, player: H1, countdown: 27 }, sight: { [H1]: { now: true } } })!;
    expect(s.focus).toBe(CLUTCHER);
    expect(s.reasons).toEqual(["CLUTCH_BACK_BEFORE_CONTACT"]);
  });

  it("looks at a hunter walking onto the site the clutcher holds", () => {
    const r = rig();
    const inSite = { x: SITE_X + 400, y: 0, z: 0 };
    for (let i = 0; i < 45; i++) r.step({ clutcherAt: inSite, h1: { x: SITE_X - 900, y: 900, z: 0 } });
    let look: ClutchState | null = null;
    // Crossing into the site slowly (not closing fast enough for a closing look).
    for (const p of walkLine({ x: SITE_X - 900, y: 900, z: 0 }, { x: SITE_X + 100, y: 900, z: 0 }, 10000)) {
      const s = r.step({ clutcherAt: inSite, h1: p })!;
      look ??= s.focus === H1 ? s : null;
    }
    expect(look, "a look at the hunter on the site").not.toBeNull();
    expect(look!.reasons).toEqual(["CLUTCH_HUNTER_ON_SITE"]);
    expect(look!.site).toBe("A");
  });

  it("with little time left keeps to the clutcher, except for a plant or defuse", () => {
    const r = rig();
    for (let i = 0; i < 45; i++) r.step({ h1: { x: -1700, y: 0, z: 0 }, left: 6 });
    for (const p of walkLine({ x: -1700, y: 0, z: 0 }, { x: -500, y: 0, z: 0 }, 4800)) r.step({ h1: p, left: 6 });
    expect(r.log.every((e) => e.s?.focus === CLUTCHER)).toBe(true);
    for (let i = 0; i < 10; i++) r.step({ h1: { x: -500, y: 3000, z: 0 }, left: 5, bomb: { state: "planting", position: { x: -500, y: 3000, z: 0 }, player: H1 } });
    expect(r.log[r.log.length - 1]!.s!.focus).toBe(H1);
  });

  it("measures how far a hunter has to walk, not the straight line: a wall between them is no contact", () => {
    const near = { x: -260, y: 0, z: 0 };
    // The grid says 2,500 units on foot (the other side of a wall).
    const walled = rig({ walk: (_g, from) => from.map(() => 2500) });
    const a = walled.step({ h1: near })!;
    expect(a.hunters.find((h) => h.steamId === H1)).toMatchObject({ walk: 2500, walked: true });
    expect(a.contactSoon).toBe(false);
    // Without a grid: the straight line (a little longer), which is contact range.
    const open = rig();
    const b = open.step({ h1: near })!;
    expect(b.hunters.find((h) => h.steamId === H1)!.walked).toBe(false);
    expect(b.contactSoon).toBe(true);
  });

  it("does nothing outside a clutch, and stays on the clutcher with hunter looks off", () => {
    const r = rig({ config: { hunterLooks: false } });
    for (let i = 0; i < 45; i++) r.step({ h1: { x: -1700, y: 0, z: 0 } });
    for (const p of walkLine({ x: -1700, y: 0, z: 0 }, { x: -500, y: 0, z: 0 }, 4800)) r.step({ h1: p });
    expect(r.log.every((e) => e.s?.focus === CLUTCHER)).toBe(true);
    const cd = new ClutchDirector();
    const sim = new Sim();
    const state = sim.push([player(CT(6), "CT", 6, { x: 0, y: 0, z: 0 }), player(CT(7), "CT", 7, { x: 10, y: 0, z: 0 }), player(T(1), "T", 1, { x: 900, y: 0, z: 0 }), player(T(2), "T", 2, { x: 950, y: 0, z: 0 })]);
    expect(cd.update({ state, now: sim.now, cfg, round: roundContext(state, sim.now), interactions: { pairs: [] } as unknown as InteractionFeatures, onAir: null })).toBeNull();
  });
});
