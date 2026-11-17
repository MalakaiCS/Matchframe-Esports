import type { CSSProperties } from "react";
import type { HudPhase, HudSide, HudState, HudTeam } from "@matchframe/hud-sdk";
import { teamColor } from "../shared/format.ts";

/** The manifest's settings defaults (settingsSchema in package-files/stage/manifest.json). */
export const DEFAULTS = {
  ctColor: "#3d7ee6",
  tColor: "#e6b83a",
  /** The neutral panels (score bar, event line, series strip, scoreboard header, killfeed): royal blue or dark navy. */
  panelColor: "blue" as "blue" | "navy",
  teamNames: "full" as "full" | "short",
  eventTitle: "",
  stageTitle: "",
  showSeries: true,
  showRadar: true,
  showKillfeed: true,
  killfeedRows: 5,
  showSponsors: true,
  showAlive: true,
  showObserved: true,
  showScoreboard: true,
  showMvp: true,
  /** Seconds into the live round after which the round MVP card goes (5–10). */
  mvpLiveSeconds: 8,
  /** The trophy from HUD images in the middle of the event line (shown only when one is set). */
  showTrophy: true,
  showMoney: true,
};
export type Settings = typeof DEFAULTS;

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The HUD's settings from the HUD Library, each falling back to its manifest default. */
export function readSettings(s: Record<string, unknown>): Settings {
  const str = (k: "eventTitle" | "stageTitle") => (typeof s[k] === "string" ? (s[k] as string).trim() : DEFAULTS[k]);
  const color = (k: "ctColor" | "tColor") => (typeof s[k] === "string" && HEX.test(s[k] as string) ? (s[k] as string) : DEFAULTS[k]);
  const bool = (k: BoolKey) => (typeof s[k] === "boolean" ? (s[k] as boolean) : DEFAULTS[k]);
  const rows = typeof s.killfeedRows === "number" && Number.isFinite(s.killfeedRows) ? Math.round(s.killfeedRows) : DEFAULTS.killfeedRows;
  return {
    ctColor: color("ctColor"),
    tColor: color("tColor"),
    panelColor: s.panelColor === "navy" ? "navy" : "blue",
    teamNames: s.teamNames === "short" ? "short" : "full",
    eventTitle: str("eventTitle"),
    stageTitle: str("stageTitle"),
    showSeries: bool("showSeries"),
    showRadar: bool("showRadar"),
    showKillfeed: bool("showKillfeed"),
    killfeedRows: Math.max(1, Math.min(5, rows)),
    showSponsors: bool("showSponsors"),
    showAlive: bool("showAlive"),
    showObserved: bool("showObserved"),
    showScoreboard: bool("showScoreboard"),
    showMvp: bool("showMvp"),
    mvpLiveSeconds: Math.max(5, Math.min(10, typeof s.mvpLiveSeconds === "number" && Number.isFinite(s.mvpLiveSeconds) ? Math.round(s.mvpLiveSeconds) : DEFAULTS.mvpLiveSeconds)),
    showTrophy: bool("showTrophy"),
    showMoney: bool("showMoney"),
  };
}

/** The trophy from HUD images when the setting shows it (older engines send none). */
export const trophyOf = (state: HudState, settings: Settings): string | null => (settings.showTrophy ? (state.art?.icons?.trophy ?? null) : null);

/** A team's colour: its own, else the colour of the side it plays. */
export const colorOf = (team: HudTeam, settings: Settings): string => teamColor(team, settings as unknown as Record<string, unknown>, { ct: settings.ctColor, t: settings.tColor });

/** The colour for a side (radar markers, killfeed names): the team playing it. */
export function sideColor(state: HudState, settings: Settings, side: HudSide | null): string {
  if (side && state.left.side === side) return colorOf(state.left, settings);
  if (side && state.right.side === side) return colorOf(state.right, settings);
  return side === "T" ? settings.tColor : side === "CT" ? settings.ctColor : "#9aa6b8";
}

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

