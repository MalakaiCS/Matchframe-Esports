import type { HudPlayer, HudState } from "@matchframe/hud-sdk";

/**
 * HUD images (state.art): the operator's own pictures from the HUD Library, used where a player,
 * map or mark has none. Every lookup tolerates an older engine that sends no `art`.
 */

/**
 * A player's picture: their own photo, else the operator's default picture for the side they play.
 * Player n of a team (observer-slot order) takes picture n, cycling; null keeps the HUD's silhouette.
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

/** A map's logo and picture for series tiles (null fields when not set). */
export function mapArt(state: HudState, mapName: string): { logoUrl: string | null; imageUrl: string | null } {
  const a = state.art?.maps?.[mapName];
  return { logoUrl: a?.logoUrl ?? null, imageUrl: a?.imageUrl ?? null };
}

/** The operator's dead-player icon, replacing the HUD's own mark when set. */
export const deadIcon = (state: HudState): string | null => state.art?.icons?.dead ?? null;
