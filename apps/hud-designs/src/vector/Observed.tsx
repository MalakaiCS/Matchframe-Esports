import type { CSSProperties } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { ArmorIcon, BombIcon, GrenadeIcon, KitIcon, WeaponIcon } from "../shared/parts.ts";
import { Avatar, HealthBar, teamOf, useOutgoing } from "./bits.tsx";

interface Shown {
  player: HudPlayer;
  team: HudTeam;
  color: string;
}

const stat = (v: number | null) => (v === null ? "–" : v);

function Content({ s, leaving }: { s: Shown; leaving: boolean }) {
  const p = s.player;
  const hp = p.alive === false ? 0 : Math.max(0, Math.min(100, p.health ?? 0));
  const w = p.activeWeapon;
  const ammo = !!w && w.ammoClip !== null && w.kind !== "knife" && w.kind !== "grenade" && w.kind !== "bomb";
  return (
    <div className={`vx-obs-content ${leaving ? "is-out" : ""}`} style={{ "--team": s.color } as CSSProperties}>
      <span className="vx-obs-ava">
        <Avatar player={p} />
      </span>
      <div className="vx-obs-main">
        <div className={`vx-obs-hp ${hp > 0 && hp <= 20 ? "is-low" : ""}`}>
          <span className="vx-obs-hp-n">{hp}</span>
          <span className="vx-obs-hp-l">HP</span>
        </div>
        <div className="vx-obs-mid">
          <div className="vx-obs-name">
            <span className="vx-obs-tag">{s.team.shortName}</span>
            <span className="vx-obs-nick">{p.name}</span>
          </div>
          <HealthBar value={hp} className="vx-obs-bar" />
        </div>
        <div className="vx-obs-ammo">
          <span className="vx-obs-gun">{w ? <WeaponIcon weapon={w.name} /> : null}</span>
          {ammo ? (
            <span className="vx-obs-clip">
              <b>{w.ammoClip}</b>
              <i>/{w.ammoReserve ?? 0}</i>
            </span>
          ) : null}
        </div>
      </div>
      <div className="vx-obs-stats">
        <span className="vx-obs-kad">
          <i>K</i>
          <b>{stat(p.kills)}</b>
          <i>A</i>
          <b>{stat(p.assists)}</b>
          <i>D</i>
          <b>{stat(p.deaths)}</b>
          {p.adr !== null ? (
            <>
              <i>ADR</i>
              <b>{Math.round(p.adr)}</b>
            </>
          ) : null}
        </span>
        <span className="vx-obs-kit">
          {p.grenades.map((g, i) => (
            <GrenadeIcon key={`${g.name}-${i}`} type={g.name} size={15} className={g.active ? "is-held" : ""} />
          ))}
          {p.hasBomb ? <BombIcon size={16} className="vx-is-bomb" /> : null}
          {p.defuseKit ? <KitIcon size={15} className="vx-is-kit" /> : null}
          <span className="vx-obs-armor">
            <ArmorIcon helmet={!!p.helmet} size={14} />
            {p.armor ?? 0}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * The observed player (bottom centre). When the observer switches, the old player's content sinks
 * away and the new one rises in; the panel and its team-colour glow stay.
 */
export function Observed({ state, color }: { state: HudState; color: { left: string; right: string } }) {
  const p = state.observed;
  const side = p ? teamOf(state, p.steamId) : null;
  const shown: Shown | null = p && side ? { player: p, team: state[side], color: color[side] } : null;
  const out = useOutgoing(p?.steamId ?? "", shown, 130);
  return (
    <div className={`vx-obs ${shown ? "is-on" : ""}`} style={shown ? ({ "--team": shown.color } as CSSProperties) : undefined}>
      <div className="vx-obs-frame">
        <i className="vx-obs-glow" />
      </div>
      {out?.value ? <Content key={`out-${out.key}`} s={out.value} leaving /> : null}
      {shown ? <Content key={shown.player.steamId} s={shown} leaving={false} /> : null}
    </div>
  );
}
