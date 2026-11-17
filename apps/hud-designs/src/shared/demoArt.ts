import type { HudArt, HudRadar } from "@matchframe/hud-sdk";

/**
 * Original sample pictures for the demo (`?art=1`, `?radar=1`): plain inline SVG drawings standing in
 * for the operator's HUD images (player figures tinted by side, map tiles, a dead mark) and for
 * MatchFrame's clean radar (a made-up layout, not a real map).
 */

const uri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const SKIN = ["#efcfb6", "#d9a982", "#bf8a63", "#8e5d3e", "#e6bd9c"];
const HAIR = ["#2b1d14", "#6b4a2b", "#14110f", "#a8743a", "#3a2a20"];

/** Darker or lighter shade of a #rrggbb colour (`f` < 1 darkens, > 1 lightens towards white). */
function shade(hex: string, f: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = c.map((v) => Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)));
  return `#${out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A generic head-and-shoulders portrait in the side's jersey (a drawing, no real person): shaded
 * face with simple features, ears, neck shadow, hair, a collared jersey; `n` varies skin, hair and cut.
 */
function figure(side: "ct" | "t", n: number): string {
  const jersey: [string, string] = side === "ct" ? ["#173f8c", "#2a64c8"] : ["#8e1f2e", "#cf3a4c"];
  const trim = side === "ct" ? "#d7e6ff" : "#ffe1e5";
  const skin = SKIN[n % SKIN.length]!;
  const hair = HAIR[n % HAIR.length]!;
  const dark = shade(skin, 0.78);
  const cuts = [
    `<path d="M40 44c-1-19 9-28 20-28s21 9 20 28c-3-8-8-13-20-13s-17 5-20 13z" fill="url(#h)"/>`,
    `<path d="M39 46c-2-21 8-31 22-31 13 0 21 9 21 24-6-5-12-11-16-15-5 9-14 15-27 22z" fill="url(#h)"/>`,
    `<path d="M41 39c2-14 9-21 19-21s17 7 19 21c-5-5-11-7-19-7s-14 2-19 7z" fill="url(#h)" opacity="0.9"/>`,
    `<path d="M38 45c-3-13 2-29 22-29s25 16 22 29c-2-6-4-10-6-12-4 3-9 5-16 5s-12-2-16-5c-2 2-4 6-6 12z" fill="url(#h)"/>`,
    `<path d="M37 40c0-17 10-26 23-26s23 9 23 26v3H37z" fill="${jersey[0]}"/><rect x="37" y="37" width="46" height="6" rx="3" fill="${trim}"/>`,
  ];
  return uri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140">` +
      `<defs>` +
      `<linearGradient id="j" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${jersey[1]}"/><stop offset="1" stop-color="${jersey[0]}"/></linearGradient>` +
      `<radialGradient id="f" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="${shade(skin, 1.08)}"/><stop offset="0.7" stop-color="${skin}"/><stop offset="1" stop-color="${dark}"/></radialGradient>` +
      `<linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(hair, 1.25)}"/><stop offset="1" stop-color="${hair}"/></linearGradient>` +
      `</defs>` +
      `<path d="M0 140c0-31 13-45 35-51l15-5h20l15 5c22 6 35 20 35 51z" fill="url(#j)"/>` +
      `<path d="M14 140c2-20 8-31 18-37M106 140c-2-20-8-31-18-37" stroke="${shade(jersey[0], 0.75)}" stroke-width="5" fill="none"/>` +
      `<path d="M49 66h22v17c-6 7-16 7-22 0z" fill="${dark}"/>` +
      `<path d="M46 84l14 17 14-17" fill="none" stroke="${trim}" stroke-width="5"/>` +
      `<ellipse cx="41" cy="50" rx="4" ry="6" fill="${dark}"/><ellipse cx="79" cy="50" rx="4" ry="6" fill="${dark}"/>` +
      `<ellipse cx="60" cy="47" rx="19" ry="24" fill="url(#f)"/>` +
      `<path d="M49 42q4-2 8 0M63 42q4-2 8 0" stroke="${shade(hair, 0.9)}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
      `<ellipse cx="53" cy="48" rx="2.2" ry="1.6" fill="#2a2420"/><ellipse cx="67" cy="48" rx="2.2" ry="1.6" fill="#2a2420"/>` +
      `<path d="M60 49v8l-3 2" stroke="${dark}" stroke-width="1.8" fill="none" stroke-linecap="round"/>` +
      `<path d="M54 63q6 3 12 0" stroke="${shade(skin, 0.6)}" stroke-width="2" fill="none" stroke-linecap="round"/>` +
      cuts[n % cuts.length] +
      `</svg>`,
  );
}

const MAPS: Record<string, [string, string, string]> = {
  de_inferno: ["Inferno", "#7a3b1d", "#d98a3a"],
  de_mirage: ["Mirage", "#6b4f2a", "#d8b46a"],
  de_nuke: ["Nuke", "#1d4a5a", "#6fb3c4"],
  de_ancient: ["Ancient", "#244a32", "#7fb07a"],
  de_overpass: ["Overpass", "#34404f", "#93a9bf"],
  de_anubis: ["Anubis", "#5a4a22", "#d6c06a"],
  de_dust2: ["Dust II", "#6e5532", "#e0c28a"],
};

/** A map tile: a two-tone gradient with simple shapes and the name large and faint. */
function mapImage(name: string, dark: string, light: string): string {
  return uri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>` +
      `<rect width="320" height="120" fill="url(#g)"/>` +
      `<path d="M0 92l60-26 50 14 70-40 60 30 80-22v72H0z" fill="${dark}" opacity="0.55"/>` +
      `<path d="M190 120V58h22v62zM222 120V44h16v76zM246 120V66h28v54z" fill="${dark}" opacity="0.45"/>` +
      `<text x="12" y="112" font-family="Arial, sans-serif" font-weight="900" font-size="54" fill="#ffffff" opacity="0.08">${name.toUpperCase()}</text>` +
      `</svg>`,
  );
}

