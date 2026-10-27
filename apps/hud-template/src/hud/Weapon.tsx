import { memo } from "react";
import type { SVGProps } from "react";
import { weaponIcon } from "../icons.tsx";
import { weaponId } from "../util.ts";

interface Props extends SVGProps<SVGSVGElement> {
  weapon: string;
  active: boolean;
  isGrenade?: boolean;
}

/** Weapon silhouette; `active` is the weapon in hand. Unknown weapons render nothing. */
function Weapon({ weapon, active, isGrenade, className, ...rest }: Props) {
  const Icon = weaponIcon(weaponId(weapon));
  if (!Icon) return null;
  return <Icon fill="white" className={`${active ? "active" : ""} weapon ${isGrenade ? "grenade" : ""} ${className ?? ""}`} {...rest} />;
}

export default memo(Weapon);
