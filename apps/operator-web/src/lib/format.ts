/** Formatting helpers. Null/undefined always render as an explicit placeholder, never as 0. */

export const MISSING = "—";

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : MISSING;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : MISSING;
}

export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return MISSING;
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  if (Math.abs(ms) < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Hours and minutes from seconds ("12 h 05 min", "45 min", "-1 h 00 min"). */
export function fmtHours(sec: number | null | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return MISSING;
  const sign = sec < 0 ? "-" : "";
  const m = Math.floor(Math.abs(sec) / 60);
  if (m < 60) return `${sign}${m} min`;
  return `${sign}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** m:ss clock from seconds. */
export function fmtClock(sec: number | null | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return MISSING;
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtMatchTime(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return MISSING;
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (typeof b !== "number" || !Number.isFinite(b)) return MISSING;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtMoney(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `$${v.toLocaleString("en-US")}` : MISSING;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return MISSING;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const WEAPON_NAMES: Record<string, string> = {
  ak47: "AK-47",
  m4a1: "M4A4",
  m4a1_silencer: "M4A1-S",
  awp: "AWP",
  deagle: "Desert Eagle",
  glock: "Glock-18",
  usp_silencer: "USP-S",
  hkp2000: "P2000",
  p250: "P250",
  fiveseven: "Five-SeveN",
  tec9: "Tec-9",
  cz75a: "CZ75-Auto",
  elite: "Dual Berettas",
  revolver: "R8 Revolver",
  famas: "FAMAS",
  galilar: "Galil AR",
  sg556: "SG 553",
  aug: "AUG",
  ssg08: "SSG 08",
  scar20: "SCAR-20",
  g3sg1: "G3SG1",
  mp9: "MP9",
  mac10: "MAC-10",
  mp7: "MP7",
  mp5sd: "MP5-SD",
  ump45: "UMP-45",
  p90: "P90",
  bizon: "PP-Bizon",
  nova: "Nova",
  xm1014: "XM1014",
  mag7: "MAG-7",
  sawedoff: "Sawed-Off",
  m249: "M249",
  negev: "Negev",
  hegrenade: "HE",
  flashbang: "Flash",
  smokegrenade: "Smoke",
  molotov: "Molotov",
  incgrenade: "Incendiary",
  decoy: "Decoy",
  c4: "C4",
  taser: "Zeus x27",
  knife: "Knife",
  knife_t: "Knife",
};

export function weaponName(raw: string | null | undefined): string {
  if (!raw) return MISSING;
  const k = raw.replace(/^weapon_/, "");
  return WEAPON_NAMES[k] ?? k.replace(/_/g, " ");
}

const GRENADE_ABBR: Record<string, string> = { hegrenade: "HE", flashbang: "FL", smokegrenade: "SM", molotov: "MO", incgrenade: "IN", decoy: "DE" };
export function grenadeAbbr(raw: string): string {
  const k = raw.replace(/^weapon_/, "");
  return GRENADE_ABBR[k] ?? k.slice(0, 2).toUpperCase();
}

export const GRENADE_TYPE_LABEL: Record<string, string> = {
  he: "HE",
  flashbang: "Flashbang",
  smoke: "Smoke",
  molotov: "Molotov",
  incendiary: "Incendiary",
  decoy: "Decoy",
  fire_unknown: "Fire (type unknown)",
  unknown: "Unknown",
};

/** "pov:<steamId>" → "POV · name", "camera:<id>" → "Camera · id", etc. */
export function shotLabel(shotKey: string | null | undefined, nameOf: (steamId: string) => string): string {
  if (!shotKey) return MISSING;
  const [kind, ...rest] = shotKey.split(":");
  const target = rest.join(":");
  switch (kind) {
    case "pov":
      return `POV · ${nameOf(target)}`;
    case "camera": {
      // A team shot, framed live in freeze time ("team-T", "team-CT-still").
      const team = /^team-(T|CT)(-still)?$/.exec(target);
      if (team) return `Team shot · ${team[1] === "T" ? "Terrorists" : "Counter-Terrorists"}${team[2] ? " (still)" : ""}`;
      return `Camera · ${target}`;
    }
    case "path":
      return `Camera path · ${target}`;
    case "hold":
      return "Hold current shot";
    case "roaming":
      return "Free camera (roaming)";
    default:
      return shotKey;
  }
}

export function shotTarget(shotKey: string | null | undefined): { kind: string; target: string } | null {
  if (!shotKey) return null;
  const [kind, ...rest] = shotKey.split(":");
  return { kind: kind ?? "", target: rest.join(":") };
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Triggers a browser download of a Blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
