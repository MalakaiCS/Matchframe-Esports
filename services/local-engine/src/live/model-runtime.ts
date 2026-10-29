import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchState, PlayerState, Vec3 } from "@matchframe/contracts";
import type { InteractionFeatures, LgbDump } from "@matchframe/director-policy";
import { GbdtModel, ModelLoadError } from "@matchframe/director-policy";
import { displayWeaponName } from "./weapons.ts";

/**
 * Live inference for exported `contact_2s` models (workers `export-model`). Features are computed
 * from canonical state exactly as `workers/features/mf_features/features.py` defines them for the
 * `gsi_compatible` set; any model needing another capability is refused at load time and the
 * deterministic baseline stays in charge. Models run in shadow: their output is logged next to the
 * baseline's contact estimate and never drives a camera.
 */
export const LIVE_CONTACT_FEATURES = [
  "dist_3d",
  "dist_2d",
  "dz",
  "facing_a",
  "facing_b",
  "facing_max",
  "facing_min",
  "closing_speed",
  "speed_a",
  "speed_b",
  "health_a",
  "health_b",
  "armor_a",
  "armor_b",
  "weapon_class_a",
  "weapon_class_b",
  "alive_t",
  "alive_ct",
  "round_time_s",
] as const;
const LIVE_CAPABILITIES = new Set(["gsi_compatible"]);
/** Must match HISTORY_S in features.py. */
const HISTORY_S = 0.5;
/** Velocity is a backward difference over at least this interval (GSI arrives at ~10 Hz). */
const MIN_VELOCITY_DT_MS = 50;

const WEAPON_CLASS: Record<string, number> = {};
for (const [names, cls] of [
  [["AWP", "SSG 08", "SCAR-20", "G3SG1"], 4],
  [["AK-47", "M4A1-S", "M4A4", "AUG", "SG 553", "FAMAS", "Galil AR", "M249", "Negev"], 3],
  [["MAC-10", "MP5-SD", "MP7", "MP9", "P90", "PP-Bizon", "UMP-45", "Nova", "XM1014", "MAG-7", "Sawed-Off"], 2],
  [["Glock-18", "USP-S", "P2000", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "Dual Berettas", "R8 Revolver"], 1],
] as const) {
  for (const n of names) WEAPON_CLASS[n] = cls;
}

export interface ModelCard {
  id: string;
  task: string;
  feature_schema: { index: number; name: string; capability: string }[];
  required_capabilities?: string[];
  model_sha256?: string;
  files?: { model?: string };
  notes?: string;
}

export type ModelLoadResult = { ok: true; model: LiveContactModel } | { ok: false; reason: string };
export type PovModelLoadResult = { ok: true; model: LivePovModel } | { ok: false; reason: string };

/** Validates an exported `contact_2s` model directory; never throws. */
export function loadContactModel(dir: string, modelId: string): ModelLoadResult {
  const res = loadExport(dir, "contact_2s", LIVE_CONTACT_FEATURES);
  return res.ok ? { ok: true, model: new LiveContactModel(modelId, res.card, res.gbdt, res.sha) } : res;
}

/** Validates an exported `pov_2s` model directory (the demo-trained POV model); never throws. */
export function loadPovModel(dir: string, modelId: string): PovModelLoadResult {
  const res = loadExport(dir, "pov_2s", LIVE_POV_FEATURES);
  return res.ok ? { ok: true, model: new LivePovModel(modelId, res.card, res.gbdt, res.sha) } : res;
}

