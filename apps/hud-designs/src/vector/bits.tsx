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

/** The team's logo (or tag) enlarged and faint behind a team-colour panel. */
export function Watermark({ team }: { team: HudTeam }) {
  return <span className="vx-mark">{team.logoUrl ? <img src={team.logoUrl} alt="" /> : <span>{(team.shortName || team.name).slice(0, 3)}</span>}</span>;
}

/** Stand-in for a missing player photo: a neutral head-and-shoulders silhouette. */
function Silhouette({ fill }: { fill: boolean }) {
  return (
    <svg className="vx-sil" viewBox="0 0 84 80" preserveAspectRatio={fill ? "xMidYMax slice" : "xMidYMax meet"} aria-hidden="true">
      <ellipse cx="42" cy="31" rx="14.5" ry="17" />
      <path d="M8 80c1.5-14.5 10-22.5 22-25.5 3.5 3.5 7.5 5.2 12 5.2s8.5-1.7 12-5.2c12 3 20.5 11 22 25.5z" />
    </svg>
  );
}

/** The player's photo, else a neutral silhouette (`fill`: scaled to the slot's height). */
export function Avatar({ player, fill = false, className = "" }: { player: Pick<HudPlayer, "avatarUrl" | "name">; fill?: boolean; className?: string }) {
  return <span className={`vx-ava ${className}`}>{player.avatarUrl ? <img src={player.avatarUrl} alt="" /> : <Silhouette fill={fill} />}</span>;
}

/** Fraction 0..1 of a health value (transform scaleX on bars). */
export const healthFraction = (value: number): number => Math.max(0, Math.min(100, value)) / 100;