/** A round emblem with the map's initial. */
function mapLogo(name: string, light: string): string {
  return uri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<circle cx="32" cy="32" r="29" fill="#ffffff"/><circle cx="32" cy="32" r="23" fill="${light}"/>` +
      `<text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="30" fill="#ffffff">${name[0]!.toUpperCase()}</text>` +
      `</svg>`,
  );
}

/** A dead mark: a grey headstone with a cross. */
const DEAD = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<path d="M14 60V28C14 16 22 8 32 8s18 8 18 20v32z" fill="#9aa1ab"/><path d="M14 60V28C14 16 22 8 32 8" fill="none" stroke="#c9ced5" stroke-width="3"/>` +
    `<path d="M32 18v24M24 26h16" stroke="#5c636d" stroke-width="5" stroke-linecap="round"/><rect x="8" y="56" width="48" height="6" rx="2" fill="#6f7680"/>` +
    `</svg>`,
);

/** The demo's HUD images. */
export function demoArt(): HudArt {
  const maps: HudArt["maps"] = {};
  for (const [id, [name, dark, light]] of Object.entries(MAPS)) maps[id] = { imageUrl: mapImage(name, dark, light), logoUrl: id === "de_nuke" ? null : mapLogo(name, light) };
  return {
    defaultPlayers: { ct: [0, 1, 2, 3, 4].map((n) => figure("ct", n)), t: [0, 1, 2, 3, 4].map((n) => figure("t", n)) },
    maps,
    icons: { dead: DEAD },
  };
}

/** A plain black head-and-shoulders silhouette, like a game's default player picture (test scenes). */
export const DEMO_SILHOUETTE = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140">` +
    `<ellipse cx="60" cy="50" rx="21" ry="26" fill="#08090b"/>` +
    `<path d="M50 72h20v14H50z" fill="#08090b"/>` +
    `<path d="M2 140c0-30 16-46 40-52l18 8 18-8c24 6 40 22 40 52z" fill="#08090b"/>` +
    `</svg>`,
);

export const NO_ART: HudArt = { defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } };

