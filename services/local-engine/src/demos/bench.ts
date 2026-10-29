import { buildSyntheticGsiPayload, MatchStateStore, normalizeGsi, parseGsiPayload, type SyntheticPlayer } from "@matchframe/cs2-state";
import { Director, type DirectorConfig } from "@matchframe/director-policy";
import type { MapRuntime } from "@matchframe/map-runtime";
import type { LivePovModel } from "../live/model-runtime.ts";

/** One line of a replay stream (worker `export-replay`). */
export type ReplayLine =
  | { type: "header"; map: string; dataset_id: string; tick_rate: number; rounds: number }
  | { type: "frame"; tick: number; round: number; phase: "freezetime" | "live" | "over"; players: [string, "T" | "CT", number, number, number, number, number, number, number, string | null][]; bomb: { state: string; x: number | null; y: number | null; z: number | null } | null }
  | { type: "kill"; tick: number; attacker: string | null; victim: string };

export interface BenchResult {
  datasetId: string;
  map: string;
  rounds: number;
  liveMinutes: number;
  kills: number;
  /** Kills with the killer's or the victim's POV on air as they happened. */
  killsShown: number;
  /** Seconds the shot had been on that player before a shown kill (mean, capped at 10 s). */
  meanLeadS: number | null;
  /** Second and later kills of a player within 10 s of their previous one. */
  multiFragKills: number;
  multiFragKillsShown: number;
  /** First kill of each round. */
  openingKills: number;
  openingKillsShown: number;
  cuts: number;
  cutsPerMinute: number;
}

/** Display names in the datasets to the game data's weapon names and types. */
const WEAPONS: Record<string, [string, string]> = {
  "AK-47": ["weapon_ak47", "Rifle"],
  "M4A1-S": ["weapon_m4a1_silencer", "Rifle"],
  M4A4: ["weapon_m4a1", "Rifle"],
  AUG: ["weapon_aug", "Rifle"],
  "SG 553": ["weapon_sg556", "Rifle"],
  FAMAS: ["weapon_famas", "Rifle"],
  "Galil AR": ["weapon_galilar", "Rifle"],
  AWP: ["weapon_awp", "SniperRifle"],
  "SSG 08": ["weapon_ssg08", "SniperRifle"],
  "SCAR-20": ["weapon_scar20", "SniperRifle"],
  G3SG1: ["weapon_g3sg1", "SniperRifle"],
  "MAC-10": ["weapon_mac10", "Submachine Gun"],
  MP9: ["weapon_mp9", "Submachine Gun"],
  MP7: ["weapon_mp7", "Submachine Gun"],
  "MP5-SD": ["weapon_mp5sd", "Submachine Gun"],
  "UMP-45": ["weapon_ump45", "Submachine Gun"],
  P90: ["weapon_p90", "Submachine Gun"],
  "PP-Bizon": ["weapon_bizon", "Submachine Gun"],
  "Glock-18": ["weapon_glock", "Pistol"],
  "USP-S": ["weapon_usp_silencer", "Pistol"],
  P2000: ["weapon_hkp2000", "Pistol"],
  P250: ["weapon_p250", "Pistol"],
  "Five-SeveN": ["weapon_fiveseven", "Pistol"],
  "Tec-9": ["weapon_tec9", "Pistol"],
  "CZ75-Auto": ["weapon_cz75a", "Pistol"],
  "Desert Eagle": ["weapon_deagle", "Pistol"],
  "Dual Berettas": ["weapon_elite", "Pistol"],
  "R8 Revolver": ["weapon_revolver", "Pistol"],
};

const forwardOf = (pitch: number, yaw: number) => {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
};

/**
 * The director replayed on a demo: each frame becomes game data (through the same pipeline as a
 * live match), the director decides, and its player cuts go on air `latencyMs` later (like a real
 * console). Scored on every kill: was the killer's or the victim's POV on air?
 * Observer mode (players only): the score is about the POV choice.
 */
export function runBench(lines: Iterable<ReplayLine>, opts: BenchOptions = {}): BenchResult {
  const run = benchRun(opts);
  for (const line of lines) run.step(line);
  return run.result();
}

