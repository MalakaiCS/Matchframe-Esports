import type { CSSProperties } from "react";
import type { HudPlayer, HudState } from "@matchframe/hud-sdk";
import { playerPicture } from "../shared/art.ts";
import { ArmorIcon } from "../shared/parts.ts";
import { Avatar, healthFraction, teamOf, useOutgoing } from "./bits.tsx";

interface Shown {
  player: HudPlayer;
  color: string;
  picture: string | null;
}

function Content({ s, leaving }: { s: Shown; leaving: boolean }) {
  const p = s.player;
  const hp = p.alive === false ? 0 : Math.max(0, Math.min(100, p.health ?? 0));
  const f = healthFraction(hp);
  const w = p.activeWeapon;
  const ammo = !!w && w.ammoClip !== null && w.kind !== "knife" && w.kind !== "grenade" && w.kind !== "bomb";
  return (
    <div className={`vx-obs-content ${leaving ? "is-out" : ""}`} style={{ "--team": s.color } as CSSProperties}>
      <span className="vx-obs-photo">
        <Avatar player={{ name: p.name, avatarUrl: s.picture }} fill />
      </span>
      <span className="vx-obs-hp">
        {hp}
        <ArmorIcon helmet={!!p.helmet} size={15} className={(p.armor ?? 0) > 0 ? "" : "is-none"} />
      </span>
      {ammo ? (
        <span className="vx-obs-ammo">
          <b>{w.ammoClip}</b>/{w.ammoReserve ?? 0}
        </span>
      ) : null}
      <span className="vx-obs-bar">
        <i className="vx-band-trail" style={{ transform: `scaleX(${f})` }} />
        <i className="vx-band-fill" style={{ transform: `scaleX(${f})` }} />
        <span className="vx-obs-name">{p.name}</span>
      </span>
    </div>
  );
}

/**
 * The observed player (bottom centre): photo above the box, health and ammunition, the name on a
 * team-colour health bar. When the observer switches, the old player sinks away and the new one
 * rises in; the box stays.
 */
export function Observed({ state, color }: { state: HudState; color: { left: string; right: string } }) {
  const p = state.observed;
  const side = p ? teamOf(state, p.steamId) : null;
  const shown: Shown | null = p && side ? { player: p, color: color[side], picture: playerPicture(state, p) } : null;
  const out = useOutgoing(p?.steamId ?? "", shown, 130);
  return (
    <div className={`vx-obs ${shown ? "is-on" : ""}`} style={shown ? ({ "--team": shown.color } as CSSProperties) : undefined}>
      <div className="vx-obs-box" />
      {out?.value ? <Content key={`out-${out.key}`} s={out.value} leaving /> : null}
      {shown ? <Content key={shown.player.steamId} s={shown} leaving={false} /> : null}
    </div>
  );
}
