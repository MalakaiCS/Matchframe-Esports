import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { MatchState } from "@matchframe/contracts";

/**
 * What the main PC tells the replay PC (GET /api/v1/replay-link/on-air): who its camera has, its
 * round clock (so the replay PC can tell how far behind it is), and the kills of the last seconds,
 * each judged here, where the camera history is exact: did the main camera show the killer, only
 * the victim, or neither in the seconds before it.
 */

export interface OnAirKill {
  id: string;
  round: number | null;
  killer: { steamId: string; name: string };
  victim: { steamId: string; name: string };
  weapon: string | null;
  headshot: boolean;
  /** What the main camera had in the SHOWN_WINDOW_MS before the kill. */
  shown: "killer" | "victim" | "none";
  /** How long ago the kill happened on the main PC. */
  ageMs: number;
}

export interface OnAirClock {
  map: string | null;
  round: number | null;
  phase: string;
  endsInSec: number;
  /** How long ago the main PC read this clock. */
  ageMs: number;
}

/** The main camera "showed" a player when it had them within this long before the kill. */
export const SHOWN_WINDOW_MS = 2500;
/** Kills sent to the replay PC: the last this many ms. */
const KILLS_MS = 30_000;

/** What the replay PC last said it still has to film or send is trusted this long. */
const PEER_FRESH_MS = 2000;

export class OnAirLog {
  private history: { at: number; steamId: string | null }[] = [];
  private kills: { at: number; kill: Omit<OnAirKill, "ageMs"> }[] = [];
  /** The rounds (the main PC's numbers) whose kills the replay PC is still filming or sending, as it said when it last asked. */
  private peer: { at: number; pendingRounds: number[] } | null = null;

  constructor(private readonly now: () => number) {}

  /** The replay PC asked for the on-air state and said which rounds it still has kills of to film or send. */
  notePeer(pendingRounds: number[]): void {
    this.peer = { at: this.now(), pendingRounds };
  }

  /** The replay PC is linked (asked lately) and still has kills of `round` to film or send. */
  peerPending(round: number | null): boolean {
    const p = this.peer;
    if (!p || this.now() - p.at > PEER_FRESH_MS || round === null) return false;
    return p.pendingRounds.includes(round);
  }

  /** The replay PC asked lately. */
  peerLinked(): boolean {
    return !!this.peer && this.now() - this.peer.at <= PEER_FRESH_MS;
  }

  noteState(observedSteamId: string | null): void {
    const now = this.now();
    const last = this.history[this.history.length - 1];
    if (!last || last.steamId !== observedSteamId) this.history.push({ at: now, steamId: observedSteamId });
    while (this.history.length > 2 && this.history[1]!.at < now - 60_000) this.history.shift();
  }

  noteKill(k: HudKillfeedEntry, round: number | null): void {
    if (!k.killer || k.killer.steamId === k.victim.steamId) return;
    const now = this.now();
    const had = (id: string) => showedDuring(this.history, id, now - SHOWN_WINDOW_MS, now);
    const shown = had(k.killer.steamId) ? "killer" : had(k.victim.steamId) ? "victim" : "none";
    this.kills.push({ at: now, kill: { id: k.id, round, killer: { steamId: k.killer.steamId, name: k.killer.name }, victim: { steamId: k.victim.steamId, name: k.victim.name }, weapon: k.weapon, headshot: k.headshot === true, shown } });
    while (this.kills.length && this.kills[0]!.at < now - KILLS_MS) this.kills.shift();
  }

  recentKills(): OnAirKill[] {
    const now = this.now();
    return this.kills.filter((k) => k.at >= now - KILLS_MS).map((k) => ({ ...k.kill, ageMs: Math.round(now - k.at) }));
  }

  clock(s: MatchState | null): OnAirClock | null {
    if (!s || s.phaseEndsInSec === null || s.phaseObservedAtMonotonicMs === null) return null;
    return { map: s.mapName, round: s.roundNumber, phase: s.gamePhase, endsInSec: s.phaseEndsInSec, ageMs: Math.max(0, Math.round(this.now() - s.phaseObservedAtMonotonicMs)) };
  }
}

/** Whether a camera history had one of these players on air at some point in [from, to]. */
export function showedDuring(history: { at: number; steamId: string | null }[], steamId: string, from: number, to: number): boolean {
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    const until = history[i + 1]?.at ?? Infinity;
    if (until < from || h.at > to) continue;
    if (h.steamId === steamId) return true;
  }
  return false;
}

/** Who a camera history had on air at time t. */
export function onAirAt(history: { at: number; steamId: string | null }[], t: number): string | null {
  let id: string | null = null;
  for (const h of history) {
    if (h.at > t) break;
    id = h.steamId;
  }
  return id;
}
