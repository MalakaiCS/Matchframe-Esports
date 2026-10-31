import { memo, useRef } from "react";
import type { HudPlayer, HudTeam } from "@matchframe/hud-sdk";
import { mainWeapon, money } from "../shared/format.ts";
import { ArmorIcon, BombIcon, GrenadeIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { Portrait } from "./Badge.tsx";
import { teamVars, useCountdown } from "./util.ts";

const NADE_ORDER = ["smoke", "flash", "hegrenade", "molotov", "incgrenade", "decoy"];

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
    .slice(0, 5)
    .join(",");
}

export function Nades({ list, size }: { list: string; size: number }) {
  if (!list) return null;
  return (
    <span className="lu-nades">
      {list.split(",").map((g, i) => (
        <GrenadeIcon key={`${g}-${i}`} type={g} size={size} />
      ))}
    </span>
  );
}

/** Health as a big number that counts down when hit. */
export function HealthNumber({ value, className }: { value: number; className: string }) {
  const shown = useCountdown(value);
  return <span className={`${className} ${value <= 20 ? "is-low" : ""}`}>{shown}</span>;
}

/** Health bar with a damage trail that catches up ~300 ms after a hit. */
export function HpBar({ health, className = "" }: { health: number; className?: string }) {
  const f = `scaleX(${Math.max(0, Math.min(100, health)) / 100})`;
  return (
    <span className={`lu-hpbar ${className}`} aria-hidden>
      <i className="lu-hpbar-trail" style={{ transform: f }} />
      <i className={`lu-hpbar-fill ${health <= 20 ? "is-low" : ""}`} style={{ transform: f }} />
    </span>
  );
}

interface CardProps {
  name: string;
  avatarUrl: string | null;
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
  adr: number | null;
  weapon: string | null;
  nades: string;
  observed: boolean;
  flashed: number;
  live: boolean;
  showMoney: boolean;
}

/**
 * One upright player card: portrait and health on top, name, K/D and money, then a foot row that is
 * the money/equipment detail in freeze time, the weapon and grenades once live, and the round's
 * kills when dead. Every prop is a primitive, so React.memo skips cards whose content is unchanged.
 */
const Card = memo(function Card(p: CardProps) {
  const dead = !p.alive;
  // A dying card fades out the health it had rather than counting down to zero.
  const lastHealth = useRef(p.health);
  if (!dead) lastHealth.current = p.health;
  const mode = dead ? "dead" : p.live ? "gear" : "econ";
  return (
    <div className={`lu-card lu-card-${p.align} ${dead ? "is-dead" : ""} ${p.observed ? "is-observed" : ""} mode-${mode}`} style={teamVars(p.color)}>
      <span className="lu-card-ring" aria-hidden />
      <div className="lu-card-body">
        <span className="lu-card-wash" aria-hidden />
        <span className="lu-card-edge" aria-hidden />
        <div className="lu-card-head">
          <span className="lu-card-face">
            <Portrait name={p.name} avatarUrl={p.avatarUrl} className="lu-card-portrait" />
            <span className="lu-card-flash" style={{ opacity: dead ? 0 : Math.min(1, p.flashed) * 0.85 }} aria-hidden />
          </span>
          <div className="lu-card-vitals">
            <span className="lu-card-hpwrap">
              <HealthNumber value={dead ? lastHealth.current : p.health} className="lu-card-hp" />
              <SkullIcon size={30} className="lu-card-skull" />
            </span>
            <span className="lu-card-armor">
              {!dead && p.armor > 0 ? (
                <>
                  <ArmorIcon helmet={p.helmet} size={12} />
                  {p.armor}
                </>
              ) : null}
            </span>
          </div>
        </div>
        <HpBar health={dead ? 0 : p.health} className="lu-card-hpbar" />
        <div className="lu-card-name">
          <span>{p.name}</span>
          {!dead && p.bomb ? <BombIcon size={15} className="lu-card-c4" /> : !dead && p.kit ? <KitIcon size={14} className="lu-card-kit" /> : null}
        </div>
        <div className="lu-card-stats">
          <span>
            K<b>{p.kills ?? "–"}</b>
          </span>
          <span>
            D<b>{p.deaths ?? "–"}</b>
          </span>
          {p.showMoney && p.money !== null ? <span className="lu-card-money">{money(p.money)}</span> : null}
        </div>
        <div className="lu-card-foot">
          <div className="lu-card-econ">
            <span className="lu-card-econ-label">EQUIP</span>
            <span className="lu-card-econ-value">{p.equip !== null ? money(p.equip) : "–"}</span>
            <span className="lu-card-econ-icons">
              {p.armor > 0 ? <ArmorIcon helmet={p.helmet} size={15} /> : null}
              {p.kit ? <KitIcon size={15} /> : null}
              {p.bomb ? <BombIcon size={16} className="lu-card-c4" /> : null}
            </span>
          </div>
          <div className="lu-card-gear">
            {p.weapon ? <WeaponIcon weapon={p.weapon} className="lu-card-weapon" /> : <span />}
            <Nades list={p.nades} size={13} />
          </div>
          <div className="lu-card-dead">
            <span className="lu-card-econ-label">THIS ROUND</span>
            <span className="lu-card-dead-value">
              {p.roundKills > 0 ? `${p.roundKills} KILL${p.roundKills > 1 ? "S" : ""}` : "NO KILLS"}
              {p.adr !== null ? <small>ADR {p.adr}</small> : null}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

function cardProps(p: HudPlayer, color: string, align: "left" | "right", live: boolean, showMoney: boolean): CardProps {
  const alive = p.alive !== false;
  return {
    name: p.name,
    avatarUrl: p.avatarUrl,
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
    adr: p.adr,
    weapon: alive ? mainWeapon(p) : null,
    nades: alive ? grenadeList(p) : "",
    observed: p.observed,
    flashed: Math.round((p.flashed ?? 0) * 10) / 10,
    live,
    showMoney,
  };
}

/** A team's five cards in slot order. */
export function TeamCards({ team, color, align, live, showMoney }: { team: HudTeam; color: string; align: "left" | "right"; live: boolean; showMoney: boolean }) {
  const players = [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).slice(0, 5);
  return (
    <div className={`lu-cards lu-cards-${align}`}>
      {players.map((p) => (
        <Card key={p.steamId} {...cardProps(p, color, align, live, showMoney)} />
      ))}
    </div>
  );
}
