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
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={PATHS[name] ?? PATHS.overview} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg className="logo" width="28" height="28" viewBox="0 0 28 28" aria-hidden focusable="false">
      <rect x="1" y="1" width="26" height="26" rx="6" fill="var(--accent)" />
      <path d="M7 19V9l4 5 3-4 3 4 4-5v10" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
