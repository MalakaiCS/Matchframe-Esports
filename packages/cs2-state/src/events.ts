import type { EvidenceType, PlayerState, Side, Vec3 } from "@matchframe/contracts";
import { hash53 } from "./hash.ts";

/**
 * Events derived from snapshot changes. Each carries its evidence level:
 * - "measured": a state value reported by the source (e.g. bomb state string)
 * - "derived": deterministic from measured deltas (e.g. a kill counter increased)
 * - "estimated": inference that may be wrong (e.g. pairing a killer with a victim)
 * Snapshot-derived events never carry weapon, headshot-victim or assist detail that the
 * source did not report.
 */
export type DerivedEventKind =
  | "round_phase"
  | "round_end"
  | "player_died"
  | "player_respawned"
  | "kills_increased"
  | "probable_kill_link"
  | "damage_taken"
  | "bomb_state"
  | "observer_changed"
  | "epoch_changed"
  | "game_phase";

export interface DerivedEvent {
  eventId: string;
  kind: DerivedEventKind;
  sessionId: string;
  epoch: number;
  roundAttemptId: string | null;
  sequence: number;
  receivedAtMonotonicMs: number;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
  evidence: EvidenceType;
  confidence: number;
  data: Record<string, unknown>;
}

export interface EventScope {
  sessionId: string;
  epoch: number;
  roundAttemptId: string | null;
  sequence: number;
  receivedAtMonotonicMs: number;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
}

/** Stable IDs: the same change re-derived from a duplicate packet produces the same ID. */
export function stableEventId(scope: EventScope, kind: string, subject: string, ordinal: number | string): string {
  return `ev_${hash53(`${scope.sessionId}|${scope.epoch}|${scope.roundAttemptId}|${kind}|${subject}|${ordinal}`)}`;
}

export function makeEvent(
  scope: EventScope,
  kind: DerivedEventKind,
  subject: string,
  ordinal: number | string,
  evidence: EvidenceType,
  confidence: number,
  data: Record<string, unknown>,
): DerivedEvent {
  return {
    eventId: stableEventId(scope, kind, subject, ordinal),
    kind,
    sessionId: scope.sessionId,
    epoch: scope.epoch,
    roundAttemptId: scope.roundAttemptId,
    sequence: scope.sequence,
    receivedAtMonotonicMs: scope.receivedAtMonotonicMs,
    matchTimeMs: scope.matchTimeMs,
    timeUncertaintyMs: scope.timeUncertaintyMs,
    evidence,
    confidence,
    data,
  };
}

/** Player-level derived events between two consecutive canonical player sets. */
export function derivePlayerEvents(
  scope: EventScope,
  prev: ReadonlyMap<string, PlayerState>,
  next: ReadonlyMap<string, PlayerState>,
): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  const deaths: { steamId: string; side: Side | null; position: Vec3 | null }[] = [];
  const killers: { steamId: string; side: Side | null; delta: number; hsDelta: number | null }[] = [];

  for (const [sid, n] of next) {
    const p = prev.get(sid);
    if (!p) continue;
    if (p.lifeState === "alive" && n.lifeState === "dead") {
      const ordinal = n.matchStats.deaths ?? `${scope.sequence}`;
      events.push(
        makeEvent(scope, "player_died", sid, ordinal, "derived", 0.95, {
          steamId: sid,
          side: n.side,
          lastKnownPosition: p.position,
          weapon: null,
          killer: null,
          headshot: null,
          note: "life state transition; killer, weapon and headshot are not reported by this source",
        }),
      );
      deaths.push({ steamId: sid, side: n.side, position: p.position });
    } else if (p.lifeState === "dead" && n.lifeState === "alive") {
      events.push(makeEvent(scope, "player_respawned", sid, scope.sequence, "derived", 0.9, { steamId: sid }));
    }
    const pk = p.matchStats.kills;
    const nk = n.matchStats.kills;
    if (pk !== null && nk !== null && nk > pk) {
      const prk = p.roundKillsHeadshot;
      const nrk = n.roundKillsHeadshot;
      const hsDelta = prk !== null && nrk !== null && nrk >= prk ? nrk - prk : null;
      killers.push({ steamId: sid, side: n.side, delta: nk - pk, hsDelta });
      events.push(
        makeEvent(scope, "kills_increased", sid, nk, "derived", 0.95, {
          steamId: sid,
          side: n.side,
          delta: nk - pk,
          headshotCounterDelta: hsDelta,
          victim: null,
          weapon: null,
          note: "cumulative counter change; victim, weapon and order are not reported by this source",
        }),
      );
    }
    if (p.health !== null && n.health !== null && n.health < p.health && n.lifeState !== "unknown") {
      events.push(
        makeEvent(scope, "damage_taken", sid, `${scope.sequence}`, "derived", 0.9, {
          steamId: sid,
          amount: p.health - n.health,
          attacker: null,
          cause: null,
          note: "health delta only; attacker and cause are not reported by this source",
        }),
      );
    }
  }

  // A single kill increase and a single opposite-side death in the same packet is a plausible
  // pairing, but only an estimate (team kills, bomb deaths, world damage and batching exist).
  if (killers.length === 1 && deaths.length === 1) {
    const k = killers[0]!;
    const d = deaths[0]!;
    if (k.delta === 1 && k.side !== null && d.side !== null && k.side !== d.side) {
      events.push(
        makeEvent(scope, "probable_kill_link", `${k.steamId}>${d.steamId}`, scope.sequence, "estimated", 0.7, {
          killer: k.steamId,
          victim: d.steamId,
          headshot: k.hsDelta === 1 ? "probable" : k.hsDelta === 0 ? "probably_not" : null,
          note: "estimated pairing from simultaneous counter changes; not an exact kill event",
        }),
      );
    }
  }
  return events;
}

/** Bounded de-duplication set for derived event IDs. */
export class EventDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 20000) {}

  accept(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    this.order.push(eventId);
    if (this.order.length > this.capacity) {
      const old = this.order.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }
}
