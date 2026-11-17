/**
 * Icon sets for the Stage HUD, in priority order: the owner's icon set bundled with the package
 * (PNG silhouettes), then the icon pack the operator loaded on their computer (state.art.iconPack:
 * Counter-Strike 2's own icons, which MatchFrame does not ship), then the HUD's own (MatchFrame's
 * glyphs and the bundled MIT weapon icons). Icons are looked up by name; a name a set lacks falls
 * through to the next set.
 */
export interface IconPackState {
  names: string[];
  base: string;
}

/** One icon set: which names it has and where each is. */
export interface PackLookup {
  has: Set<string>;
  url: (name: string) => string;
}

/** The loaded icon pack as a lookup (null without one). */
export const packLookup = (pack: IconPackState | null | undefined): PackLookup | null => (pack && pack.names.length ? { has: new Set(pack.names), url: (n) => `${pack.base}${n}.svg` } : null);

/** A bundled set from `{ name: url }` (null when empty). */
export const bundledLookup = (urls: Record<string, string>): PackLookup | null => (Object.keys(urls).length ? { has: new Set(Object.keys(urls)), url: (n) => urls[n]! } : null);

/** Game item names (`weapon_ak47`, `item_defuser`) as icon names (`ak47`, `defuser`). */
export function weaponIconName(weapon: string): string {
  const n = weapon.toLowerCase().replace(/^(weapon|item)_/, "");
  if (n === "knife_default_ct" || n === "knife_default_t") return n === "knife_default_t" ? "knife_t" : "knife";
  return n;
}

/** The names to try for a weapon, most specific first: a knife variant falls back to the knife, a silencer off to on, CS2's P2000 id to its name. */
export function weaponCandidates(weapon: string): string[] {
  const n = weaponIconName(weapon);
  const out = [n];
  if (n.endsWith("_off")) out.push(n.slice(0, -4));
  if (n === "hkp2000") out.push("p2000");
  if (n.startsWith("knife") || n === "bayonet" || n === "melee") out.push("knife");
  return out;
}

/** A kill's way for the killfeed: fire and grenade kills show the fire or blast mark first. */
export function killCandidates(weapon: string): string[] {
  const n = weaponIconName(weapon);
  if (n === "inferno" || n === "molotov" || n === "incgrenade") return ["fire_damage", ...weaponCandidates(weapon)];
  if (n === "hegrenade") return ["explosion", ...weaponCandidates(weapon)];
  return weaponCandidates(weapon);
}

/**
 * The address of the icon for the first of `names` (most specific first) that a set has, sets in
 * priority order; null when none has any (then the HUD's own icon).
 */
export function packIconUrl(packs: PackLookup | null | (PackLookup | null)[], ...names: string[]): string | null {
  const list = (Array.isArray(packs) ? packs : [packs]).filter((p): p is PackLookup => !!p);
  for (const n of names) for (const p of list) if (p.has.has(n)) return p.url(n);
  return null;
}