/** A made-up clean radar in MatchFrame's style: navy floor, light walls, red bomb sites (1024×1024 frame). */
const CLEAN_RADAR = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<g fill="#1b2a49" stroke="#dfe5ee" stroke-width="8" stroke-linejoin="round">` +
    `<path d="M120 140h300v120h120v-80h300v260h-120v120h170v300H560V690H420v170H130V560h120V420H120z"/>` +
    `<path d="M420 420h180v140H420z" fill="#22355c"/>` +
    `</g>` +
    `<g fill="#c42c3e" fill-opacity="0.85" stroke="#dfe5ee" stroke-width="6">` +
    `<rect x="700" y="210" width="190" height="170" rx="6"/><rect x="160" y="620" width="200" height="200" rx="6"/>` +
    `</g>` +
    `<g fill="#ffffff" font-family="Arial, sans-serif" font-weight="900" font-size="90" text-anchor="middle" opacity="0.9"><text x="795" y="327">A</text><text x="260" y="752">B</text></g>` +
    `</svg>`,
);

/** Where the demo's players stand on the made-up radar, by team order (u, v, facing). */
const SPOTS: [number, number, number][] = [
  [0.76, 0.3, 200],
  [0.62, 0.42, 160],
  [0.5, 0.47, 90],
  [0.3, 0.7, 30],
  [0.84, 0.62, 250],
  [0.2, 0.2, 330],
  [0.35, 0.18, 300],
  [0.48, 0.24, 270],
  [0.62, 0.78, 120],
  [0.24, 0.48, 10],
];

/**
 * Where the demo's players stand on Mirage's real radar image (`assets/radars/de_mirage.png`, 0–1
 * of the 1024 px image: A site, CT spawn, window, B site, short; T ramp, palace, apartments, top
 * mid, underpass), with the bomb on A.
 */
const MIRAGE_SPOTS: [number, number, number][] = [
  [0.55, 0.77, 120],
  [0.35, 0.72, 40],
  [0.4, 0.52, 10],
  [0.23, 0.29, 300],
  [0.31, 0.5, 280],
  [0.82, 0.36, 200],
  [0.7, 0.74, 180],
  [0.65, 0.19, 190],
  [0.62, 0.43, 170],
  [0.5, 0.26, 230],
];

/**
 * The demo radar: every player of the scene on the made-up clean radar, or with `mirage` on Mirage's
 * real radar image (served at /demo-radar/ by scripts/shots.mjs and thumbnail.mjs, not part of any
 * package), the bomb where it lies.
 */
export function demoRadar(players: { steamId: string; side: "CT" | "T" | null; alive: boolean | null; observed: boolean; slot: number | null; flashed: number | null; hasBomb: boolean }[], bomb: { state: string } | null, mirage = false): HudRadar {
  const spots = mirage ? MIRAGE_SPOTS : SPOTS;
  const image = mirage ? "/demo-radar/de_mirage.png" : CLEAN_RADAR;
  return {
    available: true,
    reason: null,
    mapName: "de_mirage",
    mode: "image",
    calibrationVerified: true,
    backgroundUrl: image,
    cleanUrl: mirage ? null : CLEAN_RADAR,
    players: players.map((p, i) => {
      const [u, v, yaw] = spots[i % spots.length]!;
      return { id: p.steamId, u, v, side: p.side, alive: p.alive !== false, observed: p.observed, levelId: null, label: p.slot === null ? null : String(p.slot), yawDeg: yaw, flashed: (p.flashed ?? 0) > 0, hasBomb: p.hasBomb };
    }),
    bomb: bomb && bomb.state !== "carried" ? (mirage ? { u: 0.56, v: 0.76, state: bomb.state } : { u: 0.8, v: 0.28, state: bomb.state }) : null,
    utility: [mirage ? { id: "u1", type: "smoke", u: 0.45, v: 0.47, phase: "active", side: "CT", evidence: "observed", radius: 0.03 } : { id: "u1", type: "smoke", u: 0.56, v: 0.36, phase: "active", side: "CT", evidence: "observed", radius: 0.035 }],
  };
}

/**
 * A made-up sponsor for the demo (`?sponsor=1`): an invented wordmark, SAMPLE CO, drawn here: a
 * small plate for the top bar and a banner for the scoreboard slot. Not a real brand.
 */
const SAMPLE_MARK = `<g transform="translate(0 0)"><path d="M0 22L14 0h12L12 22z" fill="#ff7a1a"/><path d="M14 22L28 0h12L26 22z" fill="#ffb21a"/></g>`;
export const SAMPLE_SPONSOR_PLATE = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 190 44">` +
    `<g transform="translate(6 11)">${SAMPLE_MARK}</g>` +
    `<text x="54" y="31" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-style="italic" font-size="25" letter-spacing="1" fill="#ffffff">SAMPLE</text>` +
    `<text x="160" y="31" font-family="Arial, sans-serif" font-weight="700" font-size="14" fill="#ffb21a">CO</text>` +
    `</svg>`,
);
export const SAMPLE_SPONSOR_BANNER = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 192">` +
    `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121a2c"/><stop offset="1" stop-color="#2a1d14"/></linearGradient></defs>` +
    `<rect width="600" height="192" fill="url(#b)"/>` +
    `<path d="M380 192L470 0h40l-90 192zM450 192L540 0h26l-90 192z" fill="#ff7a1a" opacity="0.18"/>` +
    `<g transform="translate(70 70) scale(2.2)">${SAMPLE_MARK}</g>` +
    `<text x="178" y="117" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-style="italic" font-size="58" letter-spacing="2" fill="#ffffff">SAMPLE</text>` +
    `<text x="182" y="146" font-family="Arial, sans-serif" font-weight="700" font-size="18" letter-spacing="6" fill="#ffb21a">CO · OFFICIAL PARTNER</text>` +
    `</svg>`,
);

