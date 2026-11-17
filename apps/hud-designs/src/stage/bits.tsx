import type { HudTeam } from "@matchframe/hud-sdk";

/** The team's logo, else its tag as a wordmark in the team colour. */
export function TeamLogo({ team, className = "" }: { team: HudTeam; className?: string }) {
  if (team.logoUrl) {
    return (
      <span className={`st-logo has-img ${className}`}>
        <img src={team.logoUrl} alt="" />
      </span>
    );
  }
  const mark = (team.shortName || team.name).slice(0, 4).toUpperCase();
  return (
    <span className={`st-logo ${className}`} data-len={Math.min(4, mark.length)}>
      {mark}
    </span>
  );
}

/** A neutral head-and-shoulders figure for players without a picture (MatchFrame's own drawing). */
function Figure() {
  return (
    <svg className="st-figure" viewBox="0 0 64 72" preserveAspectRatio="xMidYMax meet" aria-hidden>
      <path d="M4 72c1-13 8-19 18-21l5-2h10l5 2c10 2 17 8 18 21z" fill="#58647a" />
      <path d="M26 40h12v9c-3 3-9 3-12 0z" fill="#46516a" />
      <ellipse cx="32" cy="27" rx="11" ry="13.5" fill="#7a869c" />
    </svg>
  );
}

/** A player's picture filling its slot (bottom-aligned), or the neutral figure. */
export function Photo({ url, className = "" }: { url: string | null; className?: string }) {
  return <span className={`st-photo ${className}`}>{url ? <img src={url} alt="" /> : <Figure />}</span>;
}

/** Kills: a small four-tick sight (MatchFrame's own mark). */
export function KillsMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="mf-icon st-mark" width={size} height={size} viewBox="0 0 16 16" aria-label="kills">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 0v4.5M8 11.5V16M0 8h4.5M11.5 8H16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** A round kill: a small outlined diamond on the card's top edge (MatchFrame's own mark). */
export function RoundKill() {
  return (
    <svg className="st-rk" viewBox="0 0 14 14" aria-hidden>
      <path d="M7 0.8L13.2 7 7 13.2 0.8 7z" fill="currentColor" stroke="#0a0f18" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Timeouts remaining as pips: filled for each left, outlined for each used (CS2 gives three). */
export function TimeoutPips({ left, className = "" }: { left: number | null; className?: string }) {
  if (left === null) return <span className={`st-pips ${className}`}>–</span>;
  const total = Math.max(3, left);
  return (
    <span className={`st-pips ${className}`} aria-label={`${left} timeouts left`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < left ? "is-left" : ""} />
      ))}
    </span>
  );
}
