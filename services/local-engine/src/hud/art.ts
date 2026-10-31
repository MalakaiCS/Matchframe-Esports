import { z } from "zod";
import type { HudArt } from "@matchframe/hud-sdk";

/**
 * HUD images (HUD Library → HUD images): pictures the operator uploads for every Matchframe HUD —
 * default player pictures by side, a logo and a picture per map, and a dead-player icon. Stored as
 * asset ids (POST /api/v1/assets) in the program setting `hud.art`, on this computer only.
 */
export const HUD_ART_KEY = "hud.art";
export const HUD_ART_PLAYERS = 5;
export const HUD_ART_MAX_MAPS = 64;

/** An uploaded picture (`<sha256 prefix>.<ext>`). */
export const HudArtAsset = z.string().regex(/^[a-f0-9]{24}\.(png|jpe?g|webp|svg|gif)$/, "must be an uploaded PNG, JPG, WebP, SVG or GIF picture");

export const HudArtSetting = z.object({
  /** Up to five pictures per side, in order: player n of a team takes picture n (cycling). */
  defaultPlayers: z.object({ ct: z.array(HudArtAsset).max(HUD_ART_PLAYERS).default([]), t: z.array(HudArtAsset).max(HUD_ART_PLAYERS).default([]) }).default({ ct: [], t: [] }),
  /** Per map name (e.g. "de_mirage"). */
  maps: z
    .record(z.string().regex(/^[a-z0-9_]{1,64}$/, "map names are like de_mirage"), z.object({ logo: HudArtAsset.nullable().default(null), image: HudArtAsset.nullable().default(null) }))
    .refine((m) => Object.keys(m).length <= HUD_ART_MAX_MAPS, `at most ${HUD_ART_MAX_MAPS} maps`)
    .default({}),
  icons: z.object({ dead: HudArtAsset.nullable().default(null) }).default({ dead: null }),
});
export type HudArtSetting = z.infer<typeof HudArtSetting>;

export const emptyHudArt = (): HudArtSetting => ({ defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } });

/** The stored setting without empty map entries (an unreadable value counts as none). */
export function normalizeHudArt(value: unknown): HudArtSetting {
  const r = HudArtSetting.safeParse(value ?? {});
  if (!r.success) return emptyHudArt();
  const maps = Object.fromEntries(Object.entries(r.data.maps).filter(([, m]) => m.logo || m.image));
  return { ...r.data, maps };
}

/** Every asset id the setting refers to. */
export function hudArtAssets(a: HudArtSetting): string[] {
  return [...a.defaultPlayers.ct, ...a.defaultPlayers.t, ...Object.values(a.maps).flatMap((m) => [m.logo, m.image]), a.icons.dead].filter((id): id is string => !!id);
}

/** What HUDs receive: overlay-server addresses of the pictures. */
export function hudArtState(a: HudArtSetting, url: (assetId: string) => string | null): HudArt {
  const u = (id: string | null) => (id ? url(id) : null);
  return {
    defaultPlayers: { ct: a.defaultPlayers.ct.map(u).filter((x): x is string => !!x), t: a.defaultPlayers.t.map(u).filter((x): x is string => !!x) },
    maps: Object.fromEntries(Object.entries(a.maps).map(([name, m]) => [name, { logoUrl: u(m.logo), imageUrl: u(m.image) }])),
    icons: { dead: u(a.icons.dead) },
  };
}
