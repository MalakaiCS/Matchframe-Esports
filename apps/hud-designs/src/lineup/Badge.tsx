import type { HudTeam } from "@matchframe/hud-sdk";
import { initials } from "./util.ts";

/** The team's logo, or a monogram badge from its short name when it has none. */
export function TeamBadge({ team, className = "" }: { team: HudTeam; className?: string }) {
  if (team.logoUrl) {
    return (
      <span className={`lu-badge has-logo ${className}`}>
        <img src={team.logoUrl} alt="" />
      </span>
    );
  }
  const mono = (team.shortName || team.name).slice(0, 3).toUpperCase();
  return (
    <span className={`lu-badge ${className}`} data-len={mono.length}>
      <span className="lu-badge-wash" aria-hidden />
      <span className="lu-badge-text">{mono}</span>
    </span>
  );
}

/** A player's portrait in its rounded frame: the avatar, else their initials on a team-tinted tile. */
export function Portrait({ name, avatarUrl, className = "" }: { name: string; avatarUrl: string | null; className?: string }) {
  return (
    <span className={`lu-portrait ${className}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" />
      ) : (
        <>
          <span className="lu-portrait-wash" aria-hidden />
          <span className="lu-portrait-text">{initials(name)}</span>
        </>
      )}
      <span className="lu-portrait-grey" aria-hidden />
      <span className="lu-portrait-dim" aria-hidden />
    </span>
  );
}
