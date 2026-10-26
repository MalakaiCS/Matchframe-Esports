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

/** Validates an exported model directory; never throws. */
export function loadContactModel(dir: string, modelId: string): ModelLoadResult {
  try {
    const cardPath = join(dir, "model_card.json");
    if (!existsSync(cardPath)) return { ok: false, reason: "model_card.json missing" };
    const card = JSON.parse(readFileSync(cardPath, "utf8")) as ModelCard;
    if (card.task !== "contact_2s") return { ok: false, reason: `unsupported task ${String(card.task)}` };
    for (const cap of card.required_capabilities ?? []) if (!LIVE_CAPABILITIES.has(cap)) return { ok: false, reason: `requires capability ${cap}, which a live GSI feed does not provide` };
    const known = new Set<string>(LIVE_CONTACT_FEATURES);
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
    return { ok: true, model: new LiveContactModel(modelId, card, gbdt, sha) };
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
    private readonly gbdt: GbdtModel,
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