function loadExport(dir: string, task: string, features: readonly string[]): { ok: true; card: ModelCard; gbdt: GbdtModel; sha: string } | { ok: false; reason: string } {
  try {
    const cardPath = join(dir, "model_card.json");
    if (!existsSync(cardPath)) return { ok: false, reason: "model_card.json missing" };
    const card = JSON.parse(readFileSync(cardPath, "utf8")) as ModelCard;
    if (card.task !== task) return { ok: false, reason: `unsupported task ${String(card.task)} (expected ${task})` };
    for (const cap of card.required_capabilities ?? []) if (!LIVE_CAPABILITIES.has(cap)) return { ok: false, reason: `requires capability ${cap}, which a live GSI feed does not provide` };
    const known = new Set<string>(features);
    for (const f of card.feature_schema ?? []) {
      if (!LIVE_CAPABILITIES.has(f.capability)) return { ok: false, reason: `feature ${f.name} needs ${f.capability} data, unavailable live` };
      if (!known.has(f.name)) return { ok: false, reason: `feature ${f.name} has no live implementation` };
    }
    const file = join(dir, card.files?.model ?? "model.json");
    if (!existsSync(file)) return { ok: false, reason: "model file missing" };
    const bytes = readFileSync(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (card.model_sha256 && sha !== card.model_sha256) return { ok: false, reason: "model checksum does not match its card (corrupt or modified)" };
    const gbdt = new GbdtModel(JSON.parse(bytes.toString("utf8")) as LgbDump);
    const schemaNames = [...(card.feature_schema ?? [])].sort((a, b) => a.index - b.index).map((f) => f.name);
    if (schemaNames.length !== gbdt.featureNames.length || schemaNames.some((n, i) => n !== gbdt.featureNames[i])) return { ok: false, reason: "feature order in the card does not match the model" };
    return { ok: true, card, gbdt, sha };
  } catch (e) {
    return { ok: false, reason: e instanceof ModelLoadError ? `incompatible model: ${e.message}` : `unreadable model: ${e instanceof Error ? e.message : String(e)}` };
  }
}

interface Sample {
  atMs: number;
  matchTimeMs: number | null;
  pos: Vec3;
}

export interface PairPrediction {
  t: string;
  ct: string;
  probability: number;
  baseline: number | null;
}

/** Per-player position history and round timing needed for the causal live features. */
export class LiveContactModel {
  private readonly history = new Map<string, Sample[]>();
  private roundKey = "";
  private liveStartMatchMs: number | null = null;
  private liveStartAtMs: number | null = null;

  constructor(
    readonly id: string,
    readonly card: ModelCard,
    protected readonly gbdt: GbdtModel,
    readonly sha256: string,
  ) {}

  /** Feed every accepted state (in order). */
  observe(state: MatchState): void {
    const at = state.time.receivedAtMonotonicMs;
    const key = `${state.epoch}:${state.roundNumber ?? "?"}`;
    if (key !== this.roundKey) {
      this.roundKey = key;
      this.liveStartMatchMs = null;
      this.liveStartAtMs = null;
      this.history.clear();
    }
    if (state.roundPhase === "live" && this.liveStartAtMs === null) {
      this.liveStartAtMs = at;
      this.liveStartMatchMs = state.time.matchTimeMs;
    }
    for (const p of state.players) {
      if (!p.position || p.lifeState !== "alive") continue;
      const h = this.history.get(p.steamId) ?? [];
      if (h.length && h[h.length - 1]!.atMs === at) continue;
      h.push({ atMs: at, matchTimeMs: state.time.matchTimeMs, pos: p.position });
      while (h.length > 1 && at - h[0]!.atMs > 3000) h.shift();
      this.history.set(p.steamId, h);
    }
  }

  private asOf(steamId: string, targetMs: number): Sample | null {
    const h = this.history.get(steamId);
    if (!h) return null;
    for (let i = h.length - 1; i >= 0; i--) if (h[i]!.atMs <= targetMs) return h[i]!;
    return null;
  }

  private speed2d(p: PlayerState, now: number): number {
    const prev = this.asOf(p.steamId, now - MIN_VELOCITY_DT_MS);
    if (!prev || !p.position || (this.liveStartAtMs !== null && prev.atMs < this.liveStartAtMs)) return Number.NaN;
    const dt = (now - prev.atMs) / 1000;
    if (dt <= 0 || dt > 1) return Number.NaN;
    return Math.hypot(p.position.x - prev.pos.x, p.position.y - prev.pos.y) / dt;
  }

  /** Feature vector for a T (a) × CT (b) pair, NaN for anything unknown (never 0). */
  features(state: MatchState, a: PlayerState, b: PlayerState): Record<(typeof LIVE_CONTACT_FEATURES)[number], number> {
    const now = state.time.receivedAtMonotonicMs;
    const pa = a.position!;
    const pb = b.position!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dz = pb.z - pa.z;
    const d3 = Math.hypot(dx, dy, dz);
    const facing = (f: Vec3 | null, sx: number, sy: number, sz: number) => (f && d3 > 1e-3 ? (f.x * sx + f.y * sy + f.z * sz) / d3 : Number.NaN);
    const fa = facing(a.forward, dx, dy, dz);
    const fb = facing(b.forward, -dx, -dy, -dz);
    let closing = Number.NaN;
    const ha = this.asOf(a.steamId, now - HISTORY_S * 1000);
    const hb = this.asOf(b.steamId, now - HISTORY_S * 1000);
    if (ha && hb && this.liveStartAtMs !== null && ha.atMs >= this.liveStartAtMs && hb.atMs >= this.liveStartAtMs) {
      const dt = (now - (ha.atMs + hb.atMs) / 2) / 1000;
      if (dt >= HISTORY_S * 0.5 && dt <= HISTORY_S * 2) closing = (Math.hypot(hb.pos.x - ha.pos.x, hb.pos.y - ha.pos.y, hb.pos.z - ha.pos.z) - d3) / dt;
    }
    const alive = (side: "T" | "CT") => state.players.filter((p) => p.side === side && p.lifeState === "alive").length;
    const wclass = (p: PlayerState) => (p.activeWeapon ? (WEAPON_CLASS[displayWeaponName(p.activeWeapon.name)] ?? 0) : Number.NaN);
    const num = (v: number | null) => (v === null ? Number.NaN : v);
    const roundTime = this.liveStartMatchMs !== null && state.time.matchTimeMs !== null && state.roundPhase === "live" ? (state.time.matchTimeMs - this.liveStartMatchMs) / 1000 : Number.NaN;
    return {
      dist_3d: d3,
      dist_2d: Math.hypot(dx, dy),
      dz,
      facing_a: fa,
      facing_b: fb,
      // NaN-aware like polars max_horizontal/min_horizontal (nulls ignored).
      facing_max: Number.isNaN(fa) ? fb : Number.isNaN(fb) ? fa : Math.max(fa, fb),
      facing_min: Number.isNaN(fa) ? fb : Number.isNaN(fb) ? fa : Math.min(fa, fb),
      closing_speed: closing,
      speed_a: this.speed2d(a, now),
      speed_b: this.speed2d(b, now),
      health_a: num(a.health),
      health_b: num(b.health),
      armor_a: num(a.armor),
      armor_b: num(b.armor),
      weapon_class_a: wclass(a),
      weapon_class_b: wclass(b),
      alive_t: alive("T"),
      alive_ct: alive("CT"),
      round_time_s: roundTime,
    };
  }

  /** Model probability for every alive, positioned T × CT pair, with the baseline 2 s estimate. */
  predict(state: MatchState, baseline: InteractionFeatures | null): PairPrediction[] {
    if (state.roundPhase !== "live") return [];
    const ts = state.players.filter((p) => p.side === "T" && p.lifeState === "alive" && p.position);
    const cts = state.players.filter((p) => p.side === "CT" && p.lifeState === "alive" && p.position);
    const out: PairPrediction[] = [];
    for (const a of ts) {
      for (const b of cts) {
        const f = this.features(state, a, b);
        const base = baseline?.pairs.find((pr) => pr.t === a.steamId && pr.ct === b.steamId)?.contact["2"] ?? null;
        out.push({ t: a.steamId, ct: b.steamId, probability: this.gbdt.predict(this.gbdt.vector(f)), baseline: base });
      }
    }
    return out.sort((x, y) => y.probability - x.probability);
  }
}

/** Player features of `pov_2s`, in model order: must match `POV_FEATURES` in `workers/training/mf_training/pov.py`. */
export const LIVE_POV_FEATURES = [
  "side_t",
  "health",
  "armor",
  "speed",
  "weapon_class",
  "alive_own",
  "alive_opp",
  "round_time_s",
  "round_kills",
  "nearest_dist",
  "nearest_facing_self",
  "nearest_facing_opp",
  "opp_within_1000",
  "opp_within_2000",
  "max_facing_self_2000",
  "max_facing_opp_2000",
  "max_closing",
  "heur_max",
  "heur_sum",
] as const;
/** Must match NEAR_1 / NEAR_2 in pov.py. */
const NEAR_1 = 1000;
const NEAR_2 = 2000;

/** The `contact_2s` heuristic of one pair (`pair_heuristic` in pov.py). */
function pairHeuristic(dist: number, facingMax: number): number {
  const f = Number.isNaN(facingMax) ? -1 : facingMax;
  const d = Number.isNaN(dist) ? 4000 : dist;
  return Math.min(1, Math.max(0, (f + 1) / 2)) ** 2 * Math.exp(-d / 1000);
}

/** NaN-ignoring max, NaN when nothing is known (polars `max` over nulls). */
function nanMax(xs: number[]): number {
  let m = Number.NaN;
  for (const x of xs) if (!Number.isNaN(x) && (Number.isNaN(m) || x > m)) m = x;
  return m;
}

/**
 * The demo-trained POV model: per alive player, the chance their POV shows a kill within 2 s,
 * from the same pair vectors as `contact_2s`, aggregated per player like `pov.py`. Feeds the
 * director's imminence when the operator turns it on (never alone: blended with the baseline).
 */
export class LivePovModel extends LiveContactModel {
  /** The same model with no history (a replay must not share the live model's round state). */
  fresh(): LivePovModel {
    return new LivePovModel(this.id, this.card, this.gbdt, this.sha256);
  }

  povFeatures(state: MatchState): Map<string, Record<(typeof LIVE_POV_FEATURES)[number], number>> {
    const out = new Map<string, Record<(typeof LIVE_POV_FEATURES)[number], number>>();
    if (state.roundPhase !== "live") return out;
    const ts = state.players.filter((p) => p.side === "T" && p.lifeState === "alive" && p.position);
    const cts = state.players.filter((p) => p.side === "CT" && p.lifeState === "alive" && p.position);
    const views = new Map<string, { self: PlayerState; t: boolean; rows: { d: number; fs: number; fo: number; closing: number; heur: number; pair: ReturnType<LiveContactModel["features"]> }[] }>();
    for (const a of ts) {
      for (const b of cts) {
        const f = this.features(state, a, b);
        const heur = pairHeuristic(f.dist_3d, f.facing_max);
        for (const [self, t, fs, fo] of [[a, true, f.facing_a, f.facing_b], [b, false, f.facing_b, f.facing_a]] as const) {
          const v = views.get(self.steamId) ?? { self, t, rows: [] };
          v.rows.push({ d: f.dist_3d, fs, fo, closing: f.closing_speed, heur, pair: f });
          views.set(self.steamId, v);
        }
      }
    }
    for (const [id, v] of views) {
      const f0 = v.rows[0]!.pair;
      let nearest = v.rows[0]!;
      for (const r of v.rows) if (r.d < nearest.d) nearest = r;
      const near2 = v.rows.filter((r) => r.d <= NEAR_2);
      out.set(id, {
        side_t: v.t ? 1 : 0,
        health: v.t ? f0.health_a : f0.health_b,
        armor: v.t ? f0.armor_a : f0.armor_b,
        speed: v.t ? f0.speed_a : f0.speed_b,
        weapon_class: v.t ? f0.weapon_class_a : f0.weapon_class_b,
        alive_own: v.t ? f0.alive_t : f0.alive_ct,
        alive_opp: v.t ? f0.alive_ct : f0.alive_t,
        round_time_s: f0.round_time_s,
        round_kills: v.self.roundKills ?? 0,
        nearest_dist: nearest.d,
        nearest_facing_self: nearest.fs,
        nearest_facing_opp: nearest.fo,
        opp_within_1000: v.rows.filter((r) => r.d <= NEAR_1).length,
        opp_within_2000: near2.length,
        max_facing_self_2000: nanMax(near2.map((r) => r.fs)),
        max_facing_opp_2000: nanMax(near2.map((r) => r.fo)),
        max_closing: nanMax(v.rows.map((r) => r.closing)),
        heur_max: Math.max(...v.rows.map((r) => r.heur)),
        heur_sum: v.rows.reduce((s, r) => s + r.heur, 0),
      });
    }
    return out;
  }

  /** Probability per alive player with an alive opponent (live rounds only). */
  predictPlayers(state: MatchState): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, f] of this.povFeatures(state)) out.set(id, this.gbdt.predict(this.gbdt.vector(f)));
    return out;
  }
}

