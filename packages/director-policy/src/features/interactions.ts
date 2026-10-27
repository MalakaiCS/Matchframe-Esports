import type { MatchState, PlayerState, Side, Vec3 } from "@matchframe/contracts";
import type { DirectorConfig } from "../config.ts";
import type { StateHistory } from "../history.ts";

export interface SpatialContext {
  levelAt(p: Vec3): string | null;
  regionsAt(p: Vec3): string[];
  /** Walking path distance if a navigation graph is available; null otherwise. */
  pathDistance?(a: Vec3, b: Vec3): number | null;
  /** True only when verified visibility geometry exists for this map revision. */
  hasVisibilityGeometry?: boolean;
}

export interface PairFeature {
  t: string;
  ct: string;
  distance: number;
  pathDistance: number | null;
  dz: number;
  closingSpeed: number | null;
  /** cos of angle between T's view and direction to CT (and vice versa); null when unknown. */
  facingTtoCT: number | null;
  facingCTtoT: number | null;
  sameLevel: boolean | null;
  /** Heuristic separation by floors/elevation. Unknown obstruction is NOT treated as clear. */
  separated: boolean;
  dataAgeMs: number;
  /** Probability of contact within each horizon (keys are horizon seconds as strings). */
  contact: Record<string, number>;
  confidence: number;
}

export interface Cluster {
  id: string;
  members: string[];
  tCount: number;
  ctCount: number;
  centroid: Vec3;
  levelId: string | null;
  regionIds: string[];
  /** P(at least one contact within 2 s) across the cluster's opponent pairs. */
  actionValue: number;
  maxContact: Record<string, number>;
  pairs: PairFeature[];
}

export interface TeamGroup {
  side: Side;
  members: string[];
  centroid: Vec3;
  regionIds: string[];
  hasBomb: boolean;
}

