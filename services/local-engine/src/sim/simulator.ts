import type { Side, Vec3 } from "@matchframe/contracts";
import type { SyntheticGrenade, SyntheticPlayer } from "@matchframe/cs2-state";
import { buildSyntheticGsiPayload } from "@matchframe/cs2-state";
import type { SimulatedObserver } from "@matchframe/observer-agent";

/**
 * SIMULATION SOURCE. Produces synthetic GSI payloads for a scripted round on the synthetic test
 * map ("de_synthetic"). Every state built from it carries `simulated: true` and HUDs/operator
 * screens show a SIMULATION badge. It exists for development, demos and visual QA only.
 */
type Key = [t: number, x: number, y: number, z?: number];

interface Track {
  steamId: string;
  name: string;
  slot: number;
  side: Side;
  keys: Key[];
  deathAt?: number;
  weapon: string;
  grenades: string[];
  lookAt?: (t: number) => Vec3 | null;
}

interface ScriptGrenade {
  id: string;
  type: string;
  owner: string;
  throwAt: number;
  from: Vec3;
  velocity: Vec3;
  /** Seconds after throw when the projectile disappears / comes to rest. */
  endAfter: number;
  effect?: { after: number; duration: number; flames?: boolean; smoke?: boolean };
}

const T_ID = (i: number) => `7656119800000010${i}`;
const CT_ID = (i: number) => `7656119800000020${i}`;
const ROUND_LEN = 80;
const FREEZE = 12;

function lerp(keys: Key[], t: number): Vec3 {
  if (t <= keys[0]![0]) return { x: keys[0]![1], y: keys[0]![2], z: keys[0]![3] ?? 0 };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (t <= b[0]) {
      const f = (t - a[0]) / (b[0] - a[0]);
      return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f, z: (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * f };
    }
  }
  const l = keys[keys.length - 1]!;
  return { x: l[1], y: l[2], z: l[3] ?? 0 };
}

