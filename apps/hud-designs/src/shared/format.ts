import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";

/** A countdown as m:ss, advancing locally between updates while its clock runs. */
export function clockText(sec: number | null, running: boolean, receivedAt: number, now: number): string {
  if (sec === null) return "";
  const left = Math.max(0, running ? sec - (now - receivedAt) / 1000 : sec);
  const s = Math.ceil(left);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds left on a clock, advancing locally (the bomb timer's bar). */
export function secondsLeft(sec: number | null, running: boolean, receivedAt: number, now: number): number | null {
  if (sec === null) return null;
  return Math.max(0, running ? sec - (now - receivedAt) / 1000 : sec);
}

/** CS2's loss bonus after this many lost rounds in a row ($1,400, +$500 each, up to $3,400). */
export function lossBonus(losses: number | null): number | null {
  if (losses === null) return null;
  return Math.min(3400, 1400 + 500 * Math.max(0, losses - 1));
}

export const money = (n: number | null | undefined): string => (n === null || n === undefined ? "" : `$${n.toLocaleString("en-US")}`);

/** The team's colour: its own, else the HUD's colour for the side it plays (settings ctColor / tColor). */
export function teamColor(team: HudTeam, settings: Record<string, unknown>, fallback: { ct: string; t: string }): string {
  if (team.color) return team.color;
  const ct = typeof settings.ctColor === "string" ? settings.ctColor : fallback.ct;
  const t = typeof settings.tColor === "string" ? settings.tColor : fallback.t;
  return team.side === "T" ? t : ct;
}

/** The team's grenades by type, counted over its alive players (the freeze-time utility row). */
export function utilityCounts(team: HudTeam): { smoke: number; flash: number; he: number; fire: number } {
  const out = { smoke: 0, flash: 0, he: 0, fire: 0 };
  for (const p of team.players) {
    if (p.alive === false) continue;
    for (const g of p.grenades) {
      const n = Math.max(1, g.ammoReserve ?? 1);
      if (g.name.includes("smoke")) out.smoke += n;
      else if (g.name.includes("flash")) out.flash += n;
      else if (g.name.includes("hegrenade")) out.he += n;
      else if (g.name.includes("molotov") || g.name.includes("incgrenade")) out.fire += n;
    }
  }
  return out;
}

export const equipmentValue = (team: HudTeam): number => team.players.reduce((s, p) => s + (p.equipValue ?? 0), 0);
export const aliveCount = (team: HudTeam): number => team.players.filter((p) => p.alive !== false).length;

/** The team that won the round just ended (phase "over"), from the round history. */
export function roundWinner(state: HudState): "left" | "right" | null {
  if (state.match.phase !== "over") return null;
  const last = state.roundHistory[state.roundHistory.length - 1];
  return last?.winner ?? null;
}

/** Whether the round is under way (the freeze-time extras go away, the alive counter comes in). */
export const isLive = (phase: HudState["match"]["phase"]): boolean => phase === "live" || phase === "bomb" || phase === "defuse";

/** A player's main weapon to show on their card: primary, else secondary, else the knife. */
export const mainWeapon = (p: HudPlayer): string | null => p.primary?.name ?? p.secondary?.name ?? (p.alive === false ? null : "weapon_knife");
