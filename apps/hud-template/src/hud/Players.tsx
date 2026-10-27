import { memo } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { ArmorFull, ArmorHelmet, Bomb, Defuse } from "../icons.tsx";
import { alive, grenadesOf, money, setting, sideClass, weaponId } from "../util.ts";
import "../styles/players.scss";
import Weapon from "./Weapon.tsx";

export function Avatar({ url, size }: { url: string | null; size: number }) {
  if (!url) return null;
  return (
    <div className="avatar">
      <img src={url} height={size} width={size} alt="" />
    </div>
  );
}

const stat = (v: number | null) => (v === null ? "–" : v);

interface PlayerProps {
  player: HudPlayer;
  orientation: "left" | "right";
  showMoney: boolean;
}

function PlayerRow({ player, orientation, showMoney }: PlayerProps) {
  const isAlive = alive(player);
  const main = player.primary ?? player.secondary;
  const zeus = player.activeWeapon && weaponId(player.activeWeapon.name) === "taser" ? player.activeWeapon : null;
  const health = player.health ?? 0;
  const isLeft = orientation === "left";
  // The observer slot is the spectator key (1–9, 0) that switches to this player.
  const slot = player.slot === null ? null : <span>{player.slot}</span>;
  return (
    <div className={`player ${isAlive ? "" : "dead"} ${player.observed ? "active" : ""}`} data-steamid={player.steamId}>
      <div className="player_data">
        <Avatar url={player.avatarUrl} size={57} />
        <div className="dead-stats">
          <div className="labels">
            <div className="stat-label">K</div>
            <div className="stat-label">A</div>
            <div className="stat-label">D</div>
          </div>
          <div className="values">
            <div className="stat-value">{stat(player.kills)}</div>
            <div className="stat-value">{stat(player.assists)}</div>
            <div className="stat-value">{stat(player.deaths)}</div>
          </div>
        </div>
        <div className="player_stats">
          <div className="row">
            <div className="health">{isAlive ? health : ""}</div>
            <div className="username">
              <div>
                {isLeft ? slot : null} {player.name} {!isLeft ? slot : null}
              </div>
              {main ? <Weapon weapon={main.name} active={main.active} /> : null}
              {player.roundKills ? <div className="roundkills-container">{player.roundKills}</div> : null}
            </div>
          </div>
          <div className={`hp_bar ${health <= 20 ? "low" : ""}`} style={{ width: `${isAlive ? Math.max(0, Math.min(100, health)) : 0}%` }} />
          <div className="row">
            <div className="armor_and_utility">
              {player.hasBomb ? (
                <div className="armor_indicator">
                  <Bomb />
                </div>
              ) : null}
              {isAlive && (player.armor ?? 0) > 0 ? <div className="armor_indicator">{player.helmet ? <ArmorHelmet /> : <ArmorFull />}</div> : null}
              {isAlive && player.defuseKit ? (
                <div className="defuse_indicator">
                  <Defuse />
                </div>
              ) : null}
            </div>
            <div className="money">{showMoney ? money(player.money) : ""}</div>
            {zeus ? <Weapon className={`zeus ${orientation}`} weapon="taser" active /> : null}
            <div className="grenades">
              {grenadesOf(player).map((g, i) => (
                <Weapon key={`${g.name}-${i}`} weapon={g.name} active={g.active} isGrenade />
              ))}
            </div>
            <div className="secondary_weapon">{player.primary && player.secondary ? <Weapon weapon={player.secondary.name} active={player.secondary.active} /> : null}</div>
          </div>
          <div className="active_border" />
        </div>
      </div>
    </div>
  );
}

const Player = memo(PlayerRow, (a, b) => a.orientation === b.orientation && a.showMoney === b.showMoney && JSON.stringify(a.player) === JSON.stringify(b.player));

/** One team's five players down the side of the screen. */
export function TeamBox({ state, team, orientation }: { state: HudState; team: HudTeam; orientation: "left" | "right" }) {
  const showMoney = setting(state, "showMoney", true);
  return (
    <div className={`teambox ${sideClass(team.side)} ${orientation}`}>
      {[...team.players]
        .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
        .slice(0, 5)
        .map((p) => (
          <Player key={p.steamId} player={p} orientation={orientation} showMoney={showMoney} />
        ))}
    </div>
  );
}

/** "Players alive" counter (top right, under the killfeed). */
export function PlayersAlive({ state }: { state: HudState }) {
  const count = (t: HudTeam) => t.players.filter(alive).length;
  return (
    <div className="players_alive">
      <div className="title_container">Players alive</div>
      <div className="counter_container">
        <div className={`team_counter ${sideClass(state.left.side)}`}>{count(state.left)}</div>
        <div className="vs_counter">VS</div>
        <div className={`team_counter ${sideClass(state.right.side)}`}>{count(state.right)}</div>
      </div>
    </div>
  );
}
