import badgeUrl from "../assets/badge.webp";
import markUrl from "../assets/mark.webp";

/** Minimal line icons (original, 20×20 grid). Decorative only: every use is paired with text. */
const PATHS: Record<string, string> = {
  overview: "M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z",
  events: "M4 5h12v11H4zM4 8h12M7 3v4M13 3v4",
  teams: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.2-5 5-5s5 2 5 5M14 9a2.5 2.5 0 1 0 0-5M14 12c2.4 0 4 1.8 4 4.5",
  matches: "M3 4h5v12H3zM12 4h5v12h-5zM8 10h4",
  live: "M10 10m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M5.5 5.5a6.4 6.4 0 0 0 0 9M14.5 5.5a6.4 6.4 0 0 1 0 9M3 3a10 10 0 0 0 0 14M17 3a10 10 0 0 1 0 14",
  huds: "M2 4h16v11H2zM2 12h16M7 18h6M10 15v3",
  director: "M10 2l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.3l5-.7z",
  maps: "M2 5l5-2 6 2 5-2v12l-5 2-6-2-5 2zM7 3v12M13 5v12",
  replays: "M4 10a6 6 0 1 0 2-4.5M4 3v3h3M9 7l4 3-4 3z",
  playercams: "M2 6h11v8H2zM13 9l5-3v8l-5-3z",
  studio: "M3 4h14v3H3zM3 9h14v3H3zM3 14h9v3H3z",
  sponsors: "M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.6 5.1 17.2 6 11.7 2 7.8l5.5-.8z",
  demos: "M4 3h9l3 3v11H4zM13 3v3h3M7 10h6M7 13h6",
  training: "M3 15l4-4 3 3 7-7M13 7h4v4",
  devices: "M3 4h14v9H3zM7 17h6M10 13v4M14 7h1",
  settings: "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4",
  setup: "M4 4h12v12H4zM7 10l2 2 4-4",
  account: "M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5",
  stop: "M5 5h10v10H5z",
  menu: "M3 5h14M3 10h14M3 15h14",
  library: "M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z",
  players: "M10 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 18c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6",
  tournaments: "M6 3h8v4a4 4 0 0 1-8 0zM6 5H3v1a3 3 0 0 0 3 3M14 5h3v1a3 3 0 0 1-3 3M10 11v3M7 17h6M8 14h4v3H8z",
  cameras: "M2 7h3l1.5-2h7L15 7h3v9H2zM10 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  chevronLeft: "M12 4l-6 6 6 6",
  chevronRight: "M8 4l6 6-6 6",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L18 18",
  grid: "M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z",
  list: "M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1",
  more: "M3.5 10h2M9 10h2M14.5 10h2",
  reload: "M16 10a6 6 0 1 1-1.8-4.3M16 3v4h-4",
  folder: "M2 5h6l2 2h8v9H2z",
  bell: "M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13zM8.5 18h3",
  logs: "M4 3h12v14H4zM7 7h6M7 10h6M7 13h4",
  server: "M3 3h14v5H3zM3 12h14v5H3zM6 5.5h1M6 14.5h1",
  eye: "M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10zM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  eyeOff: "M3 3l14 14M8 4.3A9 9 0 0 1 10 4c5 0 8.5 6 8.5 6a15 15 0 0 1-2.6 3.2M5.6 5.6C3 7.2 1.5 10 1.5 10S5 16 10 16a8 8 0 0 0 4-1.1",
  play: "M6 4l10 6-10 6z",
  upload: "M10 13V3M6 7l4-4 4 4M3 13v4h14v-4",
  copy: "M7 7h10v10H7zM3 13V3h10v4",
  close: "M5 5l10 10M15 5L5 15",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={PATHS[name] ?? PATHS.overview} />
    </svg>
  );
}

/** Matchframe Esports mark (assets/brand). Decorative: the name is always written next to it. */
export function Logo({ size = 28 }: { size?: number }) {
  return <img className="logo" src={markUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

/** The Matchframe Esports badge (mark and name) for the sign-in and connection screens. */
export function BrandBadge({ size = 132 }: { size?: number }) {
  return <img className="brand-badge" src={badgeUrl} width={size} height={size} alt="Matchframe Esports" draggable={false} />;
}