/** Bounded shadow comparison between a model and the baseline contact estimate. */
export class ShadowComparison {
  samples = 0;
  pairs = 0;
  topPairAgreement = 0;
  sumAbsDiff = 0;
  readonly recent: { atMs: number; round: number | null; top: PairPrediction[] }[] = [];

  record(atMs: number, round: number | null, preds: PairPrediction[]): void {
    if (preds.length === 0) return;
    this.samples++;
    const withBase = preds.filter((p) => p.baseline !== null);
    this.pairs += withBase.length;
    for (const p of withBase) this.sumAbsDiff += Math.abs(p.probability - p.baseline!);
    const modelTop = preds[0]!;
    const baseTop = [...withBase].sort((x, y) => y.baseline! - x.baseline!)[0];
    if (baseTop && baseTop.t === modelTop.t && baseTop.ct === modelTop.ct) this.topPairAgreement++;
    this.recent.push({ atMs, round, top: preds.slice(0, 5) });
    if (this.recent.length > 200) this.recent.shift();
  }

  summary() {
    return {
      samples: this.samples,
      meanAbsDiffVsBaseline: this.pairs ? this.sumAbsDiff / this.pairs : null,
      topPairAgreementRate: this.samples ? this.topPairAgreement / this.samples : null,
    };
  }
}
