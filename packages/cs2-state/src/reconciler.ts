import type {
  BombState,
  BombStateKind,
  GamePhase,
  MapPhase,
  MatchState,
  ObserverState,
  PlayerState,
  RoundPhase,
  RoundResult,
  RoundWinReason,
  Side,
  SourceHealth,
  TeamState,
  UtilityItem,
  Vec3,
} from "@matchframe/contracts";
import { MatchClock } from "./clock.ts";
import { detectEpochChange } from "./epoch.ts";
import type { EpochChangeReason, EpochSignals } from "./epoch.ts";
import type { DerivedEvent, EventScope } from "./events.ts";
import { derivePlayerEvents, EventDeduper, makeEvent } from "./events.ts";
import { detectCoaches, observerKeys } from "./roles.ts";
import type { GsiObservation, ObservedPlayer, TeamObservation } from "./gsi/normalize.ts";
import type { TrackerPlayerView, UtilityMapContext, UtilityTrackerEvent } from "./utility/tracker.ts";
import { UtilityTracker } from "./utility/tracker.ts";
import type { UtilityTrackerOptions } from "./utility/tracker.ts";

export interface RosterResolution {
  playerId: string;
  teamId: string | null;
  displayName: string | null;
  /** A coach in the team's roster. */
  coach?: boolean;
}

export interface MatchStateStoreOptions {
  sessionId: string;
  /** Source whose observations form match truth. Others are tracked for health/lookahead only. */
  primarySourceId?: string | null;
  resolveRoster?: (steamId: string) => RosterResolution | null;
  /** The operator's say on whether a player is a coach (true / false), or null to detect it. */
  coachOverride?: (steamId: string) => boolean | null;
  mapContextFor?: (mapName: string) => (UtilityMapContext & { siteAt?(p: Vec3): "A" | "B" | null }) | undefined;
  /** Source silence (ms) after which state is marked stale. */
  staleAfterMs?: number;
  /** Players absent from an authoritative player list are dropped after this long. */
  absentPlayerRetentionMs?: number;
  simulated?: boolean;
  tracker?: UtilityTrackerOptions;
}

export interface IngestResult {
  accepted: boolean;
  reason: "ok" | "duplicate" | "out_of_order" | "non_primary_source";
  epochChanged: EpochChangeReason | null;
  events: DerivedEvent[];
  utilityEvents: UtilityTrackerEvent[];
  sequence: number;
}

interface SourceRecord {
  health: SourceHealth;
  lastHash: string | null;
  lastHashAtMs: number;
  lastProviderTimestamp: number | null;
  intervals: number[];
}

const WIN_REASONS: ReadonlySet<string> = new Set([
  "ct_win_elimination",
  "t_win_elimination",
  "ct_win_defuse",
  "t_win_bomb",
  "ct_win_time",
  "ct_win_rescue",
  "t_win_time",
]);

function emptyTeam(side: Side): TeamState {
  return {
    side,
    teamId: null,
    name: null,
    score: null,
    consecutiveRoundLosses: null,
    timeoutsRemaining: null,
    matchesWonThisSeries: null,
  };
}

function bombKind(s: string | null): BombStateKind {
  switch (s) {
    case "carried":
    case "dropped":
    case "planting":
    case "planted":
    case "defusing":
    case "defused":
    case "exploded":
      return s;
    default:
      return "unknown";
  }
}

/**
 * Reconciles normalized observations into canonical match truth (spec §6.3–6.5).
 * Raw observations are kept separate from the reconciled state; unknown stays unknown.
 */
export class MatchStateStore {
  readonly sessionId: string;
  private primarySourceId: string | null;
  private readonly opts: MatchStateStoreOptions;
  private epoch = 0;
  private sequence = 0;
  private lastSignals: EpochSignals | null = null;
  private readonly clock = new MatchClock();
  private readonly deduper = new EventDeduper();
  private readonly tracker: UtilityTracker;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly roundAttemptCounters = new Map<number, number>();

