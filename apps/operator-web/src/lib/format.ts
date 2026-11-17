import { formatDate, formatMoney, formatNumber, perLocale, t } from "../i18n/index.ts";

/** Formatting helpers, in the console's language (ADR-082). Null/undefined always render as an explicit placeholder, never as 0. */

export const MISSING = "—";

/** A number with a fixed number of decimals in the console's language (no thousands separators: 1234.5 / 1234,5). */
const fixed = (v: number, digits: number) => formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return typeof v === "number" && Number.isFinite(v) ? fixed(v, digits) : MISSING;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  return typeof v === "number" && Number.isFinite(v) ? formatNumber(v, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }) : MISSING;
}

export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return MISSING;
  if (Math.abs(ms) < 1000) return t("common.unit.ms", { n: fixed(Math.round(ms), 0) });
  if (Math.abs(ms) < 60_000) return t("common.unit.s", { n: fixed(ms / 1000, 1) });
  return t("common.unit.minSec", { m: Math.floor(ms / 60_000), s: Math.round((ms % 60_000) / 1000) });
}

/** Hours and minutes from seconds ("12 h 05 min", "45 min", "-1 h 00 min"). */
export function fmtHours(sec: number | null | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return MISSING;
  const sign = sec < 0 ? "-" : "";
  const m = Math.floor(Math.abs(sec) / 60);
  if (m < 60) return sign + t("common.unit.min", { n: m });
  return sign + t("common.unit.hMin", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
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
  return typeof v === "number" && Number.isFinite(v) ? formatMoney(v, "USD") : MISSING;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDate(d, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return MISSING;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const s = Math.round((now - at) / 1000);
  if (s < 60) return t("common.ago.s", { n: s });
  if (s < 3600) return t("common.ago.m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("common.ago.h", { n: Math.floor(s / 3600) });
  return t("common.ago.d", { n: Math.floor(s / 86400) });
}

/** CS2's guns by the names the game and the scene use in every language. */
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
  c4: "C4",
  taser: "Zeus x27",
};

/** Utility and the knife, in the console's language. */
const UTILITY_NAMES: Record<string, string> = perLocale(() => ({
  hegrenade: "HE",
  flashbang: t("common.grenade.flashbang"),
  smokegrenade: t("common.grenade.smoke"),
  molotov: t("common.grenade.molotov"),
  incgrenade: t("common.grenade.incendiary"),
  decoy: t("common.grenade.decoy"),
  knife: t("common.weapon.knife"),
  knife_t: t("common.weapon.knife"),
}));

export function weaponName(raw: string | null | undefined): string {
  if (!raw) return MISSING;
  const k = raw.replace(/^weapon_/, "");
  return UTILITY_NAMES[k] ?? WEAPON_NAMES[k] ?? k.replace(/_/g, " ");
}

const GRENADE_ABBR: Record<string, string> = { hegrenade: "HE", flashbang: "FL", smokegrenade: "SM", molotov: "MO", incgrenade: "IN", decoy: "DE" };
export function grenadeAbbr(raw: string): string {
  const k = raw.replace(/^weapon_/, "");
  return GRENADE_ABBR[k] ?? k.slice(0, 2).toUpperCase();
}

export const GRENADE_TYPE_LABEL: Record<string, string> = perLocale(() => ({
  he: "HE",
  flashbang: t("common.grenade.flashbang"),
  smoke: t("common.grenade.smoke"),
  molotov: t("common.grenade.molotov"),
  incendiary: t("common.grenade.incendiary"),
  decoy: t("common.grenade.decoy"),
  fire_unknown: t("common.grenade.fireUnknown"),
  unknown: t("common.unknown"),
}));

/** "pov:<steamId>" → "POV · name", "camera:<id>" → "Camera · id", etc. */
export function shotLabel(shotKey: string | null | undefined, nameOf: (steamId: string) => string): string {
  if (!shotKey) return MISSING;
  const [kind, ...rest] = shotKey.split(":");
  const target = rest.join(":");
  switch (kind) {
    case "pov":
      return t("common.shot.pov", { name: nameOf(target) });
    case "camera": {
      // A team shot, framed live in freeze time ("team-T", "team-CT-still").
      const team = /^team-(T|CT)(-still)?$/.exec(target);
      if (team) return t(team[2] ? "common.shot.teamStill" : "common.shot.team", { side: t(team[1] === "T" ? "common.side.t" : "common.side.ct") });
      return t("common.shot.camera", { id: target });
    }
    case "path":
      return t("common.shot.path", { id: target });
    case "hold":
      return t("common.shot.hold");
    case "roaming":
      return t("common.shot.roaming");
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