function script(): { tracks: Track[]; grenades: ScriptGrenade[]; kills: { at: number; killer: string; victim: string; hs: boolean }[]; plantAt: number; plantPos: Vec3; defuseAt: number | null } {
  const bananaStack = (dx: number, dy: number): Key[] => [
    [0, -2500 + dx, -2500 + dy],
    [FREEZE, -2500 + dx, -2500 + dy],
    [FREEZE + 14, -600 + dx, dy],
    [FREEZE + 34, -600 + dx, dy],
    [FREEZE + 44, 1500 + dx, dy],
  ];
  const tracks: Track[] = [
    { steamId: T_ID(1), name: "Sim T1", slot: 1, side: "T", keys: bananaStack(0, 0), weapon: "weapon_ak47", grenades: ["weapon_flashbang"] },
    { steamId: T_ID(2), name: "Sim T2", slot: 2, side: "T", keys: bananaStack(110, 90), weapon: "weapon_ak47", grenades: ["weapon_smokegrenade"], deathAt: FREEZE + 37.8 },
    { steamId: T_ID(3), name: "Sim T3", slot: 3, side: "T", keys: bananaStack(-100, -110), weapon: "weapon_ak47", grenades: ["weapon_molotov"] },
    { steamId: T_ID(4), name: "Sim T4", slot: 4, side: "T", keys: [[0, -2600, -2300], [FREEZE, -2600, -2300], [FREEZE + 12, -900, 300], [FREEZE + 21, -350, 200], [FREEZE + 44, 1400, 300]], weapon: "weapon_ak47", grenades: [] },
    { steamId: T_ID(5), name: "Sim T5", slot: 5, side: "T", keys: [[0, -2400, -2600], [FREEZE, -2400, -2600], [FREEZE + 20, 0, 2000], [FREEZE + 50, 900, 2200]], weapon: "weapon_galilar", grenades: ["weapon_hegrenade"] },
    { steamId: CT_ID(6), name: "Sim CT6", slot: 6, side: "CT", keys: [[0, 2000, 300], [FREEZE, 2000, 300], [FREEZE + 8, 600, 100], [FREEZE + 20, 300, 150], [FREEZE + 23, 30, 160]], weapon: "weapon_m4a1", grenades: [], deathAt: FREEZE + 23.4 },
    { steamId: CT_ID(7), name: "Sim CT7", slot: 7, side: "CT", keys: [[0, 2100, 0], [FREEZE, 2100, 0], [FREEZE + 10, 1200, 200]], weapon: "weapon_m4a1_silencer", grenades: ["weapon_hegrenade"], deathAt: FREEZE + 47 },
    { steamId: CT_ID(8), name: "Sim CT8", slot: 8, side: "CT", keys: [[0, 2200, -200], [FREEZE, 2200, -200], [FREEZE + 10, 1300, -300]], weapon: "weapon_awp", grenades: ["weapon_incgrenade"], deathAt: FREEZE + 49 },
    { steamId: CT_ID(9), name: "Sim CT9", slot: 9, side: "CT", keys: [[0, 2000, 3500], [FREEZE, 2000, 3500], [FREEZE + 52, 2000, 3400], [FREEZE + 62, 1600, 600]], weapon: "weapon_m4a1", grenades: [] },
    { steamId: CT_ID(0), name: "Sim CT0", slot: 0, side: "CT", keys: [[0, 1800, 3200], [FREEZE, 1800, 3200], [FREEZE + 22, 600, 2300]], weapon: "weapon_famas", grenades: [], deathAt: FREEZE + 30 },
  ];
  const grenades: ScriptGrenade[] = [
    { id: "301", type: "frag", owner: CT_ID(7), throwAt: FREEZE + 35, from: { x: 1100, y: 200, z: 64 }, velocity: { x: -560, y: -60, z: 260 }, endAfter: 1.6 },
    { id: "302", type: "firebomb", owner: CT_ID(8), throwAt: FREEZE + 36.2, from: { x: 1200, y: -300, z: 64 }, velocity: { x: -700, y: 120, z: 260 }, endAfter: 1.4, effect: { after: 1.4, duration: 7, flames: true } },
    { id: "303", type: "smoke", owner: T_ID(2), throwAt: FREEZE + 31, from: { x: -500, y: 100, z: 64 }, velocity: { x: 650, y: 60, z: 300 }, endAfter: 2.2, effect: { after: 2.2, duration: 18, smoke: true } },
    { id: "304", type: "flashbang", owner: T_ID(1), throwAt: FREEZE + 41.5, from: { x: -300, y: 0, z: 64 }, velocity: { x: 700, y: 0, z: 200 }, endAfter: 1.6 },
    { id: "305", type: "decoy", owner: T_ID(5), throwAt: FREEZE + 24, from: { x: 0, y: 2000, z: 64 }, velocity: { x: 300, y: 300, z: 150 }, endAfter: 1.5, effect: { after: 1.5, duration: 12 } },
  ];
  const kills = [
    { at: FREEZE + 23.4, killer: T_ID(4), victim: CT_ID(6), hs: true },
    { at: FREEZE + 30, killer: T_ID(5), victim: CT_ID(0), hs: false },
    { at: FREEZE + 37.8, killer: CT_ID(7), victim: T_ID(2), hs: false },
    { at: FREEZE + 47, killer: T_ID(1), victim: CT_ID(7), hs: true },
    { at: FREEZE + 49, killer: T_ID(3), victim: CT_ID(8), hs: false },
  ];
  return { tracks, grenades, kills, plantAt: FREEZE + 52, plantPos: { x: 1700, y: 200, z: 0 }, defuseAt: null };
}

export class RoundSimulator {
  private readonly s = script();
  private round = 0;
  private scoreCT = 0;
  private scoreT = 0;
  private roundWins: Record<string, string> = {};
  private startedAt: number;
  private ts = Math.floor(Date.now() / 1000);

