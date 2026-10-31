import type { HudRadar } from "@matchframe/hud-sdk";
import { Radar } from "./parts.ts";
import "./radar.css";

/**
 * The minimap both HUDs share: the map's radar image (the bundled radars, or an operator-calibrated
 * one), and for a map without one (Anubis, Cache) Matchframe's radar drawn in the same style in place
 * of the outline; markers use the same u/v frame either way. No panel behind it; each HUD only
 * places and sizes `.mf-map-radar`.
 */
export function MapRadar({ radar, className = "" }: { radar: HudRadar; className?: string }) {
  if (!radar.available) return null;
  const clean = radar.mode === "schematic" && radar.cleanUrl ? radar.cleanUrl : null;
  return (
    <div className={`mf-map-radar ${clean ? "is-clean" : ""} ${className}`}>
      <Radar radar={clean ? { ...radar, mode: "image", backgroundUrl: clean } : radar} />
    </div>
  );
}
