import type { HudPlayer, HudSide, HudState, HudTeam, HudWeapon } from "@matchframe/hud-sdk";

/** Weapon icon id: "weapon_ak47" → "ak47". */
export const weaponId = (name: string | null | undefined): string => (name ?? "").replace(/^weapon_/, "");

/** Per-HUD settings from the HUD Library, with the manifest defaults as fallback. */
export function setting<T>(state: HudState, key: string, fallback: T): T {
  const v = state.settings?.[key];
  return v === undefined || v === null || typeof v !== typeof fallback ? fallback : (v as T);
}

export const sideClass = (side: HudSide | null | undefined): string => side ?? "";

export function teamName(state: HudState, team: HudTeam): string {
  return setting<string>(state, "teamNames", "full") === "short" ? team.shortName || team.name : team.name || team.shortName;
}

export const alive = (p: HudPlayer): boolean => p.alive !== false && (p.health ?? 1) > 0;

/** Grenade counts of a team (flashbangs can be two per player). */
export function utilitySummary(players: HudPlayer[]) {
  const count = (names: string[]) =>
    players.reduce((sum, p) => sum + p.grenades.filter((g) => names.includes(weaponId(g.name))).reduce((s, g) => s + Math.max(1, g.ammoReserve ?? 1), 0), 0);
  return { smokes: count(["smokegrenade"]), inc: count(["incgrenade", "molotov"]), flashes: count(["flashbang"]), hg: count(["hegrenade"]) };
}

/** Loss bonus when the source reports consecutive losses; null when it does not (never guessed). */
export function lossBonus(team: HudTeam): number | null {
  if (team.consecutiveRoundLosses === null) return null;
  return Math.min(team.consecutiveRoundLosses * 500 + 1400, 3400);
}

export const sum = (players: HudPlayer[], pick: (p: HudPlayer) => number | null): number | null => {
  const values = players.map(pick).filter((v): v is number => typeof v === "number");
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};

export const money = (v: number | null | undefined): string => (typeof v === "number" ? `$${v.toLocaleString("en-US")}` : "—");

export function grenadesOf(p: HudPlayer): HudWeapon[] {
  // One entry per grenade in hand: a second flashbang is drawn twice like in the game's HUD.
  return p.grenades.flatMap((g) => (weaponId(g.name) === "flashbang" && (g.ammoReserve ?? 1) >= 2 ? [g, { ...g, active: false }] : [g]));
}

export function clock(sec: number | null): string {
  if (sec === null) return "–:––";
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function roundLabel(state: HudState): string {
  const round = state.match.roundNumber;
  if (round === null) return state.match.mapDisplayName ?? "";
  const reg = state.match.regulationRounds ?? 24;
  if (round <= reg) return `Round ${round}/${reg}`;
  const extra = round - reg;
  const ot = Math.ceil(extra / 6);
  return `OT ${ot} (${extra - (ot - 1) * 6}/6)`;
}

export const isFreezetime = (state: HudState): boolean => state.match.phase === "freezetime";

/**
 * HUD images (state.art, from the HUD Library): a player's own photo, else the default picture for
 * their side; player n of the team (observer-slot order) takes picture n, cycling.
 */
export function playerPicture(state: HudState, p: Pick<HudPlayer, "steamId" | "avatarUrl" | "side">): string | null {
  if (p.avatarUrl) return p.avatarUrl;
  const team = state.right.players.some((x) => x.steamId === p.steamId) ? state.right : state.left;
  const side = p.side ?? team.side;
  const pictures = (side === "T" ? state.art?.defaultPlayers?.t : side === "CT" ? state.art?.defaultPlayers?.ct : null) ?? [];
  if (pictures.length === 0) return null;
  const order = [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  const i = Math.max(0, order.findIndex((x) => x.steamId === p.steamId));
  return pictures[i % pictures.length] ?? null;
}

/** A map's logo and picture from HUD images (null when not set). */
export function mapArt(state: HudState, mapName: string): { logoUrl: string | null; imageUrl: string | null } {
  const a = state.art?.maps?.[mapName];
  return { logoUrl: a?.logoUrl ?? null, imageUrl: a?.imageUrl ?? null };
}

/** The dead-player icon from HUD images, when set. */
export const deadIcon = (state: HudState): string | null => state.art?.icons?.dead ?? null;