export interface InteractionFeatures {
  pairs: PairFeature[];
  clusters: Cluster[];
  groups: TeamGroup[];
  /** Largest T group (≥2 alive): evidence of a developing main story, not a rule to follow Ts. */
  mainStory: TeamGroup | null;
  isolatedAggressors: { steamId: string; side: Side; targetSteamId: string; contact2s: number }[];
  crossfires: { defenders: [string, string]; target: string; angleDeg: number }[];
  byPlayer: Map<string, { bestPair: PairFeature | null; clusterId: string | null; imminence: number; contact: Record<string, number> }>;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function alivePositioned(state: MatchState): PlayerState[] {
  return state.players.filter((p) => p.lifeState === "alive" && p.position !== null && p.side !== null);
}

function facing(from: PlayerState, to: Vec3): number | null {
  if (!from.forward || !from.position) return null;
  const dx = to.x - from.position.x;
  const dy = to.y - from.position.y;
  const dl = Math.hypot(dx, dy);
  const fl = Math.hypot(from.forward.x, from.forward.y);
  if (dl < 1 || fl < 1e-6) return null;
  return (dx * from.forward.x + dy * from.forward.y) / (dl * fl);
}

function key(h: number): string {
  return String(h);
}

export function computePair(
  t: PlayerState,
  ct: PlayerState,
  now: number,
  cfg: DirectorConfig,
  spatial: SpatialContext | undefined,
  history: StateHistory | undefined,
): PairFeature {
  const a = t.position!;
  const b = ct.position!;
  const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const pathDistance = spatial?.pathDistance?.(a, b) ?? null;
  const dz = Math.abs(a.z - b.z);
  const la = spatial?.levelAt(a) ?? null;
  const lb = spatial?.levelAt(b) ?? null;
  const sameLevel = la !== null && lb !== null ? la === lb : null;
  const horiz = Math.hypot(a.x - b.x, a.y - b.y);
  // Close horizontally but far apart vertically, or on different levels: likely separated by floors.
  const separated = sameLevel === false || (dz > 220 && horiz < 600);

  let closingSpeed: number | null = null;
  const va = history?.velocity(t.steamId) ?? null;
  const vb = history?.velocity(ct.steamId) ?? null;
  if (va || vb) {
    const ux = (b.x - a.x) / (horiz || 1);
    const uy = (b.y - a.y) / (horiz || 1);
    const sa = va ? va.x * ux + va.y * uy : 0;
    const sb = vb ? -(vb.x * ux + vb.y * uy) : 0;
    closingSpeed = sa + sb;
  }
  const fT = facing(t, b);
  const fC = facing(ct, a);
  const ageT = t.positionObservedAtMonotonicMs !== null ? now - t.positionObservedAtMonotonicMs : 5000;
  const ageC = ct.positionObservedAtMonotonicMs !== null ? now - ct.positionObservedAtMonotonicMs : 5000;
  const dataAgeMs = Math.max(0, ageT, ageC);

  const dEff = pathDistance ?? distance;
  const engage = cfg.contact.engageRangeUnits;
  const mutualFacing = fT !== null && fC !== null ? (Math.max(0, fT) + Math.max(0, fC)) / 2 : fT !== null ? Math.max(0, fT) * 0.5 : fC !== null ? Math.max(0, fC) * 0.5 : 0.2;
  const approach = closingSpeed === null ? 0.3 : Math.max(0, Math.min(1, closingSpeed / 250));
  const strongEvidence = fT !== null && fC !== null && fT > 0.9 && fC > 0.9 && !separated;
  const cap = spatial?.hasVisibilityGeometry ? 0.97 : strongEvidence ? 0.9 : cfg.contact.noGeometryCap;
  const staleness = Math.exp(-Math.max(0, dataAgeMs - 200) / 1500);

  const contact: Record<string, number> = {};
  for (const h of cfg.contact.horizonsSec) {
    let p: number;
    if (dEff <= engage) {
      // Contact hazard grows with mutual facing and proximity; approach speeds it up.
      const rate = 0.2 + 3.0 * mutualFacing * mutualFacing * (1 - (0.6 * dEff) / engage) + 0.8 * approach;
      p = 1 - Math.exp(-rate * h);
    } else {
      const speed = closingSpeed !== null && closingSpeed > 40 ? closingSpeed : closingSpeed !== null ? 40 : 110;
      const ttc = (dEff - engage) / speed;
      p = sigmoid(2.2 * (h - ttc)) * (0.5 + 0.5 * mutualFacing);
    }
    if (separated) p *= 0.3;
    p = Math.min(cap, p) * staleness;
    contact[key(h)] = Math.max(0, Math.min(1, p));
  }
  const confidence =
    (dataAgeMs < cfg.positionStaleMs ? 1 : 0.5) *
    (spatial?.hasVisibilityGeometry ? 1 : 0.6) *
    (closingSpeed !== null ? 1 : 0.8) *
    (pathDistance !== null ? 1 : 0.85);
  return { t: t.steamId, ct: ct.steamId, distance, pathDistance, dz, closingSpeed, facingTtoCT: fT, facingCTtoT: fC, sameLevel, separated, dataAgeMs, contact, confidence };
}

function centroidOf(players: PlayerState[]): Vec3 {
  const n = players.length || 1;
  return {
    x: players.reduce((s, p) => s + p.position!.x, 0) / n,
    y: players.reduce((s, p) => s + p.position!.y, 0) / n,
    z: players.reduce((s, p) => s + p.position!.z, 0) / n,
  };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function computeInteractions(
  state: MatchState,
  now: number,
  cfg: DirectorConfig,
  spatial?: SpatialContext,
  history?: StateHistory,
): InteractionFeatures {
  const alive = alivePositioned(state);
  const ts = alive.filter((p) => p.side === "T");
  const cts = alive.filter((p) => p.side === "CT");
  const pairs: PairFeature[] = [];
  for (const t of ts) for (const ct of cts) pairs.push(computePair(t, ct, now, cfg, spatial, history));

  const byId = new Map(alive.map((p) => [p.steamId, p]));
  const R = cfg.grouping.teamGroupRadius;

  // Team groups (single linkage within radius, same level when known).
  const groups: TeamGroup[] = [];
  for (const side of ["T", "CT"] as const) {
    const members = alive.filter((p) => p.side === side);
    const uf = new UnionFind();
    for (const p of members) uf.find(p.steamId);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        const d = Math.hypot(a.position!.x - b.position!.x, a.position!.y - b.position!.y, a.position!.z - b.position!.z);
        const la = spatial?.levelAt(a.position!) ?? null;
        const lb = spatial?.levelAt(b.position!) ?? null;
        if (d <= R && (la === null || lb === null || la === lb)) uf.union(a.steamId, b.steamId);
      }
    }
    const buckets = new Map<string, PlayerState[]>();
    for (const p of members) {
      const r = uf.find(p.steamId);
      buckets.set(r, [...(buckets.get(r) ?? []), p]);
    }
    for (const list of buckets.values()) {
      const c = centroidOf(list);
      groups.push({
        side,
        members: list.map((p) => p.steamId),
        centroid: c,
        regionIds: spatial?.regionsAt(c) ?? [],
        hasBomb: state.bomb?.state === "carried" && list.some((p) => p.steamId === state.bomb?.carrierSteamId),
      });
    }
  }
  const tGroups = groups.filter((g) => g.side === "T").sort((a, b) => b.members.length - a.members.length);
  const mainStory = tGroups[0] && tGroups[0].members.length >= 2 ? tGroups[0] : null;

