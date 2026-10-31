import { memo, useRef } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { deadIcon, playerPicture } from "../shared/art.ts";
import { mainWeapon, money } from "../shared/format.ts";
import { ArmorIcon, BombIcon, HeadshotIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { Portrait } from "./Badge.tsx";
import { teamVars, useCountdown } from "./util.ts";

const NADE_ORDER = ["smoke", "flash", "hegrenade", "molotov", "incgrenade", "decoy"];
/** Grenade slots on a card: empty ones show as dots. */
const NADE_SLOTS = 4;
/** Money from which a full buy is possible (rifle and armour): shown green, below it red. */
const RICH = 3700;

/** A player's grenades as a stable comma list, one entry per grenade (two flashbangs show twice). */
export function grenadeList(p: HudPlayer): string {
  const out: string[] = [];
  for (const g of p.grenades) {
    const n = g.name.includes("flash") ? Math.min(2, Math.max(1, g.ammoReserve ?? 1)) : 1;
    for (let i = 0; i < n; i++) out.push(g.name);
  }
  const rank = (n: string) => {
    const i = NADE_ORDER.findIndex((k) => n.includes(k));
    return i < 0 ? 99 : i;
  };
  return out
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, NADE_SLOTS)
    .join(",");
}

/** Grenade silhouettes, then a dot for each empty slot. */
export function Nades({ list, dots = true }: { list: string; dots?: boolean }) {
  const nades = list ? list.split(",") : [];
  return (
    <span className="lu-nades">
      {nades.map((g, i) => (
        <WeaponIcon key={`${g}-${i}`} weapon={g} className="lu-nade" />
      ))}
      {dots ? Array.from({ length: NADE_SLOTS - nades.length }, (_, i) => <i key={`d${i}`} className="lu-nade-dot" />) : null}
    </span>
  );
}

/** A round kill. */
const Star = () => (
  <svg viewBox="0 0 24 24" className="lu-star" aria-hidden>
    <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7.1L12 17.3 5.8 21l1.6-7.1L2 9.2l7.1-.6z" fill="currentColor" />
  </svg>
);

/** Health as a big number that counts down when hit. */
export function HealthNumber({ value, className }: { value: number; className: string }) {
  const shown = useCountdown(value);
  return <span className={`${className} ${value <= 20 ? "is-low" : ""}`}>{shown}</span>;
}

/** The health gauge: the team colour fills the card's upper body from the bottom; a light trail follows ~300 ms after a hit. */
const gauge = (health: number) => ({ clipPath: `inset(${100 - Math.max(0, Math.min(100, health))}% 0 0 0)` });

interface CardProps {
  name: string;
  avatarUrl: string | null;
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
  equip: number | null;
  kills: number | null;
  deaths: number | null;
  roundKills: number;
  roundDamage: number | null;
  weapon: string | null;
  nades: string;
  observed: boolean;
  flashed: number;
  live: boolean;
  showMoney: boolean;
}

/**
 * One player card: the photo stands on the card, whose upper body is the team colour filled to the
 * player's health, with the name and the health number; then the K/D band and money, then grenades
 * and weapon (the equipment value in freeze time, the round's kills when dead), and a team-colour
 * base line. Every prop is a primitive, so React.memo skips cards whose content is unchanged.
 */
