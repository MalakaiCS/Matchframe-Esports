import type { HudPlayer, HudState } from "@matchframe/hud-sdk";

/**
 * HUD images (state.art): the operator's own pictures from the HUD Library, used where a player,
 * map or mark has none. Every lookup tolerates an engine that sends no `art`.
 */

/** A player's picture: their own photo, else the default picture for their side (player n of the team, observer-slot order, takes picture n, cycling). */
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

/** A map's logo and picture (null when not set). */
export function mapArt(state: HudState, mapName: string | null | undefined): { logoUrl: string | null; imageUrl: string | null } {
  const a = mapName ? state.art?.maps?.[mapName] : undefined;
  return { logoUrl: a?.logoUrl ?? null, imageUrl: a?.imageUrl ?? null };
}

/** The operator's dead-player icon, replacing the HUD's own mark when set. */
export const deadIcon = (state: HudState): string | null => state.art?.icons?.dead ?? null;

/** Style for a tile with the map's picture behind it (darkened so the text stays readable). */
export function mapBackground(imageUrl: string | null): React.CSSProperties | undefined {
  return imageUrl ? { backgroundImage: `linear-gradient(rgba(10, 12, 18, 0.55), rgba(10, 12, 18, 0.8)), url("${imageUrl.replace(/["\\]/g, "")}")` } : undefined;
}