  private mapName: string | null = null;
  private mapPhase: MapPhase = "unknown";
  private roundNumber: number | null = null;
  private roundAttemptId: string | null = null;
  private roundPhase: RoundPhase = "unknown";
  private gamePhase: GamePhase = "unknown";
  private phaseEndsInSec: number | null = null;
  private phaseObservedAt: number | null = null;
  private teams: { CT: TeamState; T: TeamState } = { CT: emptyTeam("CT"), T: emptyTeam("T") };
  private players = new Map<string, PlayerState>();
  /** Coaches the game data showed (see detectCoaches), and the roster's coaches, by steamId. */
  private readonly coaches = new Set<string>();
  private readonly rosterCoaches = new Set<string>();
  private absentSince = new Map<string, number>();
  private bomb: BombState | null = null;
  private roundHistory: RoundResult[] = [];
  private observer: ObserverState = {
    observedSteamId: null,
    observedSlot: null,
    cameraMode: "unknown",
    confirmedAtMonotonicMs: null,
    providerSteamId: null,
    evidence: "unknown",
  };
  private lastReceivedAt = 0;
  private lastMatchTimeMs: number | null = null;

  constructor(opts: MatchStateStoreOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.primarySourceId = opts.primarySourceId ?? null;
    this.tracker = new UtilityTracker(opts.tracker);
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  setPrimarySource(sourceId: string | null): void {
    this.primarySourceId = sourceId;
  }

  ingest(obs: GsiObservation): IngestResult {
    const src = this.sourceRecord(obs.sourceId);
    const now = obs.receivedAtMonotonicMs;
    // Duplicate payload (e.g. HTTP retry) from the same source shortly after the previous one.
    if (src.lastHash === obs.payloadHash && now - src.lastHashAtMs < 2000) {
      src.health.packetsRejected++;
      return this.reject("duplicate");
    }
    if (
      obs.providerTimestampSec !== null &&
      src.lastProviderTimestamp !== null &&
      obs.providerTimestampSec < src.lastProviderTimestamp - 1
    ) {
      src.health.packetsRejected++;
      return this.reject("out_of_order");
    }
    if (src.health.lastPacketMonotonicMs !== null) {
      src.intervals.push(now - src.health.lastPacketMonotonicMs);
      if (src.intervals.length > 50) src.intervals.shift();
      src.health.meanIntervalMs = src.intervals.reduce((a, b) => a + b, 0) / src.intervals.length;
    }
    src.lastHash = obs.payloadHash;
    src.lastHashAtMs = now;
    src.lastProviderTimestamp = obs.providerTimestampSec ?? src.lastProviderTimestamp;
    src.health.lastPacketMonotonicMs = now;
    src.health.packetsReceived++;
    src.health.connected = true;
    src.health.stale = false;
    if (obs.gameVersion !== null) src.health.gameBuild = String(obs.gameVersion);

    if (this.primarySourceId === null) this.primarySourceId = obs.sourceId;
    if (obs.sourceId !== this.primarySourceId) return this.reject("non_primary_source");

    const events: DerivedEvent[] = [];
    let utilityEvents: UtilityTrackerEvent[] = [];

    // --- epoch / discontinuity detection -------------------------------------------------
    const signals: EpochSignals = {
      mapName: obs.map?.name ?? this.mapName,
      roundNumber: obs.map?.round !== undefined && obs.map?.round !== null ? obs.map.round + 1 : this.roundNumber,
      mapPhase: obs.map?.phase ?? this.mapPhase,
      providerSteamId: obs.providerSteamId,
      scoreCT: obs.map?.ct?.score ?? null,
      scoreT: obs.map?.t?.score ?? null,
      receivedAtMonotonicMs: now,
    };
    const epochChange = detectEpochChange(this.lastSignals, signals);
    if (epochChange) {
      const prevEpoch = this.epoch;
      this.epoch = epochChange === "first_packet" ? Math.max(1, this.epoch) : this.epoch + 1;
      if (epochChange !== "first_packet") {
        utilityEvents = utilityEvents.concat(
          this.tracker.reset(epochChange === "map_change" ? "map_change" : "epoch_reset", now),
        );
        this.clock.reset();
        this.bomb = null;
        if (epochChange === "map_change" || epochChange === "phase_restart" || epochChange === "provider_change") {
          this.players.clear();
          this.coaches.clear();
          this.absentSince.clear();
        }
        if (epochChange === "map_change" || epochChange === "phase_restart") {
          this.roundHistory = [];
          this.roundAttemptCounters.clear();
        }
      }
      if (epochChange !== "first_packet") {
        events.push(
          makeEvent(this.scope(now), "epoch_changed", "epoch", this.epoch, "derived", 1, {
            reason: epochChange,
            previousEpoch: prevEpoch,
            epoch: this.epoch,
          }),
        );
      }
    }
    this.lastSignals = signals;
    this.sequence++;
    this.lastReceivedAt = now;

    // --- map / round / phase ---------------------------------------------------------------
    const prevRoundPhase = this.roundPhase;
    const prevRound = this.roundNumber;
    if (obs.map) {
      if (obs.map.name !== null && obs.map.name !== this.mapName) {
        this.mapName = obs.map.name;
        this.tracker.setMapContext(this.opts.mapContextFor?.(obs.map.name));
      }
      this.mapPhase = obs.map.phase;
      if (obs.map.round !== null) this.roundNumber = obs.map.round + 1;
      this.applyTeam("CT", obs.map.ct);
      this.applyTeam("T", obs.map.t);
    }
    if (obs.round) this.roundPhase = obs.round.phase;
    if (obs.phase) {
      this.gamePhase = obs.phase.phase;
      this.phaseEndsInSec = obs.phase.endsInSec;
      this.phaseObservedAt = now;
    } else if (obs.round) {
      this.gamePhase = obs.round.phase === "unknown" ? this.gamePhase : obs.round.phase;
    }
    if (this.mapPhase === "intermission") this.gamePhase = "halftime";
    if (this.mapPhase === "gameover") this.gamePhase = "gameover";

    if (this.roundNumber !== null && (this.roundNumber !== prevRound || this.roundAttemptId === null || epochChange)) {
      const n = (this.roundAttemptCounters.get(this.roundNumber) ?? 0) + 1;
      this.roundAttemptCounters.set(this.roundNumber, n);
      this.roundAttemptId = `e${this.epoch}.r${this.roundNumber}.a${n}`;
      if (epochChange === "round_regression" || epochChange === "score_regression") {
        // Restored round: discard results from rounds that will be replayed (kept in audit by caller).
        this.roundHistory = this.roundHistory.filter((r) => r.roundNumber < this.roundNumber!);
      }
    }

    const paused = this.isPaused();
    const running = !paused && (this.gamePhase === "live" || this.gamePhase === "bomb" || this.gamePhase === "defuse" || this.roundPhase === "live");
    this.lastMatchTimeMs = this.clock.observe(now, { running });
    const scope = this.scope(now);

    if (prevRoundPhase !== this.roundPhase) {
      events.push(
        makeEvent(scope, "round_phase", `round-${this.roundNumber}`, this.roundPhase, "measured", 1, {
          from: prevRoundPhase,
          to: this.roundPhase,
          roundNumber: this.roundNumber,
        }),
      );
    }

    this.applyRoundResults(obs, scope, events);

    // --- players ---------------------------------------------------------------------------
    const prevPlayers = new Map(this.players);
    if (obs.players) {
      const seen = new Set<string>();
      for (const [sid, p] of obs.players) {
        seen.add(sid);
        this.absentSince.delete(sid);
        this.players.set(sid, this.mergePlayer(sid, p, now));
      }
      for (const sid of [...this.players.keys()]) {
        if (seen.has(sid)) continue;
        const since = this.absentSince.get(sid) ?? now;
        this.absentSince.set(sid, since);
        const existing = this.players.get(sid)!;
        if (now - since > (this.opts.absentPlayerRetentionMs ?? 30000)) {
          this.players.delete(sid);
          this.absentSince.delete(sid);
        } else if (existing.lifeState !== "unknown") {
          // Absent from the player list: do not assume death. Keep identity, mark unknown.
          this.players.set(sid, {
            ...existing,
            lifeState: "unknown",
            provenance: {
              ...existing.provenance,
              lifeState: { sourceId: obs.sourceId, evidence: "unknown", observedAtMonotonicMs: now, confidence: 0 },
            },
          });
        }
      }
    } else if (obs.observed && obs.observed.steamId !== obs.providerSteamId) {
      // No all-player component: update only the observed player's record.
      this.players.set(obs.observed.steamId, this.mergePlayer(obs.observed.steamId, obs.observed, now));
    }
    this.resolveTeamIdentities();
    for (const e of derivePlayerEvents(scope, prevPlayers, this.players)) events.push(e);

    // --- observer feedback -----------------------------------------------------------------
    if (obs.observed || obs.components.player) {
      const prevObserved = this.observer.observedSteamId;
      const o = obs.observed;
      const free = !o || o.steamId === obs.providerSteamId || o.spectarget === "free";
      this.observer = {
        observedSteamId: free ? null : o.steamId,
        observedSlot: free ? null : o.observerSlot,
        cameraMode: free ? "roaming" : "unknown",
        confirmedAtMonotonicMs: now,
        providerSteamId: obs.providerSteamId,
        evidence: "measured",
      };
      if (prevObserved !== this.observer.observedSteamId) {
        events.push(
          makeEvent(scope, "observer_changed", "observer", this.sequence, "measured", 1, {
            from: prevObserved,
            to: this.observer.observedSteamId,
          }),
        );
      }
    }

    // --- bomb ------------------------------------------------------------------------------
    this.applyBomb(obs, now, scope, events);

    // --- utility ---------------------------------------------------------------------------
    const trackerPlayers = new Map<string, TrackerPlayerView>();
    for (const [sid, p] of this.players) {
      trackerPlayers.set(sid, {
        side: p.side,
        weapons: p.weapons,
        flashed: p.flashed,
        health: p.health,
        position: p.position,
        lifeState: p.lifeState,
      });
    }
    const trackerCtx = {
      sessionId: this.sessionId,
      epoch: this.epoch,
      sourceId: obs.sourceId,
      nowMonotonicMs: now,
      matchTimeMs: this.lastMatchTimeMs,
      players: trackerPlayers,
    };
    if (obs.grenades) {
      utilityEvents = utilityEvents.concat(this.tracker.ingestSnapshot(obs.grenades, trackerCtx));
    } else {
      this.tracker.markSourceGap(now);
      this.tracker.tick(now);
    }

    const accepted = events.filter((e) => this.deduper.accept(e.eventId));
    return { accepted: true, reason: "ok", epochChanged: epochChange, events: accepted, utilityEvents, sequence: this.sequence };
  }

  /** Marks sources stale when silent. Returns true if the primary source is stale. */
  checkStale(nowMonotonicMs: number): boolean {
    const after = this.opts.staleAfterMs ?? 3000;
    let primaryStale = false;
    for (const [id, s] of this.sources) {
      const last = s.health.lastPacketMonotonicMs;
      s.health.stale = last === null || nowMonotonicMs - last > after;
      if (s.health.stale && last !== null && nowMonotonicMs - last > after * 4) s.health.connected = false;
      if (id === this.primarySourceId) primaryStale = s.health.stale;
    }
    this.tracker.tick(nowMonotonicMs);
    return primaryStale;
  }

  isPaused(): boolean {
    return this.gamePhase === "paused" || this.gamePhase === "timeout_ct" || this.gamePhase === "timeout_t";
  }

  utilityHistory(): readonly UtilityItem[] {
    return this.tracker.historyItems();
  }

  snapshot(nowMonotonicMs?: number): MatchState {
    const now = nowMonotonicMs ?? this.lastReceivedAt;
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      epoch: this.epoch,
      sequence: this.sequence,
      time: {
        receivedAtMonotonicMs: this.lastReceivedAt,
        sourceObservedAtMs: this.sources.get(this.primarySourceId ?? "")?.lastProviderTimestamp
          ? (this.sources.get(this.primarySourceId ?? "")!.lastProviderTimestamp as number) * 1000
          : null,
        matchTimeMs: this.sequence > 0 ? this.clock.at(now) : null,
        timeUncertaintyMs: this.sequence > 0 ? this.clock.uncertaintyMs() : null,
      },
      mapName: this.mapName,
      mapPhase: this.mapPhase,
      roundNumber: this.roundNumber,
      roundAttemptId: this.roundAttemptId,
      roundPhase: this.roundPhase,
      gamePhase: this.gamePhase,
      phaseEndsInSec: this.phaseEndsInSec,
      phaseObservedAtMonotonicMs: this.phaseObservedAt,
      paused: this.isPaused(),
      teams: { CT: { ...this.teams.CT }, T: { ...this.teams.T } },
      players: this.playerList(),
      bomb: this.bomb ? { ...this.bomb } : null,
      utility: this.tracker.items(),
      roundHistory: [...this.roundHistory],
      observer: { ...this.observer },
      sources: [...this.sources.values()].map((s) => ({ ...s.health })),
      simulated: this.opts.simulated ?? false,
    };
  }