const Card = memo(function Card(p: CardProps) {
  const dead = !p.alive;
  // A dying card fades out the health it had rather than counting down to zero.
  const lastHealth = useRef(p.health);
  if (!dead) lastHealth.current = p.health;
  const mode = dead ? "dead" : p.live ? "gear" : "econ";
  const hp = dead ? 0 : p.health;
  return (
    <div className={`lu-card lu-card-${p.align} ${dead ? "is-dead" : ""} ${p.observed ? "is-observed" : ""} mode-${mode}`} style={teamVars(p.color)}>
      {!dead && (p.bomb || p.kit) ? <span className="lu-card-tag">{p.bomb ? <BombIcon size={20} /> : <KitIcon size={16} />}</span> : null}
      <div className="lu-card-top">
        <span className="lu-card-base" aria-hidden />
        <span className="lu-card-trail" style={gauge(hp)} aria-hidden />
        <span className="lu-card-fill" style={gauge(hp)} aria-hidden />
        <Portrait avatarUrl={p.avatarUrl} className="lu-card-photo" />
        <span className={`lu-card-skull ${p.deadIcon ? "is-art" : ""}`} aria-hidden>
          {p.deadIcon ? <img src={p.deadIcon} alt="" /> : <SkullIcon size={58} />}
        </span>
        <span className="lu-card-shade" aria-hidden />
        <span className="lu-card-flash" style={{ opacity: dead ? 0 : Math.min(1, p.flashed) * 0.7 }} aria-hidden />
        <span className="lu-card-marks">
          {p.roundKills > 0 ? (
            <span className="lu-card-stars" aria-label={`${p.roundKills} kills this round`}>
              {Array.from({ length: Math.min(5, p.roundKills) }, (_, i) => (
                <Star key={i} />
              ))}
            </span>
          ) : null}
          {!dead && p.armor > 0 ? <ArmorIcon helmet={p.helmet} size={14} className="lu-card-armor" /> : null}
        </span>
        <span className="lu-card-name">{p.name}</span>
        <HealthNumber value={dead ? lastHealth.current : p.health} className="lu-card-hp" />
      </div>
      <div className="lu-card-stats">
        <span className="lu-kd">
          <i>
            <HeadshotIcon size={13} />
          </i>
          <b>{p.kills ?? "–"}</b>
          <i>
            <SkullIcon size={14} />
          </i>
          <b>{p.deaths ?? "–"}</b>
        </span>
        {p.showMoney && p.money !== null ? <span className={`lu-card-money ${p.money >= RICH ? "is-rich" : ""}`}>{money(p.money)}</span> : null}
      </div>
      <div className="lu-card-foot">
        <div className="lu-card-econ">
          <span className="lu-card-econ-label">EQUIP</span>
          <span className="lu-card-econ-value">{p.equip !== null ? money(p.equip) : "–"}</span>
          {p.weapon ? <WeaponIcon weapon={p.weapon} className="lu-card-weapon" /> : null}
        </div>
        <div className="lu-card-gear">
          <Nades list={p.nades} />
          {p.weapon ? <WeaponIcon weapon={p.weapon} className="lu-card-weapon" /> : null}
        </div>
        <div className="lu-card-dead">
          {p.roundDamage !== null ? `ROUND DAMAGE ${p.roundDamage}` : `THIS ROUND · ${p.roundKills} KILL${p.roundKills === 1 ? "" : "S"}`}
        </div>
      </div>
      <span className="lu-card-line" aria-hidden />
      <span className="lu-card-ring" aria-hidden />
    </div>
  );
});

function cardProps(state: HudState, p: HudPlayer, color: string, align: "left" | "right", live: boolean, showMoney: boolean): CardProps {
  const alive = p.alive !== false;
  return {
    name: p.name,
    avatarUrl: playerPicture(state, p),
    deadIcon: deadIcon(state),
    color,
    align,
    alive,
    health: p.health ?? (alive ? 100 : 0),
    armor: p.armor ?? 0,
    helmet: !!p.helmet,
    kit: !!p.defuseKit,
    bomb: p.hasBomb,
    money: p.money,
    equip: p.equipValue,
    kills: p.kills,
    deaths: p.deaths,
    roundKills: p.roundKills ?? 0,
    roundDamage: p.roundDamage ?? null,
    weapon: alive ? mainWeapon(p) : null,
    nades: alive ? grenadeList(p) : "",
    observed: p.observed,
    flashed: Math.round((p.flashed ?? 0) * 10) / 10,
    live,
    showMoney,
  };
}

/** A team's five cards in slot order. */
export function TeamCards({ state, team, color, align, live, showMoney }: { state: HudState; team: HudTeam; color: string; align: "left" | "right"; live: boolean; showMoney: boolean }) {
  const players = [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).slice(0, 5);
  return (
    <div className={`lu-cards lu-cards-${align}`}>
      {players.map((p) => (
        <Card key={p.steamId} {...cardProps(state, p, color, align, live, showMoney)} />
      ))}
    </div>
  );
}
