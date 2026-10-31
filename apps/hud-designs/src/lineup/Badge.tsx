import type { HudTeam } from "@matchframe/hud-sdk";

/** The team's logo, or its short name as a wordmark in the team colour when it has none. */
export function TeamLogo({ team, className = "" }: { team: HudTeam; className?: string }) {
  if (team.logoUrl) {
    return (
      <span className={`lu-logo has-img ${className}`}>
        <img src={team.logoUrl} alt="" />
      </span>
    );
  }
  const mark = (team.shortName || team.name).slice(0, 5).toUpperCase();
  return (
    <span className={`lu-logo ${className}`} data-len={Math.min(5, mark.length)}>
      {mark}
    </span>
  );
}

/** A neutral head-and-shoulders silhouette for players without a photo (Matchframe's own drawing). */
function Silhouette() {
  return (
    <svg className="lu-silhouette" viewBox="0 0 100 112" preserveAspectRatio="xMinYMax meet" aria-hidden>
      <defs>
        <linearGradient id="lu-sil-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#cfd4db" />
          <stop offset="1" stopColor="#a3abb6" />
        </linearGradient>
        <linearGradient id="lu-sil-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9dde3" />
          <stop offset="0.6" stopColor="#b4bbc5" />
          <stop offset="1" stopColor="#7f8894" />
        </linearGradient>
      </defs>
      <path d="M-10 112V76c0-12 15-19 36-21l12-4h16l12 4c21 2 36 9 36 21v36z" fill="url(#lu-sil-body)" />
      <path d="M37 42h18v12c-5 5-13 5-18 0z" fill="#959eaa" />
      <path d="M46 4c12 0 20 8 20 22 0 15-9 27-20 27S26 41 26 26C26 12 34 4 46 4z" fill="url(#lu-sil-head)" />
    </svg>
  );
}

/** A player's photo standing on the card (a cut-out look), or the silhouette when there is none. */
export function Portrait({ avatarUrl, className = "" }: { avatarUrl: string | null; className?: string }) {
  return <span className={`lu-portrait ${className}`}>{avatarUrl ? <img src={avatarUrl} alt="" /> : <Silhouette />}</span>;
}