  // ---------------------------------------------------------------------------------------

  private reject(reason: IngestResult["reason"]): IngestResult {
    return { accepted: false, reason, epochChanged: null, events: [], utilityEvents: [], sequence: this.sequence };
  }

  private scope(now: number): EventScope {
    return {
      sessionId: this.sessionId,
      epoch: this.epoch,
      roundAttemptId: this.roundAttemptId,
      sequence: this.sequence,
      receivedAtMonotonicMs: now,
      matchTimeMs: this.lastMatchTimeMs,
      timeUncertaintyMs: this.clock.uncertaintyMs(),
    };
  }

  private sourceRecord(sourceId: string): SourceRecord {
    let s = this.sources.get(sourceId);
    if (!s) {
      s = {
        health: {
          sourceId,
          connected: false,
          lastPacketMonotonicMs: null,
          packetsReceived: 0,
          packetsRejected: 0,
          sequenceGaps: 0,
          meanIntervalMs: null,
          stale: true,
          gameBuild: null,
        },
        lastHash: null,
        lastHashAtMs: 0,
        lastProviderTimestamp: null,
        intervals: [],
      };
      this.sources.set(sourceId, s);
    }
    return s;
  }

  private applyTeam(side: Side, t: TeamObservation | null): void {
    if (!t) return;
    const cur = this.teams[side];
    this.teams[side] = {
      ...cur,
      score: t.score ?? cur.score,
      name: t.name ?? cur.name,
      consecutiveRoundLosses: t.consecutiveRoundLosses ?? cur.consecutiveRoundLosses,
      timeoutsRemaining: t.timeoutsRemaining ?? cur.timeoutsRemaining,
      matchesWonThisSeries: t.matchesWonThisSeries ?? cur.matchesWonThisSeries,
    };
  }

