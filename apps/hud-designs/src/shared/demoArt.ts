import type { HudArt, HudRadar } from "@matchframe/hud-sdk";

/**
 * Original sample pictures for the demo (`?art=1`, `?radar=1`): plain inline SVG drawings standing in
 * for the operator's HUD images (player figures tinted by side, map tiles, a dead mark) and for
 * Matchframe's clean radar (a made-up layout, not a real map).
 */

const uri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const SKIN = ["#efcfb6", "#d9a982", "#bf8a63", "#8e5d3e", "#e6bd9c"];
const HAIR = ["#2b1d14", "#6b4a2b", "#14110f", "#a8743a", "#3a2a20"];

/** A generic head-and-shoulders figure in the side's jersey; `n` varies skin, hair and cut. */
function figure(side: "ct" | "t", n: number): string {
  const jersey = side === "ct" ? ["#1f5fbf", "#2f7fe6"] : ["#b0283a", "#e04256"];
  const trim = side === "ct" ? "#bcd6ff" : "#ffd0d6";
  const skin = SKIN[n % SKIN.length]!;
  const hair = HAIR[n % HAIR.length]!;
  const cuts = [
    `<path d="M41 40c0-17 9-25 19-25s19 8 19 25c-3-7-9-11-19-11s-16 4-19 11z" fill="${hair}"/>`,
    `<path d="M40 44c-1-19 8-29 21-29 12 0 20 8 20 22-6-4-12-10-16-14-5 9-14 15-25 21z" fill="${hair}"/>`,
    `<path d="M42 36c2-13 9-19 18-19s16 6 18 19c-5-4-11-6-18-6s-13 2-18 6z" fill="${hair}" opacity="0.85"/>`,
    `<path d="M39 42c-3-12 2-27 21-27s24 15 21 27c-2-5-4-9-6-11-4 3-9 4-15 4s-11-1-15-4c-2 2-4 6-6 11z" fill="${hair}"/>`,
    `<path d="M38 38c0-16 10-25 22-25s22 9 22 25v3H38z" fill="${jersey[0]}"/><rect x="38" y="35" width="44" height="6" rx="3" fill="${trim}"/>`,
  ];
  return uri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140">` +
      `<defs><linearGradient id="j" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${jersey[1]}"/><stop offset="1" stop-color="${jersey[0]}"/></linearGradient></defs>` +
      `<path d="M2 140c0-30 12-44 34-50l14-5h20l14 5c22 6 34 20 34 50z" fill="url(#j)"/>` +
      `<path d="M48 85l12 16 12-16" fill="none" stroke="${trim}" stroke-width="4"/>` +
      `<path d="M50 66h20v18c-5 6-15 6-20 0z" fill="${skin}" opacity="0.85"/>` +
      `<ellipse cx="60" cy="47" rx="19" ry="24" fill="${skin}"/>` +
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

export const NO_ART: HudArt = { defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } };

/** A made-up clean radar in Matchframe's style: navy floor, light walls, red bomb sites (1024×1024 frame). */
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

/** The demo radar: every player of the scene on the clean radar, the bomb where it lies. */
export function demoRadar(players: { steamId: string; side: "CT" | "T" | null; alive: boolean | null; observed: boolean; slot: number | null; flashed: number | null; hasBomb: boolean }[], bomb: { state: string } | null): HudRadar {
  return {
    available: true,
    reason: null,
    mapName: "de_mirage",
    mode: "image",
    calibrationVerified: true,
    backgroundUrl: CLEAN_RADAR,
    cleanUrl: CLEAN_RADAR,
    players: players.map((p, i) => {
      const [u, v, yaw] = SPOTS[i % SPOTS.length]!;
      return { id: p.steamId, u, v, side: p.side, alive: p.alive !== false, observed: p.observed, levelId: null, label: p.slot === null ? null : String(p.slot), yawDeg: yaw, flashed: (p.flashed ?? 0) > 0, hasBomb: p.hasBomb };
    }),
    bomb: bomb && bomb.state !== "carried" ? { u: 0.8, v: 0.28, state: bomb.state } : null,
    utility: [{ id: "u1", type: "smoke", u: 0.56, v: 0.36, phase: "active", side: "CT", evidence: "observed", radius: 0.035 }],
  };
}
