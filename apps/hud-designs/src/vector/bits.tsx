import { useEffect, useState } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { usePrevious } from "../shared/useHud.ts";

/** The manifest's element switches, with its defaults (the compact variant drops the radar and freeze-time extras). */
export interface VectorOptions {
  showRadar: boolean;
  showKillfeed: boolean;
  showObserved: boolean;
  showAlive: boolean;
  showMoney: boolean;
  showFreezeExtras: boolean;
  shortNames: boolean;
}

export function readOptions(settings: Record<string, unknown>, variant: string): VectorOptions {
  const on = (key: keyof VectorOptions) => (typeof settings[key] === "boolean" ? (settings[key] as boolean) : true);
  const compact = variant === "compact";
  return {
    showRadar: on("showRadar") && !compact,
    showKillfeed: on("showKillfeed"),
    showObserved: on("showObserved"),
    showAlive: on("showAlive"),
    showMoney: on("showMoney"),
    showFreezeExtras: on("showFreezeExtras") && !compact,
    shortNames: settings.teamNames === "short",
  };
}

export type Align = "left" | "right";

/** Which of the two teams a player belongs to. */
export const teamOf = (state: HudState, steamId: string): Align => (state.right.players.some((p) => p.steamId === steamId) ? "right" : "left");

/** A smaller type step for longer names (CSS classes is-long, is-longer, is-longest). */
export const sizeClass = (length: number, long: number, longer: number, longest: number): string => (length > longest ? "is-longest" : length > longer ? "is-longer" : length > long ? "is-long" : "");

export const initial = (name: string): string => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toUpperCase();

/**
 * The value that was just replaced, for `ms` after `key` changes (null otherwise): lets the old
 * digit or observed player animate out while the new one animates in.
 */
export function useOutgoing<T>(key: string, value: T, ms: number): { key: string; value: T } | null {
  const prevKey = usePrevious(key);
  const prevValue = usePrevious(value);
  const [out, setOut] = useState<{ key: string; value: T } | null>(null);
  if (prevKey !== undefined && prevKey !== key && out?.key !== prevKey) setOut({ key: prevKey, value: prevValue as T });
  useEffect(() => {
    if (!out) return;
    const t = setTimeout(() => setOut(null), ms);
    return () => clearTimeout(t);
  }, [out, ms]);
  return out;
}

/** A number that flips vertically when it changes (scores, players alive). */
export function Flip({ value, className = "" }: { value: number | string; className?: string }) {
  const out = useOutgoing(String(value), value, 170);
  return (
    <span className={`vx-flip ${className}`}>
      {out ? (
        <span key={`o${out.key}`} className="vx-flip-out">
          {out.value}
        </span>
      ) : null}
      <span key={`v${value}`} className={out ? "vx-flip-in" : ""}>
        {value}
      </span>
    </span>
  );
}

/** The team's logo, else a monogram badge from its short name. */
export function TeamBadge({ team, className = "" }: { team: HudTeam; className?: string }) {
  return (
    <span className={`vx-badge ${team.logoUrl ? "has-logo" : ""} ${className}`}>
      {team.logoUrl ? <img src={team.logoUrl} alt="" /> : <span className="vx-badge-mono">{(team.shortName || team.name).slice(0, 4)}</span>}
    </span>
  );
}

/** The player's picture, else their initial on a dark tile. */
export function Avatar({ player, className = "" }: { player: Pick<HudPlayer, "avatarUrl" | "name">; className?: string }) {
  return <span className={`vx-ava ${className}`}>{player.avatarUrl ? <img src={player.avatarUrl} alt="" /> : <span className="vx-ava-mono">{initial(player.name)}</span>}</span>;
}

/** Health with a lighter damage trail that follows after a short delay (CSS transitions on scaleX). */
export function HealthBar({ value, className = "" }: { value: number; className?: string }) {
  const f = Math.max(0, Math.min(100, value)) / 100;
  return (
    <span className={`vx-hp ${value > 0 && value <= 20 ? "is-low" : ""} ${className}`}>
      <i className="vx-hp-trail" style={{ transform: `scaleX(${f})` }} />
      <i className="vx-hp-fill" style={{ transform: `scaleX(${f})` }} />
    </span>
  );
}
