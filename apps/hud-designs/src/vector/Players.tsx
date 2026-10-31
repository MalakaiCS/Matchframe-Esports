import { memo } from "react";
import type { HudPlayer, HudTeam } from "@matchframe/hud-sdk";
import { equipmentValue, mainWeapon, money, utilityCounts } from "../shared/format.ts";
import { ArmorIcon, BombIcon, GrenadeIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { Avatar, HealthBar, sizeClass } from "./bits.tsx";
import type { Align } from "./bits.tsx";

const stat = (v: number | null) => (v === null ? "–" : v);

/** One grenade icon per grenade carried (two flashbangs show twice). */
function grenades(p: HudPlayer): string[] {
  const out: string[] = [];
  for (const g of p.grenades) for (let i = 0; i < Math.min(2, Math.max(1, g.ammoReserve ?? 1)); i++) out.push(g.name);
  return out.slice(0, 4);
}

interface CardProps {
  player: HudPlayer;
  align: Align;
  showMoney: boolean;
}

function Card({ player: p, align, showMoney }: CardProps) {
  const alive = p.alive !== false;
  const hp = alive ? Math.max(0, Math.min(100, p.health ?? 0)) : 0;
  const weapon = mainWeapon(p);
  const held = !!p.activeWeapon && !!weapon && p.activeWeapon.name === weapon;
  return (
    <div className={`vx-card vx-${align} ${alive ? "" : "is-dead"} ${p.observed ? "is-observed" : ""}`} data-steamid={p.steamId}>
      <i className="vx-card-edge" />
      <i className="vx-card-focus" />
      <span className="vx-card-ava">
        <Avatar player={p} />
        {p.slot !== null ? <span className="vx-card-slot">{p.slot}</span> : null}
        {p.roundKills ? (
          <span className="vx-card-rk">
            <SkullIcon size={11} />
            {p.roundKills}
          </span>
        ) : null}
      </span>
      <div className="vx-card-body">
        <div className="vx-card-top">
          <span className="vx-card-hp">
            <span className="vx-card-hp-n">
              {(p.armor ?? 0) > 0 ? <ArmorIcon helmet={!!p.helmet} size={12} className="vx-card-armor" /> : null}
              {hp}
            </span>
          </span>
          <span className={`vx-card-name ${sizeClass(p.name.length, 7, 9, 11)}`}>{p.name}</span>
          <span className={`vx-card-gun vx-alive-only ${held ? "is-held" : ""}`}>{weapon ? <WeaponIcon weapon={weapon} /> : null}</span>
        </div>
        <HealthBar value={hp} className="vx-alive-only" />
        <div className="vx-card-bottom">
          {showMoney ? <span className="vx-money">{money(p.money)}</span> : null}
          <span className="vx-kd">
            <b>{stat(p.kills)}</b>
            <i>/</i>
            <b>{stat(p.deaths)}</b>
          </span>
          <span className="vx-card-kit vx-alive-only">
            {grenades(p).map((g, i) => (
              <GrenadeIcon key={`${g}-${i}`} type={g} size={14} />
            ))}
            {p.hasBomb ? <BombIcon size={16} className="vx-is-bomb" /> : null}
            {p.defuseKit ? <KitIcon size={15} className="vx-is-kit" /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/** What a card shows: it re-renders only when one of these changes. */
const shown = (p: HudPlayer): string =>
  [p.name, p.slot, p.alive, p.health, p.armor, p.helmet, p.defuseKit, p.hasBomb, p.money, p.kills, p.deaths, p.roundKills, p.observed, p.avatarUrl, p.primary?.name, p.secondary?.name, p.activeWeapon?.name, p.grenades.map((g) => `${g.name}${g.ammoReserve ?? ""}`).join()].join("|");

const PlayerCard = memo(Card, (a, b) => a.align === b.align && a.showMoney === b.showMoney && shown(a.player) === shown(b.player));

const KINDS = [
  ["smoke", "smoke"],
  ["flash", "flashbang"],
  ["he", "he"],
  ["fire", "molotov"],
] as const;

/** Freeze time: the team's grenades (alive players) and equipment value, above its players. */
function UtilityRow({ team, on }: { team: HudTeam; on: boolean }) {
  const u = utilityCounts(team);
  return (
    <div className={`vx-util-slot ${on ? "is-on" : ""}`}>
      <div className="vx-util">
        {KINDS.map(([k, icon]) => (
          <span key={k} className={`vx-util-item ${u[k] ? "" : "is-none"}`}>
            <GrenadeIcon type={k === "fire" && team.side === "CT" ? "incendiary" : icon} size={16} />
            <span className="vx-util-x">×</span>
            <span className="vx-util-n">{u[k]}</span>
          </span>
        ))}
        <span className="vx-util-eq">
          <span>EQ</span>
          {money(equipmentValue(team))}
        </span>
      </div>
    </div>
  );
}

/** One team's five players down its side of the screen. */
export function TeamColumn({ team, align, showMoney, extras }: { team: HudTeam; align: Align; showMoney: boolean; extras: boolean }) {
  const players = [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)).slice(0, 5);
  return (
    <div className={`vx-col vx-${align}`}>
      <UtilityRow team={team} on={extras} />
      {players.map((p) => (
        <PlayerCard key={p.steamId} player={p} align={align} showMoney={showMoney} />
      ))}
    </div>
  );
}