  private applyRoundResults(obs: GsiObservation, scope: EventScope, events: DerivedEvent[]): void {
    const wins = obs.map?.roundWins;
    if (!wins) return;
    for (const [k, v] of Object.entries(wins)) {
      const roundNumber = Number(k);
      if (!Number.isInteger(roundNumber) || roundNumber < 1) continue;
      if (this.roundHistory.some((r) => r.roundNumber === roundNumber)) continue;
      const reason: RoundWinReason = WIN_REASONS.has(v) ? (v as RoundWinReason) : "unknown";
      const winnerSide: Side | null = v.startsWith("ct_") ? "CT" : v.startsWith("t_") ? "T" : null;
      // Team identity at the time of the round: only the current round's side→team mapping is
      // known with confidence; historical rounds before a side swap keep winnerTeamId null
      // unless supplied by the match record.
      const winnerTeamId = roundNumber === this.roundNumber && winnerSide ? this.teams[winnerSide].teamId : null;
      const attemptId =
        roundNumber === this.roundNumber && this.roundAttemptId ? this.roundAttemptId : `e${this.epoch}.r${roundNumber}.hist`;
      const result: RoundResult = { roundNumber, attemptId, winnerSide, winnerTeamId, reason, evidence: "measured" };
      this.roundHistory.push(result);
      events.push(makeEvent(scope, "round_end", `round-${roundNumber}`, attemptId, "measured", 1, { ...result }));
    }
    this.roundHistory.sort((a, b) => a.roundNumber - b.roundNumber);
  }

