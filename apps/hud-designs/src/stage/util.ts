import type { CSSProperties } from "react";
import type { HudPhase, HudSide, HudState, HudTeam } from "@matchframe/hud-sdk";
import { isLive, teamColor } from "../shared/format.ts";

/** The manifest's settings defaults (settingsSchema in package-files/stage/manifest.json). */
export const DEFAULTS = {
  ctColor: "#3f9cf0",
  tColor: "#efb236",
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
    showMoney: bool("showMoney"),
  };
}

/** A team's colour: its own, else the colour of the side it plays. */
export const colorOf = (team: HudTeam, settings: Settings): string => teamColor(team, settings as unknown as Record<string, unknown>, { ct: settings.ctColor, t: settings.tColor });

/** The colour for a side (radar markers, killfeed names): the team playing it. */
export function sideColor(state: HudState, settings: Settings, side: HudSide | null): string {
  if (side && state.left.side === side) return colorOf(state.left, settings);
  if (side && state.right.side === side) return colorOf(state.right, settings);
  return side === "T" ? settings.tColor : side === "CT" ? settings.ctColor : "#9aa6b8";
}

/** Dark or white text on a colour (team colours can be light, CS gold is). */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? "#0a0f18" : "#ffffff";
}

/** CSS variables for a team-coloured element: the colour and the ink that reads on it. */
export const teamVars = (color: string): CSSProperties => ({ "--st-team": color, "--st-team-ink": inkOn(color) }) as CSSProperties;

/** The name a team shows: its tag with "Team names: short", else its full name. */
export const teamName = (team: HudTeam, settings: Settings): string => (settings.teamNames === "short" ? team.shortName || team.name : team.name || team.shortName);

/**
 * Whether the full-width scoreboard replaces the player cards: freeze time, timeouts, pauses,
 * half time and warm-up (the same split as the Lineup HUD: everything but a round under way or just won).
 */
export const scoreboardPhase = (phase: HudPhase): boolean => !(isLive(phase) || phase === "over");

/** The team that called the timeout under way, if any. */
export function timeoutTeam(state: HudState): HudTeam | null {
  const p = state.match.phase;
  if (p !== "timeout_ct" && p !== "timeout_t") return null;
  const side: HudSide = p === "timeout_ct" ? "CT" : "T";
  return state.left.side === side ? state.left : state.right.side === side ? state.right : null;
}

/** Players of a team in observer-slot order (at most five). */
export const slotOrder = (team: HudTeam) => [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).slice(0, 5);

/** A slot number as the game's number keys show it (slot 10 is key 0). */
export const slotKey = (slot: number | null): string => (slot === null ? "" : String(slot % 10));

/** Money in the HUD's format: "$2,250". */
export const cash = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : `$${n.toLocaleString("en-US")}`);

/** The page runs one of the built-in demo scenes. */
export const DEMO = new URLSearchParams(location.search).has("demo");
