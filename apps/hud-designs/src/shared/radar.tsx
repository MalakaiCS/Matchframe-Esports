import type { HudRadar } from "@matchframe/hud-sdk";
import { Radar } from "./parts.ts";
import "./radar.css";

/**
 * The minimap both HUDs share: Matchframe's clean radar (navy floor, light walls, red bomb sites)
 * when the engine has one for the map, else the radar image or outline; markers use the same u/v
 * frame either way. No panel behind it; each HUD only places and sizes `.mf-map-radar`.
 */
export function MapRadar({ radar, className = "" }: { radar: HudRadar; className?: string }) {
  if (!radar.available) return null;
  const clean = radar.cleanUrl && radar.mode !== "none" ? radar.cleanUrl : null;
  return (
    <div className={`mf-map-radar ${clean ? "is-clean" : ""} ${className}`}>
      <Radar radar={clean ? { ...radar, mode: "image", backgroundUrl: clean } : radar} />
    </div>
  );
}
