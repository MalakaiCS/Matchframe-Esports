import { memo } from "react";
import type { HudPlayer, HudTeam } from "@matchframe/hud-sdk";
import { mainWeapon, money, utilityCounts } from "../shared/format.ts";
import { ArmorIcon, BombIcon, GrenadeIcon, HeadshotIcon, KitIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { Avatar, healthFraction, sizeClass } from "./bits.tsx";
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

/**
 * A player: photo on the outer side, a team-colour band with name and health whose length is the
 * health (with a lighter damage trail), K/D, money, kills this round, weapon and equipment. A dead
 * player's card narrows to name, K/D and money.
 */
function Card({ player: p, align, showMoney }: CardProps) {
  const alive = p.alive !== false;
  const hp = alive ? Math.max(0, Math.min(100, p.health ?? 0)) : 0;
  const f = healthFraction(hp);
  const weapon = mainWeapon(p);
  const held = !!p.activeWeapon && !!weapon && p.activeWeapon.name === weapon;
  return (
    <div className={`vx-card vx-${align} ${alive ? "" : "is-dead"} ${p.observed ? "is-observed" : ""}`} data-steamid={p.steamId}>
      <i className="vx-card-dead" />
      <span className="vx-card-band">
        <i className="vx-band-trail" style={{ transform: `scaleX(${f})` }} />
        <i className="vx-band-fill" style={{ transform: `scaleX(${f})` }} />
      </span>
      <span className="vx-card-photo">
        <Avatar player={p} />
      </span>
      <span className={`vx-card-name ${sizeClass(p.name.length, 10, 13, 16)}`}>{p.name}</span>
      <span className="vx-card-hp vx-alive-only">
        {(p.armor ?? 0) > 0 ? <ArmorIcon helmet={!!p.helmet} size={14} /> : null}
        {hp}
      </span>
      <span className="vx-card-kd">
        <HeadshotIcon size={12} />
        <b>{stat(p.kills)}</b>
        <SkullIcon size={13} />
        <b>{stat(p.deaths)}</b>
      </span>
      <span className="vx-card-low">
        {showMoney ? <span className="vx-money">{money(p.money).replace(",", "")}</span> : null}
        {p.roundKills ? <span className="vx-card-rk">{p.roundKills}</span> : null}
      </span>
      <span className={`vx-card-gun vx-alive-only ${held ? "is-held" : ""}`}>{weapon ? <WeaponIcon weapon={weapon} /> : null}</span>
      <span className="vx-card-kit vx-alive-only">
        {p.defuseKit ? <KitIcon size={14} className="vx-is-kit" /> : null}
        {p.hasBomb ? <BombIcon size={15} className="vx-is-bomb" /> : null}
        {grenades(p).map((g, i) => (
          <GrenadeIcon key={`${g}-${i}`} type={g} size={14} />
        ))}
      </span>
    </div>
  );
}

/** What a card shows: it re-renders only when one of these changes. */
const shown = (p: HudPlayer): string =>
  [p.name, p.alive, p.health, p.armor, p.helmet, p.defuseKit, p.hasBomb, p.money, p.kills, p.deaths, p.roundKills, p.observed, p.avatarUrl, p.primary?.name, p.secondary?.name, p.activeWeapon?.name, p.grenades.map((g) => `${g.name}${g.ammoReserve ?? ""}`).join()].join("|");

const PlayerCard = memo(Card, (a, b) => a.align === b.align && a.showMoney === b.showMoney && shown(a.player) === shown(b.player));

const KINDS = [
  ["smoke", "smoke"],
  ["flash", "flashbang"],
  ["he", "he"],
  ["fire", "molotov"],
] as const;

/** Freeze time: the team's grenades (alive players), above its players. */
function UtilityRow({ team, on }: { team: HudTeam; on: boolean }) {
  const u = utilityCounts(team);
  return (
    <div className={`vx-util-slot ${on ? "is-on" : ""}`}>
      <div className="vx-util">
        {KINDS.map(([k, icon]) => (
          <span key={k} className={`vx-util-item ${u[k] ? "" : "is-none"}`}>
            <GrenadeIcon type={k === "fire" && team.side === "CT" ? "incendiary" : icon} size={20} />
            <span className="vx-util-n">x{u[k]}</span>
          </span>
        ))}
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
