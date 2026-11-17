import { createContext, useContext, useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArmorIcon, BlindIcon, BombIcon, GrenadeIcon, HeadshotIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { KillsMark, RoundKill } from "./bits.tsx";
import { bundledLookup, killCandidates, packIconUrl, packLookup, weaponCandidates, type IconPackState, type PackLookup } from "./iconNames.ts";

/**
 * The owner's icon set, bundled with the package (`owner-icons/<name>.png`: white silhouettes named
 * by CS2's weapon ids and the HUD's marks). Vite fingerprints them into the package's assets.
 */
const OWNER = bundledLookup(
  Object.fromEntries(Object.entries(import.meta.glob<string>("./owner-icons/*.png", { eager: true, query: "?url", import: "default" })).map(([path, url]) => [path.replace(/^.*\/(.+)\.png$/, "$1"), url])),
);

/**
 * One icon resolver for the whole HUD: the owner's icon set first, then the icon pack the operator
 * loaded (CS2's own icons), then the HUD's own glyphs and the bundled MIT weapon silhouettes.
 */
const PackContext = createContext<(PackLookup | null)[]>([OWNER]);

export function IconPackProvider({ pack, children }: { pack: IconPackState | null | undefined; children: ReactNode }) {
  // Rebuilt when the loaded pack's names change, not with every state's new object.
  const key = pack ? `${pack.base}|${pack.names.join(",")}` : "";
  const value = useMemo(() => [OWNER, packLookup(pack)], [key]);
  return <PackContext.Provider value={value}>{children}</PackContext.Provider>;
}

const usePacks = () => useContext(PackContext);

/**
 * A set's icon in the current text colour: the icons are white silhouettes, so the image is a CSS
 * mask over `currentColor` (tints on any card), and a hidden copy gives the box the icon's shape.
 */
function PackIcon({ url, size, className = "", label }: { url: string; size?: number; className?: string; label: string }) {
  const style = { "--ico": `url("${url}")`, ...(size ? { height: size } : {}) } as CSSProperties;
  return (
    <span className={`st-ico ${className}`} style={style} role="img" aria-label={label}>
      <img src={url} alt="" aria-hidden />
    </span>
  );
}

/** A named icon (the first name a set has, most specific first), else `fallback`. */
export function Ico({ name, size, className, fallback, label }: { name: string | string[]; size?: number; className?: string; fallback: ReactNode; label?: string }) {
  const names = Array.isArray(name) ? name : [name];
  const url = packIconUrl(usePacks(), ...names);
  return url ? <PackIcon url={url} size={size} className={className} label={label ?? names[0]!} /> : <>{fallback}</>;
}

/** A weapon (`weapon_ak47`, a knife, the bomb): a set's silhouette, else the bundled one. */
export function Weapon({ weapon, className = "", kill = false }: { weapon: string; className?: string; kill?: boolean }) {
  const url = packIconUrl(usePacks(), ...(kill ? killCandidates(weapon) : weaponCandidates(weapon)));
  return url ? <PackIcon url={url} className={`mf-weapon ${className}`} label={weapon} /> : <WeaponIcon weapon={weapon} className={className} />;
}

export const Grenade = ({ type, size }: { type: string; size: number }) => <Ico name={weaponCandidates(type)} size={size} className="st-ico-nade" fallback={<GrenadeIcon type={type} size={size} />} />;
/** Armour: the helmet with a helmet, the vest without. */
export const Armor = ({ helmet, size, className = "" }: { helmet: boolean; size: number; className?: string }) => <Ico name={helmet ? ["helmet", "armor"] : ["kevlar"]} size={size} className={className} label={helmet ? "armour and helmet" : "armour"} fallback={<ArmorIcon helmet={helmet} size={size} className={className} />} />;
export const Kit = ({ size, className = "" }: { size: number; className?: string }) => <Ico name="defuser" size={size} className={className} label="defuse kit" fallback={<KitIcon size={size} className={className} />} />;
/** The bomb on its carrier's card. */
export const Bomb = ({ size, className = "" }: { size: number; className?: string }) => <Ico name={["bomb_carrier", "c4"]} size={size} className={className} label="bomb carrier" fallback={<BombIcon size={size} className={className} />} />;
/** The bomb's state in the score bar. */
export const BombState = ({ state, size }: { state: "planting" | "planted" | "defusing" | "defused" | "exploded"; size: number }) => {
  const names = { planting: ["planting", "c4"], planted: ["bomb_planted", "planted_c4", "bomb_icon"], defusing: ["defusing", "defuser"], defused: ["bomb_defused", "defuser"], exploded: ["explosion", "planted_c4"] }[state];
  return <Ico name={names} size={size} label={`bomb ${state}`} fallback={state === "defusing" || state === "defused" ? <KitIcon size={size} /> : <BombIcon size={size} />} />;
};
export const Kills = ({ size }: { size: number }) => <Ico name={["kills", "kill"]} size={size} label="kills" fallback={<KillsMark size={size} />} />;
export const Deaths = ({ size }: { size: number }) => <Ico name={["deaths", "elimination"]} size={size} label="deaths" fallback={<SkullIcon size={size} />} />;
export const Assists = ({ size }: { size: number }) => <Ico name={["assists", "stat_assists"]} size={size} label="assists" fallback={<i>A</i>} />;
export const DeadMark = ({ size }: { size: number }) => <Ico name={["deaths", "kill"]} size={size} label="eliminated" fallback={<SkullIcon size={size} />} />;
export const Headshot = ({ size, className = "" }: { size: number; className?: string }) => <Ico name={["headshot", "kill_headshot"]} size={size} className={className} label="headshot" fallback={<HeadshotIcon size={size} className={className} />} />;
export const Blinded = ({ size, className = "" }: { size: number; className?: string }) => <Ico name="blinded" size={size} className={className} label="blinded" fallback={<BlindIcon size={size} className={className} />} />;
export const RoundKillMark = () => <Ico name="star" size={13} className="st-rk" label="round kill" fallback={<RoundKill />} />;
export const Health = ({ size }: { size: number }) => <Ico name="health" size={size} className="st-ico-hp" label="health" fallback={null} />;
export const Dollar = () => <Ico name={["money", "dollar_sign"]} size={15} className="st-ico-dollar" label="$" fallback={<i>$</i>} />;
export const Ammo = ({ size }: { size: number }) => <Ico name="ammo" size={size} className="st-ico-ammo" label="ammunition" fallback={<i className="st-obs-ammo-bar" />} />;
export const Paused = ({ size }: { size: number }) => <Ico name={["paused", "pause"]} size={size} label="paused" fallback={null} />;
/** The owner's labelled TIMEOUT mark (only where a label fits), else the text. */
export const TimeoutMark = ({ size }: { size: number }) => <Ico name="timeout" size={size} className="st-ico-timeout" label="timeout" fallback={<b>TIMEOUT</b>} />;
export const Disconnected = ({ size }: { size: number }) => <Ico name="disconnected" size={size} label="disconnected" fallback={<span className="st-offline">OFFLINE</span>} />;
