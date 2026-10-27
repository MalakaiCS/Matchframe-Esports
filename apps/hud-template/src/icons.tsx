import type { ComponentType, SVGProps } from "react";
import ArmorFull from "./assets/icons/icon_armor_full_default.svg?react";
import ArmorHelmet from "./assets/icons/icon_armor_helmet_default.svg?react";
import Bomb from "./assets/icons/icon_bomb_default.svg?react";
import Bullets from "./assets/icons/icon_bullets_default.svg?react";
import C4 from "./assets/icons/icon_c4_default.svg?react";
import Defuse from "./assets/icons/icon_defuse_default.svg?react";
import FlashedKill from "./assets/icons/flashed_kill.svg?react";
import Headshot from "./assets/icons/headshot.svg?react";
import HealthFull from "./assets/icons/icon_health_full_default.svg?react";
import Skull from "./assets/icons/icon_skull_default.svg?react";
import SmallBomb from "./assets/icons/bomb.svg?react";
import Suicide from "./assets/icons/suicide.svg?react";
import LogoCT from "./assets/icons/logo_CT_default.png";
import LogoT from "./assets/icons/logo_T_default.png";

export { ArmorFull, ArmorHelmet, Bomb, Bullets, C4, Defuse, FlashedKill, Headshot, HealthFull, LogoCT, LogoT, Skull, SmallBomb, Suicide };

type Svg = ComponentType<SVGProps<SVGSVGElement>>;

/** Weapon silhouettes by id ("ak47", "smokegrenade", …), from the template's icon set. */
const WEAPONS: Record<string, Svg> = Object.fromEntries(
  Object.entries(import.meta.glob<Svg>("./assets/weapons/*.svg", { query: "?react", import: "default", eager: true })).map(([path, svg]) => [path.replace(/^.*\/(.+)\.svg$/, "$1"), svg]),
);

export function weaponIcon(id: string): Svg | null {
  return WEAPONS[id] ?? (id.startsWith("knife") || id === "bayonet" ? (WEAPONS.knife ?? null) : null);
}