/** The same, giving the event loop a turn every 250 lines (the engine keeps serving the game data and HUDs). */
export async function runBenchAsync(lines: readonly ReplayLine[], opts: BenchOptions = {}): Promise<BenchResult> {
  const run = benchRun(opts);
  for (let i = 0; i < lines.length; i++) {
    run.step(lines[i]!);
    if (i % 250 === 249) await new Promise((r) => setImmediate(r));
  }
  return run.result();
}

export interface BenchOptions {
  map?: MapRuntime | undefined;
  config?: Partial<DirectorConfig>;
  latencyMs?: number;
  /** The demo-trained POV model, blended into the director's imminence (see `Director.setLearnedImminence`). */
  pov?: { model: LivePovModel; weight: number; ref: number } | undefined;
  /** Called at each kill and each cut (diagnostics). */
  trace?: (e: { kind: "kill"; at: number; attacker: string | null; victim: string; onAir: string | null } | { kind: "cut"; at: number; to: string; reasons: string[] }) => void;
}

function benchRun(opts: BenchOptions): { step: (line: ReplayLine) => void; result: () => BenchResult } {
  const latency = opts.latencyMs ?? 300;
  const director = new Director({ ...(opts.config ? { config: opts.config } : {}) });
  director.setMode("automatic");
  director.setObserverMode("observer");
  director.setMap(opts.map);
  const pov = opts.pov;
  if (pov) director.setLearnedImminence({ predict: (s) => pov.model.predictPlayers(s), weight: pov.weight, ref: pov.ref });
  const store = new MatchStateStore({ sessionId: "bench", simulated: true, mapContextFor: () => opts.map });
  const control = { ownership: { owner: "director" as const, generation: 1, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false }, adapterAvailable: true, inputFresh: true, pendingCommand: false };

  let header: Extract<ReplayLine, { type: "header" }> | null = null;
  let onAir: string | null = null;
  let onAirSince = 0;
  let pending: { id: string; at: number } | null = null;
  let cuts = 0;
  let liveMs = 0;
  let lastFrameAt: number | null = null;
  let lastPhase: string | null = null;
  let ts = 1_700_000_000;
  const killsByRound = new Map<number, number>();
  /** Kills per player this round, as the game data reports them (round_kills). */
  const roundKills = new Map<string, number>();
  const lastKillBy = new Map<string, number>();
  let round = 0;
  const r = { kills: 0, killsShown: 0, multiFragKills: 0, multiFragKillsShown: 0, openingKills: 0, openingKillsShown: 0, lead: [] as number[] };

  const step = (line: ReplayLine): void => {
    if (line.type === "header") {
      header = line;
      return;
    }
    const rate = header?.tick_rate ?? 64;
    const now = 10_000 + (line.tick / rate) * 1000;
    if (pending && now >= pending.at) {
      if (pending.id !== onAir) {
        onAir = pending.id;
        onAirSince = pending.at;
        if (lastPhase === "live") cuts++;
      }
      pending = null;
    }
    if (line.type === "kill") {
      opts.trace?.({ kind: "kill", at: now, attacker: line.attacker, victim: line.victim, onAir });
      r.kills++;
      const shown = onAir !== null && (onAir === line.victim || onAir === line.attacker);
      if (shown) {
        r.killsShown++;
        r.lead.push(Math.min(10, (now - onAirSince) / 1000));
      }
      const n = (killsByRound.get(round) ?? 0) + 1;
      killsByRound.set(round, n);
      if (n === 1) {
        r.openingKills++;
        if (shown) r.openingKillsShown++;
      }
      if (line.attacker && line.attacker !== line.victim) {
        roundKills.set(line.attacker, (roundKills.get(line.attacker) ?? 0) + 1);
        const prev = lastKillBy.get(line.attacker);
        if (prev !== undefined && now - prev <= 10_000) {
          r.multiFragKills++;
          if (onAir === line.attacker) r.multiFragKillsShown++;
        }
        lastKillBy.set(line.attacker, now);
      }
      return;
    }
    if (line.round !== round) {
      round = line.round;
      lastKillBy.clear();
      roundKills.clear();
    }
    if (line.phase === "live" && lastPhase === "live" && lastFrameAt !== null) liveMs += now - lastFrameAt;
    lastFrameAt = now;
    lastPhase = line.phase;
    const players: SyntheticPlayer[] = line.players.map(([id, side, x, y, z, pitch, yaw, health, armor, weapon], i) => {
      const w = weapon ? WEAPONS[weapon] : undefined;
      return {
        steamId: id,
        name: `p${id.slice(-4)}`,
        slot: (i + 1) % 10,
        side,
        health,
        armor,
        position: { x, y, z },
        forward: forwardOf(pitch, yaw),
        roundKills: roundKills.get(id) ?? 0,
        weapons: w ? [{ name: w[0], type: w[1], state: "active", ammoClip: 20, ammoClipMax: 30, ammoReserve: 60 }] : [],
      };
    });
    if (!onAir || !players.some((p) => p.steamId === onAir)) {
      // The game moves the spectator to a living player when the one on air dies.
      const next = players[0]?.steamId ?? null;
      if (next !== onAir) {
        onAir = next;
        onAirSince = now;
      }
    }
    ts += 1;
    const raw = buildSyntheticGsiPayload({
      mapName: header?.map ?? "de_unknown",
      players,
      observed: onAir,
      timestamp: ts,
      round: Math.max(0, line.round - 1),
      roundPhase: line.phase,
      phase: line.phase,
      phaseEndsIn: line.phase === "freezetime" ? 15 : 60,
      ...(line.bomb ? { bomb: { state: line.bomb.state, ...(line.bomb.x !== null && line.bomb.y !== null && line.bomb.z !== null ? { position: { x: line.bomb.x, y: line.bomb.y, z: line.bomb.z } } : {}) } } : {}),
    });
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) return;
    store.ingest(normalizeGsi(parsed.payload, { sourceId: "gsi:bench", receivedAtMonotonicMs: now, payloadHash: String(ts) }));
    const snapshot = store.snapshot(now);
    pov?.model.observe(snapshot);
    // As live: while a switch is on its way, the director waits for it (pendingCommand).
    const out = director.evaluate(snapshot, now, { ...control, pendingCommand: pending !== null });
    const intent = out.intent;
    if (!pending && intent?.kind === "select_player" && intent.targetSteamId && intent.targetSteamId !== onAir) {
      pending = { id: intent.targetSteamId, at: now + latency };
      opts.trace?.({ kind: "cut", at: now, to: intent.targetSteamId, reasons: out.decision.reasonCodes });
    }
  };
  const result = (): BenchResult => {
    const liveMinutes = liveMs / 60_000;
    return {
      datasetId: header?.dataset_id ?? "unknown",
      map: header?.map ?? "unknown",
      rounds: header?.rounds ?? 0,
      liveMinutes: Math.round(liveMinutes * 10) / 10,
      kills: r.kills,
      killsShown: r.killsShown,
      meanLeadS: r.lead.length ? Math.round((r.lead.reduce((a, b) => a + b, 0) / r.lead.length) * 100) / 100 : null,
      multiFragKills: r.multiFragKills,
      multiFragKillsShown: r.multiFragKillsShown,
      openingKills: r.openingKills,
      openingKillsShown: r.openingKillsShown,
      cuts,
      cutsPerMinute: liveMinutes > 0 ? Math.round((cuts / liveMinutes) * 10) / 10 : 0,
    };
  };
  return { step, result };
}

/** Totals over several replays. */
export function sumBench(results: BenchResult[]): Omit<BenchResult, "datasetId" | "map"> & { matches: number } {
  const s = (k: keyof BenchResult) => results.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const leads = results.filter((x) => x.meanLeadS !== null);
  const live = s("liveMinutes");
  return {
    matches: results.length,
    rounds: s("rounds"),
    liveMinutes: Math.round(live * 10) / 10,
    kills: s("kills"),
    killsShown: s("killsShown"),
    meanLeadS: leads.length ? Math.round((leads.reduce((n, x) => n + x.meanLeadS! * x.killsShown, 0) / Math.max(1, leads.reduce((n, x) => n + x.killsShown, 0))) * 100) / 100 : null,
    multiFragKills: s("multiFragKills"),
    multiFragKillsShown: s("multiFragKillsShown"),
    openingKills: s("openingKills"),
    openingKillsShown: s("openingKillsShown"),
    cuts: s("cuts"),
    cutsPerMinute: live > 0 ? Math.round((s("cuts") / live) * 10) / 10 : 0,
  };
}
