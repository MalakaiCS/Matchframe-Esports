import { memo } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { deadIcon, playerPicture } from "../shared/art.ts";
import { ArmorIcon, BombIcon, GrenadeIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { KillsMark, Photo, RoundKill, TeamLogo } from "./bits.tsx";
import { cash, slotKey, slotOrder, teamName, teamVars, type Settings } from "./util.ts";

const NADE_ORDER = ["smoke", "flash", "hegrenade", "molotov", "incgrenade", "decoy"];

/** A player's grenades as a stable comma list, one entry per grenade (two flashbangs show twice), at most four. */
export function grenadeList(p: HudPlayer): string {
  const out: string[] = [];
  for (const g of p.grenades) {
    const n = g.name.includes("flash") ? Math.min(2, Math.max(1, g.ammoReserve ?? 1)) : 1;
    for (let i = 0; i < n; i++) out.push(g.name.startsWith("weapon_") ? g.name : `weapon_${g.name}`);
  }
  const rank = (n: string) => {
    const i = NADE_ORDER.findIndex((k) => n.includes(k));
    return i < 0 ? 99 : i;
  };
  return out
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 4)
    .join(",");
}

export function Nades({ list, size = 15 }: { list: string; size?: number }) {
  if (!list) return null;
  return (
    <span className="st-nades">
      {list.split(",").map((g, i) => (
        <GrenadeIcon key={`${g}-${i}`} type={g} size={size} />
      ))}
    </span>
  );
}

interface CardProps {
  name: string;
  slot: string;
  picture: string | null;
  deadIcon: string | null;
  color: string;
  align: "left" | "right";
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  bomb: boolean;
  money: number | null;
  kills: number | null;
  deaths: number | null;
  roundKills: number;
  main: string | null;
  other: string | null;
  otherActive: boolean;
  nades: string;
  observed: boolean;
  flashed: number;
  showMoney: boolean;
  index: number;
}

/**
 * One player card: the slot number at the screen edge, name, kills and deaths, money; the photo;
 * then the gear (active and main weapon, grenades, armour, kit or bomb) and the health as a big
 * number, with a health bar along the foot of the card. Dead: grey, the photo faded, a skull where
 * the gear was; the name, stats and money stay. Every prop is a primitive, so React.memo skips cards
 * whose content is unchanged.
 */
const Card = memo(function Card(p: CardProps) {
  const dead = !p.alive;
  const hp = dead ? 0 : Math.max(0, Math.min(100, p.health));
  return (
    <div className={`st-card st-card-${p.align} ${dead ? "is-dead" : ""} ${p.observed ? "is-observed" : ""}`} style={{ ...teamVars(p.color), ["--i" as string]: p.index }}>
      <span className="st-card-body" aria-hidden />
      {p.roundKills > 0 ? (
        <span className="st-card-rk" aria-label={`${p.roundKills} kills this round`}>
          {Array.from({ length: Math.min(5, p.roundKills) }, (_, i) => (
            <RoundKill key={i} />
          ))}
          {p.roundKills > 5 ? <b>{p.roundKills}</b> : null}
        </span>
      ) : null}
      <span className="st-card-slot">{p.slot}</span>
      <span className="st-card-info">
        <span className={`st-card-name ${p.name.length > 11 ? "is-long" : ""}`}>{p.name}</span>
        <span className="st-card-kd">
          <span>
            <KillsMark size={13} />
            <b>{p.kills ?? "–"}</b>
          </span>
          <span>
            <SkullIcon size={15} />
            <b>{p.deaths ?? "–"}</b>
          </span>
        </span>
        {p.showMoney ? <span className="st-card-money">{cash(p.money)}</span> : null}
      </span>
      <span className="st-card-pic">
        <Photo url={p.picture} />
        <span className="st-card-flash" style={{ opacity: dead ? 0 : Math.min(1, p.flashed) * 0.8 }} aria-hidden />
      </span>
      <span className="st-card-gear">
        <span className="st-card-guns">
          {p.other ? <WeaponIcon weapon={p.other} className={`st-gun is-other ${p.otherActive ? "is-active" : ""}`} /> : null}
          {p.main ? <WeaponIcon weapon={p.main} className={`st-gun is-main ${p.otherActive ? "" : "is-active"}`} /> : null}
        </span>
        <span className={`st-card-hp ${p.health <= 20 ? "is-low" : ""}`}>{dead ? "" : p.health}</span>
        <span className="st-card-kit">
          <Nades list={p.nades} size={14} />
          {p.bomb ? <BombIcon size={17} className="st-c4" /> : p.kit ? <KitIcon size={15} className="st-kit" /> : null}
          {p.armor > 0 ? <ArmorIcon helmet={p.helmet} size={15} className="st-armor" /> : null}
        </span>
      </span>
      <span className={`st-card-skull ${p.deadIcon ? "is-art" : ""}`} aria-hidden>
        {p.deadIcon ? <img src={p.deadIcon} alt="" /> : <SkullIcon size={40} />}
      </span>
      <span className="st-card-health" aria-hidden>
        <i className="st-card-trail" style={{ transform: `scaleX(${hp / 100})` }} />
        <i className="st-card-fill" style={{ transform: `scaleX(${hp / 100})` }} />
      </span>
    </div>
  );
});

/** The weapon a card shows big (primary, else pistol) and, when the player holds something else, that too. */
function weapons(p: HudPlayer): { main: string | null; other: string | null; otherActive: boolean } {
  if (p.alive === false) return { main: null, other: null, otherActive: false };
  const main = p.primary?.name ?? p.secondary?.name ?? null;
  const active = p.activeWeapon?.name ?? null;
  // Holding a grenade, the knife, the bomb or the pistol next to a rifle: both show, the held one lit.
  if (active && active !== main) return { main, other: active, otherActive: true };
  return { main: main ?? "weapon_knife", other: null, otherActive: false };
}

function cardProps(state: HudState, p: HudPlayer, color: string, align: "left" | "right", showMoney: boolean, index: number): CardProps {
  const alive = p.alive !== false;
  return {
    name: p.name,
    slot: slotKey(p.slot),
    picture: playerPicture(state, p),
    deadIcon: deadIcon(state),
    color,
    align,
    alive,
    health: p.health ?? (alive ? 100 : 0),
    armor: alive ? (p.armor ?? 0) : 0,
    helmet: !!p.helmet,
    kit: alive && !!p.defuseKit,
    bomb: alive && p.hasBomb,
    money: p.money,
    kills: p.kills,
    deaths: p.deaths,
    roundKills: p.roundKills ?? 0,
    ...weapons(p),
    nades: alive ? grenadeList(p) : "",
    observed: p.observed,
    flashed: Math.round((p.flashed ?? 0) * 10) / 10,
    showMoney,
    index,
  };
}

/** One side's team tab and five cards in slot order (the right side mirrored). */
export function TeamCards({ state, team, color, align, settings, shown }: { state: HudState; team: HudTeam; color: string; align: "left" | "right"; settings: Settings; shown: boolean }) {
  return (
    <div className={`st-cards st-cards-${align} ${shown ? "is-on" : ""}`} style={teamVars(color)}>
      <div className="st-tab">
        <span className="st-tab-logo">
          <TeamLogo team={team} />
        </span>
        <span className="st-tab-name">{teamName(team, settings)}</span>
      </div>
      {slotOrder(team).map((p, i) => (
        <Card key={p.steamId} {...cardProps(state, p, color, align, settings.showMoney, i)} />
      ))}
    </div>
  );
}