  /** The players in observer slot order, with their number keys and whether each is a coach. */
  private playerList(): PlayerState[] {
    const list = [...this.players.values()].sort((a, b) => (a.observerSlot ?? 99) - (b.observerSlot ?? 99) || a.steamId.localeCompare(b.steamId));
    detectCoaches(list, this.roundPhase, this.coaches);
    const coach = (steamId: string) => this.opts.coachOverride?.(steamId) ?? (this.rosterCoaches.has(steamId) || this.coaches.has(steamId));
    const keys = observerKeys(list.filter((p) => !coach(p.steamId)));
    return list.map((p) => ({ ...p, observerKey: keys.get(p.steamId) ?? null, coach: coach(p.steamId) }));
  }

  private mergePlayer(steamId: string, p: ObservedPlayer, now: number): PlayerState {
    const prev = this.players.get(steamId);
    const roster = this.opts.resolveRoster?.(steamId) ?? null;
    if (roster?.coach) this.rosterCoaches.add(steamId);
    else this.rosterCoaches.delete(steamId);
    const position = p.presence.position ? p.position : (prev?.position ?? null);
    const forward = p.presence.forward ? p.forward : (prev?.forward ?? null);
    return {
      steamId,
      playerId: roster?.playerId ?? null,
      name: roster?.displayName ?? p.name,
      observerSlot: p.observerSlot,
      observerKey: prev?.observerKey ?? null,
      coach: prev?.coach ?? false,
      side: p.side,
      teamId: roster?.teamId ?? null,
      lifeState: p.presence.state ? p.lifeState : (prev?.lifeState ?? "unknown"),
      health: p.presence.state ? p.health : (prev?.health ?? null),
      armor: p.presence.state ? p.armor : (prev?.armor ?? null),
      helmet: p.presence.state ? p.helmet : (prev?.helmet ?? null),
      defuseKit: p.presence.state ? p.defuseKit : (prev?.defuseKit ?? null),
      flashed: p.presence.state ? p.flashed : (prev?.flashed ?? null),
      smoked: p.presence.state ? p.smoked : (prev?.smoked ?? null),
      burning: p.presence.state ? p.burning : (prev?.burning ?? null),
      money: p.presence.state ? p.money : (prev?.money ?? null),
      equipValue: p.presence.state ? p.equipValue : (prev?.equipValue ?? null),
      roundKills: p.presence.state ? p.roundKills : (prev?.roundKills ?? null),
      roundKillsHeadshot: p.presence.state ? p.roundKillsHeadshot : (prev?.roundKillsHeadshot ?? null),
      roundDamage: p.presence.state ? p.roundDamage : (prev?.roundDamage ?? null),
      matchStats: p.presence.stats ? p.matchStats : (prev?.matchStats ?? { kills: null, assists: null, deaths: null, mvps: null, score: null }),
      // Weapons are replaced, never merged: a weapon absent from this packet is gone.
      weapons: p.weapons ?? prev?.weapons ?? [],
      activeWeapon: p.weapons ? p.activeWeapon : (prev?.activeWeapon ?? null),
      position,
      forward,
      positionObservedAtMonotonicMs: p.presence.position && p.position ? now : (prev?.positionObservedAtMonotonicMs ?? null),
      lastSeenMonotonicMs: now,
      provenance: {},
    };
  }

