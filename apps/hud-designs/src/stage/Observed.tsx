import { useEffect, useState } from "react";
import type { HudPlayer, HudState } from "@matchframe/hud-sdk";
import { PlayerCam } from "../../../hud-renderer/src/components/PlayerCam.tsx";
import { playerPicture } from "../shared/art.ts";
import { WeaponIcon } from "../shared/parts.ts";
import { KillsMark, Photo } from "./bits.tsx";
import { DEMO, slotKey, teamVars } from "./util.ts";

/** Demo pages show a stand-in cam (`&cam=0` shows the panel without one). */
const DEMO_CAM = DEMO && new URLSearchParams(location.search).get("cam") !== "0";

/** Whether the player's cam is on air (player cams, `/hud-runtime/cams.js`); false without the script. */
function useCamOnAir(steamId: string | null): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mc = window.MatchFrameCams;
    if (!mc || !steamId) {
      setOn(false);
      return;
    }
    const update = () => setOn(mc.onAir(steamId));
    mc.on("change", update);
    update();
    return () => mc.off("change", update);
  }, [steamId]);
  return on;
}

/** The demo's stand-in for a player cam: the player's picture on a dark studio backdrop. */
function CamPlaceholder({ picture }: { picture: string | null }) {
  return (
    <span className="st-obs-placeholder">
      <Photo url={picture} className="st-obs-placeholder-pic" />
      <span className="st-obs-placeholder-tag">PLAYER CAM</span>
    </span>
  );
}

function Stats({ p }: { p: HudPlayer }) {
  const gun = p.activeWeapon;
  const ammo = gun && gun.ammoClip !== null ? `${gun.ammoClip}/${gun.ammoReserve ?? 0}` : null;
  return (
    <span className="st-obs-stats">
      <span className="st-obs-stat">
        <i>K</i>
        <b>{p.kills ?? "–"}</b>
      </span>
      <span className="st-obs-stat">
        <i>A</i>
        <b>{p.assists ?? "–"}</b>
      </span>
      <span className="st-obs-stat">
        <i>D</i>
        <b>{p.deaths ?? "–"}</b>
      </span>
      {p.roundKills ? (
        <span className="st-obs-stat is-round">
          <KillsMark size={12} />
          <b>{p.roundKills}</b>
        </span>
      ) : null}
      {ammo ? (
        <span className="st-obs-stat is-ammo">
          <WeaponIcon weapon={gun!.name} className="st-obs-gun" />
          <b>{ammo}</b>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Bottom centre: the observed player's cam (when it is on air), their kills, assists, deaths,
 * round kills and ammunition, and a name bar with the slot number and the health. Rises in once
 * the round is under way; the name slides across when the observer switches player.
 */
export function Observed({ state, color, shown }: { state: HudState; color: string; shown: boolean }) {
  const p = state.observed;
  const onAir = useCamOnAir(p?.steamId ?? null);
  const cam = !!p && (onAir || DEMO_CAM);
  return (
    <div className={`st-obs ${shown && p ? "is-on" : ""} ${cam ? "has-cam" : ""}`} style={teamVars(color)}>
      <div className="st-obs-cam">{p ? DEMO_CAM && !onAir ? <CamPlaceholder picture={playerPicture(state, p)} /> : <PlayerCam steamId={p.steamId} className="st-obs-feed" /> : null}</div>
      {p ? (
        <div key={p.steamId} className="st-obs-main">
          <Stats p={p} />
          <div className="st-obs-bar">
            <span className="st-obs-slot">{slotKey(p.slot)}</span>
            <span className={`st-obs-name ${p.name.length > 14 ? "is-long" : ""}`}>{p.name}</span>
            <span className={`st-obs-hp ${(p.health ?? 100) <= 20 ? "is-low" : ""}`}>{p.alive === false ? 0 : (p.health ?? "–")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
