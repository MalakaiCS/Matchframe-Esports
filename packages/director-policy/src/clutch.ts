import type { MatchState, ReasonCode, Side, Vec3 } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";
import type { DirectorConfig } from "./config.ts";
import type { InteractionFeatures } from "./features/interactions.ts";
import type { RoundContext } from "./features/significance.ts";

/** Why the camera is on a hunter for a short look. */
export type ClutchLookWhy = "closing" | "site" | "planting" | "defusing";

/** What the director knows about one hunter (an opponent of the clutcher). */
export interface HunterRead {
  steamId: string;
  name: string;
  /** How far they have to walk to the clutcher (units on the map's grid; the straight line where the grid can't say). */
  walk: number;
  /** Whether `walk` is a walk on the grid (false: a straight line). */
  walked: boolean;
  /** How fast that walk shrinks (units a second; negative: moving away), or null until known. */
  closing: number | null;
  /** Seconds until they are within contact range at that speed, or null when not closing. */
  etaSec: number | null;
  /** They and the clutcher see each other now, or a sightline opens within this many seconds (the map's grid). */
  sightNow: boolean;
  sightSoonSec: number | null;
  /** The director's chance of a fight with the clutcher within a second. */
  contact1s: number;
  role: "planter" | "defuser" | "carrier" | null;
  /** The bombsite they stand in, and whether they just walked into the one the clutcher holds. */
  site: "A" | "B" | null;
  enteringClutcherSite: boolean;
}

/** The clutch shot: who it is on, why, and what the director knows about the hunters. */
export interface ClutchState {
  clutcher: string;
  clutcherName: string;
  side: Side;
  versus: number;
  /** The player to show: the clutcher (the default), or a hunter for a short look. */
  focus: string;
  why: ClutchLookWhy | null;
  /** Reason codes for the focused player's candidate. */
  reasons: ReasonCode[];
  /** Cut now: a plant or defuse starting, back to the clutcher before contact, or the end of a look. */
  urgent: boolean;
  /** The bombsite the clutcher holds, if any. */
  site: "A" | "B" | null;
  /** Seconds left: the bomb's once planted, else the round's; null when not known. */
  timeLeftSec: number | null;
  /** A hunter is about to meet the clutcher: the camera stays on (or goes back to) the clutcher. */
  contactSoon: boolean;
  /** Closest first. */
  hunters: HunterRead[];
  /** The last change of focus, in words, numbered so each is written to the director log once. */
  lastSwitch: { id: number; at: number; to: string; note: string } | null;
}

export interface ClutchInput {
  state: MatchState;
  now: number;
  cfg: DirectorConfig["clutch"];
  round: RoundContext;
  interactions: InteractionFeatures;
  /** The player in the shot on air, or null (a camera, nothing yet). */
  onAir: string | null;
  /** Walking distances to `goal` (null: not on the grid; Infinity: further than `maxUnits`), when the map has a grid. */
  walk?: ((goal: Vec3, from: readonly Vec3[], maxUnits: number) => (number | null)[]) | undefined;
  siteAt?: ((p: Vec3) => "A" | "B" | null) | undefined;
}

/** Walking distances are searched this far; further hunters are far away. */
const WALK_MAX = 4000;
/** A straight line stands in for a walk the grid can't give, this much longer (walls, corners). */
const STRAIGHT_FACTOR = 1.25;
/** Closing speed from walking distances this far apart in time (ms), at least MIN apart. */
const CLOSING_WINDOW_MS = 1000;
const CLOSING_MIN_MS = 400;
/** A hunter who walked into the clutcher's site this recently is entering it. */
const ENTRY_WINDOW_MS = 1500;
/** A look the camera hasn't shown within this long is dropped. */
const LOOK_LAND_MS = 1500;
/** A closing or site look starts only once the same hunter was the one to look at for this long. */
const PERSIST_MS = 250;
/** How long each kind of look lasts (a closing look: until shortly before contact, within lookMinMs–lookMaxMs). */
const PLANT_LOOK_MS = 3000;
const DEFUSE_LOOK_MS = 2500;
const SITE_LOOK_MS = 2500;
/** A closing look ends this long before the hunter is expected in contact range. */
const CLOSING_MARGIN_MS = 1500;
/** A player this close to the bomb (across) while it is being defused is the defuser. */
const DEFUSER_RADIUS = 120;
/** A T clutcher this close to the planted bomb holds its site. */
const HOLD_BOMB_RANGE = 1500;
/** A return's reason stays on the clutcher's candidate this long after the switch (the decision log shows it). */
const RETURN_REASON_MS = 1500;