  /**
   * Derives side → team identity from roster membership of the players currently on each side,
   * so halftime side swaps never mix team identities. Requires a majority (≥3 of the side's
   * resolved players) to assign.
   */
  private resolveTeamIdentities(): void {
    for (const side of ["CT", "T"] as const) {
      const counts = new Map<string, number>();
      for (const p of this.players.values()) {
        if (p.side === side && p.teamId) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
      }
      let best: string | null = null;
      let bestN = 0;
      for (const [id, n] of counts) {
        if (n > bestN) {
          best = id;
          bestN = n;
        }
      }
      this.teams[side] = { ...this.teams[side], teamId: bestN >= 3 ? best : null };
    }
  }

  private applyBomb(obs: GsiObservation, now: number, scope: EventScope, events: DerivedEvent[]): void {
    const prev = this.bomb?.state ?? null;
    if (obs.bomb) {
      const state = bombKind(obs.bomb.state);
      const map = this.mapName ? this.opts.mapContextFor?.(this.mapName) : undefined;
      const site = obs.bomb.position && map?.siteAt ? map.siteAt(obs.bomb.position) : (this.bomb?.site ?? null);
      this.bomb = {
        state,
        position: obs.bomb.position,
        carrierSteamId: obs.bomb.carrierSteamId,
        countdownSec: obs.bomb.countdownSec,
        countdownObservedAtMonotonicMs: obs.bomb.countdownSec !== null ? now : null,
        site: state === "planted" || state === "defusing" || state === "defused" || state === "exploded" ? site : null,
        evidence: "measured",
      };
    } else if (obs.round?.bomb) {
      // Round-level bomb state only (no position/countdown detail).
      const state = bombKind(obs.round.bomb);
      this.bomb = {
        state,
        position: this.bomb?.position ?? null,
        carrierSteamId: null,
        countdownSec: null,
        countdownObservedAtMonotonicMs: null,
        site: this.bomb?.site ?? null,
        evidence: "measured",
      };
    } else if (obs.round && this.roundPhase === "freezetime") {
      this.bomb = null;
    }
    const next = this.bomb?.state ?? null;
    if (next !== prev && next !== null) {
      events.push(
        makeEvent(scope, "bomb_state", `bomb-${this.roundAttemptId}`, next, "measured", 1, {
          from: prev,
          to: next,
          site: this.bomb?.site ?? null,
          position: this.bomb?.position ?? null,
        }),
      );
    }
  }
}