/** `amount` of `hex` over `base` (no CSS color-mix: OBS's browser is older). */
export function mix(hex: string, base: string, amount: number): string {
  const a = rgb(hex);
  const b = rgb(base);
  if (!a || !b) return hex;
  return `#${a.map((c, i) => Math.round(c * amount + b[i]! * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

/** The deep navy the team colours are shaded towards for card fills. */
const NAVY = "#0a1222";

/** Dark or white text on a colour (team colours can be light, CS gold is). */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? "#0a0f18" : "#ffffff";
}

/**
 * CSS variables for a team-coloured element: the colour and the ink that reads on it, the flat card
 * fill (the colour shaded towards navy, so white text reads on CS gold too), a lit fill for the
 * observed player, a dark tint (killfeed rows) and a light tint (names on dark tints).
 */
export const teamVars = (color: string): CSSProperties =>
  ({
    "--st-team": color,
    "--st-team-ink": inkOn(color),
    "--st-team-fill": mix(color, NAVY, 0.6),
    "--st-team-lit": mix(color, NAVY, 0.74),
    "--st-team-dark": mix(color, NAVY, 0.34),
    "--st-team-light": mix(color, "#ffffff", 0.72),
    "--st-team-pale": mix(color, "#ffffff", 0.62),
    "--st-team-pale-ink": inkOn(mix(color, "#ffffff", 0.62)),
  }) as CSSProperties;

/** The name a team shows: its tag with "Team names: short", else its full name. */
export const teamName = (team: HudTeam, settings: Settings): string => (settings.teamNames === "short" ? team.shortName || team.name : team.name || team.shortName);

/**
 * Whether the full-width scoreboard replaces the player cards: only in a tactical timeout and a tech
 * or match pause (the owner: "only on timeouts and tech pauses/match pauses"). Freeze time, half time
 * and warm-up keep the cards and the observed player.
 */
export const scoreboardPhase = (phase: HudPhase, paused = false): boolean => paused || phase === "paused" || phase === "timeout_ct" || phase === "timeout_t";

/** The team that called the timeout under way, if any. */
export function timeoutTeam(state: HudState): HudTeam | null {
  const p = state.match.phase;
  if (p !== "timeout_ct" && p !== "timeout_t") return null;
  const side: HudSide = p === "timeout_ct" ? "CT" : "T";
  return state.left.side === side ? state.left : state.right.side === side ? state.right : null;
}

/** The previous round's MVP card comes in this many seconds into freeze time. */
export const MVP_IN_SECONDS = 5;
/** CS2's freeze time and round time, assumed for a page opened part-way through one it never saw begin. */
const FREEZE_SECONDS = 15;
const ROUND_SECONDS = 115;
const BREAKS: ReadonlySet<HudPhase> = new Set(["timeout_ct", "timeout_t", "paused"]);

/** What the MVP timing remembers between updates: the phase seen last and this round's lengths. */
export interface MvpClock {
  phase: HudPhase | null;
  round: number | null;
  /** This round's freeze time and round time (s), from the first countdown seen in each. */
  freezeLength: number | null;
  liveLength: number | null;
  /** The lengths seen begin last time, for a page that missed this phase's start. */
  knownFreeze: number | null;
  knownLive: number | null;
}
export const MVP_CLOCK: MvpClock = { phase: null, round: null, freezeLength: null, liveLength: null, knownFreeze: null, knownLive: null };

/**
 * Learns this round's freeze time and round time from the phase clock: the first countdown seen in the
 * phase (15 or 20 s of freeze, 1:55 of round as a rule). A page that did not see the phase begin
 * (opened part-way through, or back from a timeout it missed the start of) takes at least the length
 * it saw last time, else CS2's default, so elapsed time is never under-counted. A timeout in freeze
 * time keeps the round's freeze length. Pure: returns the new clock (the same input twice changes nothing).
 */
export function mvpClock(c: MvpClock, m: Pick<HudState["match"], "phase" | "phaseEndsInSec" | "roundNumber">): MvpClock {
  let n: MvpClock = c.round === m.roundNumber ? { ...c } : { ...c, round: m.roundNumber, freezeLength: null, liveLength: null };
  const sec = m.phaseEndsInSec;
  if (sec !== null && sec > 0) {
    const first = Math.ceil(sec - 1e-6);
    if (m.phase === "freezetime" && n.freezeLength === null) {
      const sawStart = c.phase !== null && c.phase !== "freezetime" && !BREAKS.has(c.phase);
      n = sawStart ? { ...n, freezeLength: first, knownFreeze: first } : { ...n, freezeLength: Math.max(c.knownFreeze ?? FREEZE_SECONDS, first) };
    }
    if (m.phase === "live" && n.liveLength === null) {
      n = c.phase === "freezetime" ? { ...n, liveLength: first, knownLive: first } : { ...n, liveLength: Math.max(c.knownLive ?? ROUND_SECONDS, first) };
    }
  }
  return { ...n, phase: m.phase };
}

/**
 * Whether the previous round's MVP card is up, with `remaining` the phase clock now: from 5 s into
 * freeze time (elapsed = the freeze length less the time left) through to `liveSeconds` into the live
 * round. Never at the round's end, in warm-up, during a timeout or pause, or later in a round.
 */
export function mvpUp(c: MvpClock, m: Pick<HudState["match"], "phase" | "paused">, remaining: number | null, liveSeconds: number): boolean {
  if (m.paused || remaining === null) return false;
  if (m.phase === "freezetime" && c.freezeLength !== null) return c.freezeLength - remaining >= MVP_IN_SECONDS;
  if (m.phase === "live" && c.liveLength !== null) return c.liveLength - remaining < liveSeconds;
  return false;
}

/** Seconds of phase clock until mvpUp next changes on its own (in, or out), or null when it won't. */
export function mvpNextChange(c: MvpClock, m: Pick<HudState["match"], "phase" | "paused">, remaining: number | null, liveSeconds: number): number | null {
  if (m.paused || remaining === null) return null;
  if (m.phase === "freezetime" && c.freezeLength !== null && c.freezeLength - remaining < MVP_IN_SECONDS) return remaining - (c.freezeLength - MVP_IN_SECONDS);
  if (m.phase === "live" && c.liveLength !== null && c.liveLength - remaining < liveSeconds) return remaining - (c.liveLength - liveSeconds);
  return null;
}

/** Players of a team in observer-slot order (at most five). */
export const slotOrder = (team: HudTeam) => [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).slice(0, 5);

/** A slot number as the game's number keys show it (slot 10 is key 0). */
export const slotKey = (slot: number | null): string => (slot === null ? "" : String(slot % 10));

/** Money in the HUD's format: "$2,250". */
export const cash = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : `$${n.toLocaleString("en-US")}`);

/** The page runs one of the built-in demo scenes. */
const QUERY = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
export const DEMO = QUERY.has("demo");
/** Demo pages without the sponsor stand-in (`?sponsor=none`), as live with no sponsor scheduled. */
export const DEMO_NO_SPONSOR = QUERY.get("sponsor") === "none";