const WHY_CODE: Record<ClutchLookWhy, ReasonCode> = {
  closing: "CLUTCH_HUNTER_CLOSING",
  site: "CLUTCH_HUNTER_ON_SITE",
  planting: "CLUTCH_HUNTER_PLANTING",
  defusing: "CLUTCH_HUNTER_DEFUSING",
};
const WHY_WORDS: Record<ClutchLookWhy, string> = {
  closing: "closing in",
  site: "walking onto the clutcher's site",
  planting: "planting",
  defusing: "defusing",
};

interface Look {
  hunter: string;
  why: ClutchLookWhy;
  decidedAt: number;
  onAirSince: number | null;
  durationMs: number;
}

interface Track {
  key: string;
  look: Look | null;
  /** Back to the clutcher: why, and since when (cut urgently until they are on air). */
  back: { at: number; code: ReasonCode; urgent: boolean } | null;
  clutcherOnAirSince: number | null;
  lastLook: Map<string, { at: number; why: ClutchLookWhy }>;
  walks: Map<string, { t: number; d: number }[]>;
  sites: Map<string, { site: "A" | "B" | null; since: number }>;
  pending: { hunter: string; why: ClutchLookWhy; since: number } | null;
  lastSwitch: ClutchState["lastSwitch"];
}

const round0 = (x: number) => Math.round(x);

/**
 * Clutch direction (with clutch mode on): in a 1vX the clutcher's view is the default, and the
 * director weighs each hunter against it: how far they have to walk to the clutcher on the map's grid
 * (not a straight line), whether they are walking in, whether a sightline is about to open, the bomb
 * (the planter, the defuser, a hunter walking onto the clutcher's site) and the time left. A hunter
 * who is about to matter gets a short look (2–4 s):
 *
 * - **planting / defusing:** they start a plant or a defuse (after 2 s on the clutcher, time left or not);
 * - **site:** they walk into the bombsite the clutcher holds;
 * - **closing:** within 1800 units' walk, closing at 120 units a second or more, in contact range in 2.5–7 s.
 *
 * The camera goes back to the clutcher before contact (in sight, a sightline opening within 1.6 s,
 * a likely fight within a second, or within 450 units' walk), at the end of the look, or when the
 * clutcher plants or defuses. No look starts until the clutcher has been on air 4 s (2 s for a plant
 * or defuse), the same hunter waits 10 s for another, a look never goes from one hunter to another,
 * and with under 8 s left only a plant or defuse gets one: no ping-pong.
 */
export class ClutchDirector {
  private t: Track | null = null;
  private switches = 0;

  reset(): void {
    this.t = null;
  }