  // Interaction clusters: opponents likely to make contact, plus nearby teammates (trade support).
  const uf = new UnionFind();
  const linked = new Set<string>();
  for (const pr of pairs) {
    if ((pr.contact["2"] ?? 0) >= 0.25) {
      uf.union(pr.t, pr.ct);
      linked.add(pr.t);
      linked.add(pr.ct);
    }
  }
  for (const p of alive) {
    if (linked.has(p.steamId)) continue;
    for (const q of alive) {
      if (q.side !== p.side || !linked.has(q.steamId)) continue;
      const d = Math.hypot(p.position!.x - q.position!.x, p.position!.y - q.position!.y, p.position!.z - q.position!.z);
      if (d <= cfg.grouping.tradeRadius) {
        uf.union(p.steamId, q.steamId);
        break;
      }
    }
  }
  const linkedRoots = new Set([...linked].map((l) => uf.find(l)));
  const clusterMembers = new Map<string, string[]>();
  for (const p of alive) {
    const r = uf.find(p.steamId);
    if (!linkedRoots.has(r)) continue;
    clusterMembers.set(r, [...(clusterMembers.get(r) ?? []), p.steamId]);
  }
  const clusters: Cluster[] = [];
  let ci = 0;
  for (const members of clusterMembers.values()) {
    const set = new Set(members);
    const cp = pairs.filter((pr) => set.has(pr.t) && set.has(pr.ct));
    if (cp.length === 0) continue;
    const maxContact: Record<string, number> = {};
    for (const h of cfg.contact.horizonsSec) maxContact[key(h)] = Math.max(...cp.map((pr) => pr.contact[key(h)] ?? 0));
    const actionValue = 1 - cp.reduce((acc, pr) => acc * (1 - (pr.contact["2"] ?? 0)), 1);
    const ps = members.map((m) => byId.get(m)!);
    const c = centroidOf(ps);
    clusters.push({
      id: `cluster-${ci++}`,
      members: members.slice().sort(),
      tCount: ps.filter((p) => p.side === "T").length,
      ctCount: ps.filter((p) => p.side === "CT").length,
      centroid: c,
      levelId: spatial?.levelAt(c) ?? null,
      regionIds: spatial?.regionsAt(c) ?? [],
      actionValue,
      maxContact,
      pairs: cp,
    });
  }
  clusters.sort((a, b) => b.actionValue - a.actionValue);
  clusters.forEach((c, i) => (c.id = `cluster-${i}`));

