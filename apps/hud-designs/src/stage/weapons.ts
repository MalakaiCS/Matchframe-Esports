import type { HudPlayer, HudWeapon } from "@matchframe/hud-sdk";

type Armed = Pick<HudPlayer, "alive" | "primary" | "secondary" | "activeWeapon">;

const isTaser = (w: HudWeapon | null): w is HudWeapon => !!w && (w.kind === "taser" || /taser/.test(w.name));

/**
 * The one weapon a player card shows: the primary, else the pistol, else the Zeus when that is all
 * they carry, else the knife. Never what they hold at the moment (a knife, a grenade, the bomb or the
 * pistol next to a rifle): the card doesn't change when they switch. Nothing for a dead player.
 */
export function mainWeaponName(p: Armed): string | null {
  if (p.alive === false) return null;
  if (p.primary) return p.primary.name;
  if (p.secondary) return p.secondary.name;
  if (isTaser(p.activeWeapon)) return p.activeWeapon.name;
  return "weapon_knife";
}

/**
 * The weapon whose ammunition the observed player's panel shows: the one in hand when it has ammo
 * (a gun or the Zeus), else their main gun's; null when neither has any (knife only).
 */
export function ammoWeapon(p: Armed): HudWeapon | null {
  const held = p.activeWeapon;
  if (held && held.ammoClip !== null && held.kind !== "grenade" && held.kind !== "knife") return held;
  const main = p.primary ?? p.secondary;
  return main && main.ammoClip !== null ? main : null;
}