  update(input: ClutchInput): ClutchState | null {
    const { state, now, cfg, round } = input;
    const c = round.clutch;
    const clutcher = c ? state.players.find((p) => p.steamId === c.steamId) : undefined;
    if (!c || !clutcher?.position || state.roundPhase !== "live") {
      this.t = null;
      return null;
    }
    const key = `${state.roundAttemptId}:${c.steamId}`;
    if (this.t?.key !== key) {
      this.t = { key, look: null, back: null, clutcherOnAirSince: null, lastLook: new Map(), walks: new Map(), sites: new Map(), pending: null, lastSwitch: null };
      this.note(now, c.steamId, `1v${c.versus}: on ${clutcher.name}, the clutch's default view`);
    }
    const t = this.t;
    const P = clutcher.position;
    const hunters = state.players.filter((p) => p.side && p.side !== c.side && !p.coach && p.lifeState === "alive" && p.position);

    // Walking distances to the clutcher on the map's grid (one search for all of them).
    const walks = input.walk?.(P, hunters.map((h) => h.position!), WALK_MAX) ?? hunters.map(() => null);
    const bomb = state.bomb;
    const timeLeftSec = round.bombPlanted
      ? round.bombRemainingSec
      : state.gamePhase === "live" || state.gamePhase === "unknown"
        ? projectCountdown({ countdownSec: state.phaseEndsInSec, observedAtMonotonicMs: state.phaseObservedAtMonotonicMs, nowMonotonicMs: now, running: !state.paused }).remainingSec
        : null;
    // The site the clutcher holds: the bombsite they stand in, or (a T after the plant) the bomb's.
    let site = input.siteAt?.(P) ?? null;
    if (!site && round.bombPlanted && c.side === "T" && bomb?.position && Math.hypot(bomb.position.x - P.x, bomb.position.y - P.y) <= HOLD_BOMB_RANGE) site = bomb.site ?? input.siteAt?.(bomb.position) ?? null;

    const reads: HunterRead[] = hunters.map((h, i) => {
      const pos = h.position!;
      const straight = Math.hypot(pos.x - P.x, pos.y - P.y, pos.z - P.z);
      const w = walks[i];
      const walked = w !== null && w !== undefined;
      const walk = walked ? w : straight * STRAIGHT_FACTOR;
      // Closing speed: how fast the walk shrank over about the last second.
      const hist = t.walks.get(h.steamId) ?? [];
      hist.push({ t: now, d: walk });
      while (hist.length > 1 && now - hist[0]!.t > CLOSING_WINDOW_MS * 1.5) hist.shift();
      t.walks.set(h.steamId, hist);
      const ref = hist.find((s) => now - s.t <= CLOSING_WINDOW_MS) ?? hist[0]!;
      const dt = (now - ref.t) / 1000;
      const closing = Number.isFinite(walk) && Number.isFinite(ref.d) && dt * 1000 >= CLOSING_MIN_MS ? (ref.d - walk) / dt : null;
      const etaSec = closing !== null && closing > 1 && Number.isFinite(walk) ? Math.max(0, walk - cfg.contactRange) / closing : null;
      const pair = input.interactions.pairs.find((x) => (x.t === h.steamId && x.ct === c.steamId) || (x.ct === h.steamId && x.t === c.steamId));
      const role: HunterRead["role"] =
        bomb?.state === "planting" && bomb.carrierSteamId === h.steamId
          ? "planter"
          : bomb?.state === "defusing" && h.side === "CT" && (bomb.carrierSteamId === h.steamId || (!!bomb.position && Math.hypot(bomb.position.x - pos.x, bomb.position.y - pos.y) <= DEFUSER_RADIUS))
            ? "defuser"
            : bomb?.state === "carried" && bomb.carrierSteamId === h.steamId
              ? "carrier"
              : null;
      const hs = input.siteAt?.(pos) ?? null;
      const seen = t.sites.get(h.steamId);
      // First sight of them this clutch: already there, not walking in.
      if (!seen) t.sites.set(h.steamId, { site: hs, since: -Infinity });
      else if (seen.site !== hs) t.sites.set(h.steamId, { site: hs, since: now });
      const since = t.sites.get(h.steamId)!.since;
      return {
        steamId: h.steamId,
        name: h.name,
        walk,
        walked,
        closing,
        etaSec,
        sightNow: pair?.sight?.now === true,
        sightSoonSec: pair?.sight?.soonSec ?? null,
        contact1s: pair?.contact["1"] ?? 0,
        role,
        site: hs,
        enteringClutcherSite: hs !== null && hs === site && now - since <= ENTRY_WINDOW_MS,
      };
    });
    reads.sort((a, b) => (a.walk === b.walk ? 0 : a.walk < b.walk ? -1 : 1));
    const contactOf = (h: HunterRead) => h.sightNow || h.sightSoonSec !== null || h.contact1s >= 0.6 || h.walk <= cfg.contactRange || (h.etaSec !== null && h.etaSec <= 1);
    const contact = reads.find(contactOf) ?? null;
    const clutcherBusy = (bomb?.state === "planting" && bomb.carrierSteamId === c.steamId) || (bomb?.state === "defusing" && c.side === "CT");

    // Time on the clutcher (the dwell before a look).
    if (input.onAir === c.steamId) t.clutcherOnAirSince ??= now;
    else t.clutcherOnAirSince = null;
    if (t.back && input.onAir === c.steamId) t.back = { ...t.back, urgent: false };

    const backTo = (code: ReasonCode, urgent: boolean, words: string) => {
      t.look = null;
      t.pending = null;
      t.back = { at: now, code, urgent };
      this.note(now, c.steamId, `back to ${clutcher.name}: ${words}`);
    };

    if (t.look) {
      const look = t.look;
      const h = reads.find((r) => r.steamId === look.hunter);
      if (input.onAir === look.hunter) look.onAirSince ??= now;
      const shownMs = look.onAirSince === null ? 0 : now - look.onAirSince;
      if (!h) backTo("CLUTCH_LOOK_OVER", true, `${state.players.find((p) => p.steamId === look.hunter)?.name ?? "the hunter"} is down`);
      else if (contact) backTo("CLUTCH_BACK_BEFORE_CONTACT", true, `${contact.name} is about to meet them (${contactWords(contact, cfg)})`);
      else if (clutcherBusy) backTo("CLUTCH_LOOK_OVER", true, bomb?.state === "planting" ? "they are planting" : "they are defusing");
      else if (look.onAirSince === null && now - look.decidedAt > LOOK_LAND_MS) backTo("CLUTCH_LOOK_OVER", false, `the look at ${h.name} never came on air`);
      else if (look.onAirSince !== null && shownMs >= look.durationMs) backTo("CLUTCH_LOOK_OVER", true, `after ${(shownMs / 1000).toFixed(1)} s on ${h.name}`);
      else if (look.why === "defusing" && h.role !== "defuser" && shownMs >= cfg.lookMinMs) backTo("CLUTCH_LOOK_OVER", true, `${h.name} stopped defusing`);
    } else if (cfg.hunterLooks && !contact && !clutcherBusy && t.clutcherOnAirSince !== null) {
      const onClutcher = now - t.clutcherOnAirSince;
      const cooled = (h: HunterRead, why: ClutchLookWhy) => {
        const last = t.lastLook.get(h.steamId);
        if (!last) return true;
        // A plant or defuse gets its look even soon after another look at them, but once.
        if (why === "planting" || why === "defusing") return last.why !== why;
        return now - last.at >= cfg.hunterCooldownMs;
      };
      const lowTime = timeLeftSec !== null && timeLeftSec < cfg.lowTimeSec;
      const options: { h: HunterRead; why: ClutchLookWhy; rank: number; ms: number }[] = [];
      for (const h of reads) {
        if (onClutcher >= cfg.objectiveMinMs) {
          if (h.role === "planter" && cooled(h, "planting")) options.push({ h, why: "planting", rank: 3, ms: PLANT_LOOK_MS });
          if (h.role === "defuser" && cooled(h, "defusing")) options.push({ h, why: "defusing", rank: 3, ms: DEFUSE_LOOK_MS });
        }
        if (onClutcher < cfg.clutcherMinMs || lowTime) continue;
        if (h.enteringClutcherSite && cooled(h, "site")) options.push({ h, why: "site", rank: 2, ms: SITE_LOOK_MS });
        if (h.etaSec !== null && h.closing !== null && h.closing >= cfg.closingSpeed && h.walk <= cfg.closingRange && h.etaSec >= cfg.etaMinSec && h.etaSec <= cfg.etaMaxSec && cooled(h, "closing")) {
          options.push({ h, why: "closing", rank: 1, ms: Math.max(cfg.lookMinMs, Math.min(cfg.lookMaxMs, h.etaSec * 1000 - CLOSING_MARGIN_MS)) });
        }
      }
      // The most pressing kind first; then the bomb carrier, then whoever arrives soonest.
      options.sort((a, b) => b.rank - a.rank || Number(b.h.role === "carrier") - Number(a.h.role === "carrier") || (a.h.etaSec ?? a.h.walk / 250) - (b.h.etaSec ?? b.h.walk / 250));
      const best = options[0];
      if (!best) t.pending = null;
      else {
        const objective = best.why === "planting" || best.why === "defusing";
        if (!t.pending || t.pending.hunter !== best.h.steamId || t.pending.why !== best.why) t.pending = { hunter: best.h.steamId, why: best.why, since: now };
        if (objective || now - t.pending.since >= PERSIST_MS) {
          t.look = { hunter: best.h.steamId, why: best.why, decidedAt: now, onAirSince: null, durationMs: best.ms };
          t.lastLook.set(best.h.steamId, { at: now, why: best.why });
          t.pending = null;
          t.back = null;
          this.note(now, best.h.steamId, `look at ${best.h.name} (${WHY_WORDS[best.why]}): ${lookWords(best.h)}; ${(best.ms / 1000).toFixed(1)} s, then back to ${clutcher.name}`);
        }
      }
    } else t.pending = null;

    const look = t.look;
    const back = t.back && now - t.back.at <= RETURN_REASON_MS + (t.back.urgent ? LOOK_LAND_MS : 0) ? t.back : null;
    return {
      clutcher: c.steamId,
      clutcherName: clutcher.name,
      side: c.side,
      versus: c.versus,
      focus: look?.hunter ?? c.steamId,
      why: look?.why ?? null,
      reasons: look ? [WHY_CODE[look.why]] : back ? [back.code] : [],
      // A plant or defuse is shown as it starts; going back is at once; a closing or site look is an ordinary cut.
      urgent: look ? look.onAirSince === null && (look.why === "planting" || look.why === "defusing") : !!back?.urgent,
      site,
      timeLeftSec,
      contactSoon: contact !== null,
      hunters: reads,
      lastSwitch: t.lastSwitch,
    };
  }

  private note(now: number, to: string, note: string): void {
    if (!this.t) return;
    this.t.lastSwitch = { id: ++this.switches, at: now, to, note };
  }
}

const walkWords = (h: HunterRead) => (Number.isFinite(h.walk) ? `${round0(h.walk)} units ${h.walked ? "away on foot" : "away"}` : "far away");

function lookWords(h: HunterRead): string {
  const walk = walkWords(h);
  if (h.role === "planter" || h.role === "defuser") return walk;
  const parts = [walk];
  if (h.closing !== null) parts.push(`closing at ${round0(h.closing)} u/s`);
  if (h.etaSec !== null) parts.push(`in range in ~${h.etaSec.toFixed(1)} s`);
  return parts.join(", ");
}

function contactWords(h: HunterRead, cfg: DirectorConfig["clutch"]): string {
  if (h.sightNow) return "in sight";
  if (h.sightSoonSec !== null) return `a sightline opens in ${h.sightSoonSec.toFixed(1)} s`;
  if (h.walk <= cfg.contactRange) return walkWords(h);
  if (h.etaSec !== null && h.etaSec <= 1) return `in range in ${h.etaSec.toFixed(1)} s`;
  return `a fight likely within a second (${Math.round(h.contact1s * 100)} %)`;
}