  constructor(
    private readonly observer: SimulatedObserver,
    private readonly now: () => number,
    opts: { startOffsetSec?: number } = {},
  ) {
    this.startedAt = now() - (opts.startOffsetSec ?? 0) * 1000;
  }

  /** Builds the current synthetic GSI payload. */
  payload(token: string): Record<string, unknown> {
    let t = (this.now() - this.startedAt) / 1000;
    if (t >= ROUND_LEN) {
      this.roundWins[String(this.round + 1)] = "t_win_bomb";
      this.scoreT++;
      this.round++;
      this.startedAt = this.now();
      t = 0;
    }
    this.ts = Math.floor(Date.now() / 1000);
    const live = t >= FREEZE;
    const players: SyntheticPlayer[] = this.s.tracks.map((tr) => {
      const pos = lerp(tr.keys, t);
      const ahead = lerp(tr.keys, t + 0.5);
      const dx = ahead.x - pos.x;
      const dy = ahead.y - pos.y;
      const len = Math.hypot(dx, dy);
      const dead = tr.deathAt !== undefined && t >= tr.deathAt;
      const kills = this.s.kills.filter((k) => k.killer === tr.steamId && t >= k.at);
      const enemy = this.s.tracks.find((o) => o.side !== tr.side && (o.deathAt === undefined || t < o.deathAt));
      const enemyPos = enemy ? lerp(enemy.keys, t) : null;
      const fwd = len > 1 ? { x: dx / len, y: dy / len, z: 0 } : enemyPos ? { x: (enemyPos.x - pos.x) / (Math.hypot(enemyPos.x - pos.x, enemyPos.y - pos.y) || 1), y: (enemyPos.y - pos.y) / (Math.hypot(enemyPos.x - pos.x, enemyPos.y - pos.y) || 1), z: 0 } : { x: 1, y: 0, z: 0 };
      const thrown = new Set<string>(this.s.grenades.filter((g) => g.owner === tr.steamId && t >= g.throwAt).map((g) => (g.type === "frag" ? "weapon_hegrenade" : g.type === "firebomb" ? (tr.side === "T" ? "weapon_molotov" : "weapon_incgrenade") : g.type === "smoke" ? "weapon_smokegrenade" : g.type === "flashbang" ? "weapon_flashbang" : "weapon_decoy")));
      const hurt = this.s.grenades.find((g) => g.type === "frag" && t >= g.throwAt + g.endAfter && t < g.throwAt + g.endAfter + 0.3);
      const nearHe = hurt && Math.hypot(pos.x - (hurt.from.x + hurt.velocity.x * hurt.endAfter), pos.y - (hurt.from.y + hurt.velocity.y * hurt.endAfter)) < 350 && tr.side === "T";
      const health = dead ? 0 : nearHe || (hurt && t > hurt.throwAt + hurt.endAfter && tr.side === "T" && Math.abs(pos.x + 600) < 300) ? 62 : 100;
      const weapons: NonNullable<SyntheticPlayer["weapons"]> = dead
        ? []
        : [
            { name: tr.weapon, type: tr.weapon === "weapon_awp" ? "SniperRifle" : "Rifle", state: "active", ammoClip: 25, ammoClipMax: 30, ammoReserve: 90 },
            { name: tr.side === "T" ? "weapon_glock" : "weapon_usp_silencer", type: "Pistol", state: "holstered", ammoClip: 12, ammoClipMax: 12, ammoReserve: 24 },
            ...tr.grenades.filter((g) => !thrown.has(g)).map((g) => ({ name: g, type: "Grenade", state: "holstered" as const })),
            ...(tr.steamId === T_ID(1) && t < this.s.plantAt ? [{ name: "weapon_c4", type: "C4", state: "holstered" as const }] : []),
          ];
      const flash = this.s.grenades.find((g) => g.type === "flashbang" && t >= g.throwAt + g.endAfter && t < g.throwAt + g.endAfter + 2);
      return {
        steamId: tr.steamId,
        name: tr.name,
        slot: tr.slot,
        side: tr.side,
        health,
        armor: dead ? 0 : 100,
        helmet: !dead,
        defuseKit: tr.side === "CT" && !dead ? tr.slot % 2 === 0 : undefined,
        flashed: flash && tr.side === "CT" && !dead ? 200 : 0,
        money: 2500 + this.round * 300,
        equipValue: dead ? 0 : 4700,
        roundKills: kills.length,
        roundKillsHs: kills.filter((k) => k.hs).length,
        kills: kills.length + this.round,
        deaths: (dead ? 1 : 0) + Math.floor(this.round / 2),
        assists: 0,
        position: pos,
        forward: fwd,
        weapons,
      } satisfies SyntheticPlayer;
    });

    const grenades: SyntheticGrenade[] = [];
    for (const g of this.s.grenades) {
      const dt = t - g.throwAt;
      if (dt < 0) continue;
      const inFlight = dt < g.endAfter;
      const effectActive = g.effect && dt >= g.effect.after && dt < g.effect.after + g.effect.duration;
      if (inFlight) {
        const p = { x: g.from.x + g.velocity.x * dt, y: g.from.y + g.velocity.y * dt, z: Math.max(0, g.from.z + g.velocity.z * dt - 0.5 * 320 * dt * dt) };
        grenades.push({ id: g.id, type: g.type, owner: g.owner, position: p, velocity: { x: g.velocity.x, y: g.velocity.y, z: g.velocity.z - 320 * dt }, lifetime: dt });
      } else if (effectActive) {
        const land = { x: g.from.x + g.velocity.x * g.endAfter, y: g.from.y + g.velocity.y * g.endAfter, z: 0 };
        if (g.effect!.flames) {
          grenades.push({ id: `${g.id}0`, type: "inferno", owner: g.owner, position: land, lifetime: dt - g.effect!.after, flames: [land, { x: land.x + 70, y: land.y + 40, z: 0 }, { x: land.x - 60, y: land.y - 50, z: 0 }, { x: land.x + 20, y: land.y - 80, z: 0 }] });
        } else {
          grenades.push({ id: g.id, type: g.type, owner: g.owner, position: land, velocity: { x: 0, y: 0, z: 0 }, lifetime: dt, effecttime: dt - g.effect!.after + 0.01 });
        }
      }
    }

    const planted = t >= this.s.plantAt;
    const bombLeft = planted ? Math.max(0, 40 - (t - this.s.plantAt)) : null;
    const carrier = players.find((p) => p.weapons?.some((w) => w.name === "weapon_c4"));
    const observed = this.observer.activeCameraId ? null : (this.observer.observedSteamId ?? players.find((p) => (p.health ?? 0) > 0)?.steamId ?? null);
    return buildSyntheticGsiPayload({
      providerSteamId: "76561190000000099",
      timestamp: this.ts,
      mapName: "de_synthetic",
      mapPhase: "live",
      round: this.round,
      scoreCT: this.scoreCT,
      scoreT: this.scoreT,
      ctName: "Simulation Blue",
      tName: "Simulation Orange",
      roundWins: this.roundWins,
      roundPhase: live ? "live" : "freezetime",
      ...(planted ? { roundBomb: "planted" as const } : {}),
      phase: !live ? "freezetime" : planted ? "bomb" : "live",
      phaseEndsIn: !live ? FREEZE - t : planted ? (bombLeft ?? 0) : 115 - (t - FREEZE),
      players,
      observed,
      bomb: planted ? { state: "planted", position: this.s.plantPos, countdown: bombLeft ?? 0 } : carrier ? { state: "carried", player: carrier.steamId, position: carrier.position ?? undefined } : undefined,
      grenades,
      token,
    });
  }
}
