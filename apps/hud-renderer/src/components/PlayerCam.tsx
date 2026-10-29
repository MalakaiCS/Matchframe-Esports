import { useEffect, useRef, useState } from "react";

interface MatchframeCams {
  canvas(steamId: string): HTMLCanvasElement;
  onAir(steamId: string): boolean;
  on(ev: "change" | "observed", fn: () => void): void;
  off(ev: "change" | "observed", fn: () => void): void;
}
declare global {
  interface Window {
    MatchframeCams?: MatchframeCams;
  }
}

/**
 * A player's cam (player cams, ADR-048), drawn by the HUD server's cams.js (already delayed to match
 * the game); nothing while the player has no cam on air.
 */
export function PlayerCam({ steamId, className }: { steamId: string; className?: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [onAir, setOnAir] = useState(false);
  useEffect(() => {
    const mc = window.MatchframeCams;
    if (!mc) return;
    const update = () => setOnAir(mc.onAir(steamId));
    mc.on("change", update);
    update();
    const canvas = mc.canvas(steamId);
    holder.current?.appendChild(canvas);
    return () => {
      mc.off("change", update);
      canvas.remove();
    };
  }, [steamId]);
  return <div ref={holder} className={`mf-cam ${onAir ? "is-on" : ""} ${className ?? ""}`} aria-hidden="true" />;
}
