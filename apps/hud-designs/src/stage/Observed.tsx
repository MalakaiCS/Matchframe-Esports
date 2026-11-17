import { useEffect, useState } from "react";
import type { HudPlayer, HudState } from "@matchframe/hud-sdk";
import { PlayerCam } from "../../../hud-renderer/src/components/PlayerCam.tsx";
import { playerPicture } from "../shared/art.ts";
import { WeaponIcon } from "../shared/parts.ts";
import { Photo } from "./bits.tsx";
import { grenadeList, Nades } from "./Cards.tsx";
import { DEMO, slotKey, teamVars } from "./util.ts";

/** Demo pages show a stand-in cam, except the `nocam` scene (or `&cam=0`). */
const Q = new URLSearchParams(location.search);
const DEMO_CAM = DEMO && Q.get("demo") !== "nocam" && Q.get("cam") !== "0";

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

/** The ammunition of the weapon in hand: clip, reserve and the weapon. */
function Ammo({ p }: { p: HudPlayer }) {
  const gun = p.activeWeapon;
  if (!gun || gun.ammoClip === null) return null;
  return (
    <span className="st-obs-stats">
      <b>{gun.ammoClip}</b>
      <i className="st-obs-ammo-bar" />
      <span>{gun.ammoReserve ?? 0}</span>
      <WeaponIcon weapon={gun.name} className="st-obs-gun" />
    </span>
  );
}

/** Kills, assists and deaths in the name bar. */
function Kad({ p }: { p: HudPlayer }) {
  return (
    <span className="st-obs-kad">
      <i>K</i>
      <b>{p.kills ?? "–"}</b>
      <i>A</i>
      <b>{p.assists ?? "–"}</b>
      <i>D</i>
      <b>{p.deaths ?? "–"}</b>
    </span>
  );
}

/**
 * Bottom centre: the observed player. With their player cam on air: the cam, with the grenades at its
 * foot on the left and the ammunition on the right. Without one: the player's picture standing on a
 * transparent backdrop in its place (it covers less of the game). Under either, a name bar in the
 * team's colour with the slot number, kills, assists and deaths, and the health. Rises in once the round is
 * under way; the name slides across when the observer switches player.
 */
export function Observed({ state, color, shown }: { state: HudState; color: string; shown: boolean }) {
  const p = state.observed;
  const onAir = useCamOnAir(p?.steamId ?? null);
  const cam = !!p && (onAir || DEMO_CAM);
  const picture = p ? playerPicture(state, p) : null;
  const nades = p && p.alive !== false ? grenadeList(p) : "";
  return (
    <div className={`st-obs ${shown && p ? "is-on" : ""} ${cam ? "has-cam" : "no-cam"}`} style={teamVars(color)}>
      <div className="st-obs-cam">{p ? DEMO_CAM && !onAir ? <CamPlaceholder picture={picture} /> : <PlayerCam steamId={p.steamId} className="st-obs-feed" /> : null}</div>
      {p ? (
        <div key={p.steamId} className="st-obs-main">
          {cam ? null : <Photo url={picture} className="st-obs-stand" />}
          {nades ? (
            <span className="st-obs-nades">
              <Nades list={nades} size={18} />
            </span>
          ) : null}
          <Ammo p={p} />
          <div className="st-obs-bar">
            <span className="st-obs-slot">{slotKey(p.slot)}</span>
            <span className={`st-obs-name ${p.name.length > 10 ? "is-long" : ""}`}>{p.name}</span>
            <Kad p={p} />
            <span className={`st-obs-hp ${(p.health ?? 100) <= 20 ? "is-low" : ""}`}>{p.alive === false ? 0 : (p.health ?? "–")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
