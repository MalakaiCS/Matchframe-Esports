import type { ComponentType, SVGProps } from "react";

type Svg = ComponentType<SVGProps<SVGSVGElement>>;

/** Weapon silhouettes by id ("ak47", "awp", …): the Pro CS2 HUD's icon set (Lexogrine, MIT). */
const WEAPONS: Record<string, Svg> = Object.fromEntries(
  Object.entries(import.meta.glob<Svg>("../../../hud-template/src/assets/weapons/*.svg", { query: "?react", import: "default", eager: true })).map(([path, svg]) => [path.replace(/^.*\/(.+)\.svg$/, "$1"), svg]),
);

export const weaponId = (name: string): string => name.replace(/^weapon_/, "");

/** Silhouette in the current text colour; the weapon's id as text when there is no icon. */
export function WeaponIcon({ weapon, className = "" }: { weapon: string; className?: string }) {
  const id = weaponId(weapon);
  const Icon = WEAPONS[id] ?? (id.startsWith("knife") || id === "bayonet" ? WEAPONS.knife : undefined);
  if (!Icon) return <span className={`mf-weapon-text ${className}`}>{id.replace(/_/g, " ")}</span>;
  return <Icon className={`mf-weapon ${className}`} fill="currentColor" role="img" aria-label={id} />;
}