  // Isolated aggressors: moving toward an opponent with no teammate nearby.
  const isolatedAggressors: InteractionFeatures["isolatedAggressors"] = [];
  for (const p of alive) {
    const mates = alive.filter((q) => q.side === p.side && q.steamId !== p.steamId);
    const nearMate = mates.some(
      (q) => Math.hypot(p.position!.x - q.position!.x, p.position!.y - q.position!.y, p.position!.z - q.position!.z) <= R,
    );
    if (nearMate) continue;
    const own = pairs.filter((pr) => (p.side === "T" ? pr.t : pr.ct) === p.steamId);
    const best = own.sort((a, b) => (b.contact["2"] ?? 0) - (a.contact["2"] ?? 0))[0];
    if (!best || best.closingSpeed === null || best.closingSpeed < 120) continue;
    if ((best.contact["2"] ?? 0) < 0.4) continue;
    isolatedAggressors.push({ steamId: p.steamId, side: p.side!, targetSteamId: p.side === "T" ? best.ct : best.t, contact2s: best.contact["2"] ?? 0 });
  }

  // Crossfires: two defenders facing the same approaching opponent from meaningfully different angles.
  const crossfires: InteractionFeatures["crossfires"] = [];
  for (const target of alive) {
    const defenders = alive.filter((d) => d.side !== target.side && d.forward);
    for (let i = 0; i < defenders.length; i++) {
      for (let j = i + 1; j < defenders.length; j++) {
        const d1 = defenders[i]!;
        const d2 = defenders[j]!;
        const f1 = facing(d1, target.position!);
        const f2 = facing(d2, target.position!);
        if (f1 === null || f2 === null || f1 < 0.6 || f2 < 0.6) continue;
        const pr1 = pairs.find((pr) => (pr.t === target.steamId && pr.ct === d1.steamId) || (pr.ct === target.steamId && pr.t === d1.steamId));
        const pr2 = pairs.find((pr) => (pr.t === target.steamId && pr.ct === d2.steamId) || (pr.ct === target.steamId && pr.t === d2.steamId));
        if (!pr1 || !pr2 || pr1.separated || pr2.separated) continue;
        if (pr1.distance > 2200 || pr2.distance > 2200) continue;
        const a1 = Math.atan2(d1.position!.y - target.position!.y, d1.position!.x - target.position!.x);
        const a2 = Math.atan2(d2.position!.y - target.position!.y, d2.position!.x - target.position!.x);
        let diff = Math.abs(((a1 - a2) * 180) / Math.PI) % 360;
        if (diff > 180) diff = 360 - diff;
        if (diff >= 35) crossfires.push({ defenders: [d1.steamId, d2.steamId], target: target.steamId, angleDeg: diff });
      }
    }
  }

  const byPlayer: InteractionFeatures["byPlayer"] = new Map();
  for (const p of alive) {
    const own = pairs.filter((pr) => pr.t === p.steamId || pr.ct === p.steamId);
    const contact: Record<string, number> = {};
    for (const h of cfg.contact.horizonsSec) contact[key(h)] = own.length ? Math.max(...own.map((pr) => pr.contact[key(h)] ?? 0)) : 0;
    const best = own.slice().sort((a, b) => (b.contact["2"] ?? 0) - (a.contact["2"] ?? 0))[0] ?? null;
    const imminence = Math.max((contact["0.5"] ?? 0) * 1.0, (contact["1"] ?? 0) * 0.95, (contact["2"] ?? 0) * 0.8, (contact["3"] ?? 0) * 0.6);
    const cluster = clusters.find((c) => c.members.includes(p.steamId)) ?? null;
    byPlayer.set(p.steamId, { bestPair: best, clusterId: cluster?.id ?? null, imminence, contact });
  }
  return { pairs, clusters, groups, mainStory, isolatedAggressors, crossfires, byPlayer };
}
