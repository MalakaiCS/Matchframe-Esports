import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync } from "fflate";

/**
 * The icon pack: Counter-Strike 2's own HUD icons (weapons, grenades, armour, kit, bomb, kill
 * marks), which MatchFrame does not ship (they are Valve's artwork). The operator loads them on this
 * computer from their own copy (a ZIP or a folder of CS2's `panorama/images/icons`), or has the engine
 * download them from a public collection at their request. Only the names the HUDs use are kept, every
 * SVG is checked and stripped of anything active, and the pack stays on this computer (not synced).
 * HUDs learn which icons exist from `state.art.iconPack` and load them from the overlay server.
 */

export const ICON_PACK_LIMITS = {
  /** A ZIP upload. */
  zipBytes: 200 * 1024 * 1024,
  /** One SVG. */
  svgBytes: 512 * 1024,
  /** Every kept SVG together. */
  totalBytes: 20 * 1024 * 1024,
  /** Icons kept. */
  maxIcons: 400,
  /** Files looked at in a folder (a whole drive chosen by mistake stops here). */
  scanFiles: 200_000,
};

/** HUD icons from CS2's `icons/ui` folder that MatchFrame's HUDs use. */
export const ICON_PACK_UI = [
  "kill",
  "kill_headshot",
  "elimination",
  "elimination_headshot",
  "health",
  "armor",
  "helmet",
  "defuser",
  "bomb",
  "bomb_c4",
  "bomb_icon",
  "map_death",
  "dollar_sign",
  "stat_assists",
  "stat_headshots",
  "stat_mvps",
  "star",
  "timer",
  "clock",
  "pause",
  "player",
  "switch_teams_dead",
  "dominated_dead",
] as const;

/**
 * CS2's `icons/equipment` folder (weapons, grenades, armour, kits, the bomb, knives): every one of
 * them is kept. This list stands in for the folder's listing when it can't be fetched.
 */
export const ICON_PACK_EQUIPMENT = [
  "ak47", "ammobox", "ammobox_threepack", "armor", "armor_helmet", "assaultsuit", "assaultsuit_helmet_only", "aug", "awp", "bayonet", "bizon", "c4",
  "cz75a", "deagle", "decoy", "defuser", "elite", "famas", "firebomb", "fiveseven", "flashbang", "flashbang_assist", "g3sg1", "galilar", "glock",
  "grenadepack", "grenadepack2", "healthshot", "heavy_armor", "hegrenade", "helmet", "hkp2000", "incgrenade", "inferno", "kevlar", "knife",
  "knife_bowie", "knife_butterfly", "knife_canis", "knife_cord", "knife_css", "knife_falchion", "knife_flip", "knife_gut", "knife_gypsy_jackknife",
  "knife_karambit", "knife_kukri", "knife_m9_bayonet", "knife_outdoor", "knife_push", "knife_skeleton", "knife_stiletto", "knife_survival_bowie",
  "knife_t", "knife_tactical", "knife_twinblade", "knife_ursus", "knife_widowmaker", "knifegg", "m249", "m4a1", "m4a1_silencer", "m4a1_silencer_off",
  "mac10", "mag7", "melee", "molotov", "mp5sd", "mp7", "mp9", "negev", "nova", "p2000", "p250", "p90", "planted_c4", "revolver", "sawedoff",
  "scar20", "sg556", "smokegrenade", "ssg08", "taser", "tec9", "ump45", "usp_silencer", "usp_silencer_off", "xm1014",
];

const UI = new Set<string>(ICON_PACK_UI);
const EQUIPMENT = new Set<string>(ICON_PACK_EQUIPMENT);
const NAME = /^[a-z0-9_]{1,64}$/;
/** `…/panorama/images/icons/<equipment|ui>/<name>.svg` anywhere in a ZIP or folder. */
const PANORAMA = /(?:^|\/)panorama\/images\/icons\/(equipment|ui)\/([^/]+)\.svg$/i;

export class IconPackError extends Error {
  readonly status = 400;
  readonly code = "icon_pack";
}

/** Where the engine downloads CS2's icons from on the operator's request (tests point it elsewhere). */
export interface IconPackSource {
  /** `<rawBase>/<equipment|ui>/<name>.svg`. */
  rawBase: string;
  /** A GitHub contents-API listing of the equipment folder (names only). */
  listUrl: string;
}

export const DEFAULT_ICON_PACK_SOURCE: IconPackSource = {
  rawBase: "https://raw.githubusercontent.com/Juknum/counter-strike-icons/main/cs2/panorama/images/icons",
  listUrl: "https://api.github.com/repos/Juknum/counter-strike-icons/contents/cs2/panorama/images/icons/equipment",
};

// ---------------------------------------------------------------------------------------- sanitising

/** Elements an icon never needs and that could run, embed or link anything. */
const BANNED = new Set(["script", "foreignobject", "iframe", "embed", "object", "a", "audio", "video", "image", "feimage", "set", "animate", "animatemotion", "animatetransform", "animatecolor", "handler", "listener", "discard"]);
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/** A CSS value (a style attribute or element) that loads nothing from outside the icon. */
function checkCss(css: string, where: string): void {
  if (/@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) throw new IconPackError(`${where}: style that loads or runs something`);
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) if (!m[2]!.trim().startsWith("#")) throw new IconPackError(`${where}: a style reference outside the icon`);
}

/**
 * An SVG fit for a HUD, or an error: well-formed tags with one `<svg>` root; no scripts, foreign
 * objects, embeds, links, images or animations; no event attributes; references only to the icon's
 * own `#ids`; no DTD internal subset (entities) or processing instructions. The XML declaration,
 * comments and a plain DOCTYPE are removed.
 */
export function sanitizeSvg(bytes: Uint8Array | string, name = "icon"): string {
  let s: string;
  try {
    s = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IconPackError(`${name}: not UTF-8 text`);
  }
  s = s.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^?]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<!DOCTYPE[^>]*\[/i.test(s) || /<!ENTITY/i.test(s)) throw new IconPackError(`${name}: a DTD with entities`);
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "");
  if (/<\?/.test(s)) throw new IconPackError(`${name}: a processing instruction`);
  if (/<!\[CDATA\[/i.test(s)) {
    // CDATA only as a style sheet's wrapper.
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, css: string) => {
      if (/[<>]/.test(css)) throw new IconPackError(`${name}: markup in a CDATA section`);
      return css;
    });
  }
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  let inStyle = false;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const text = s.slice(i, lt < 0 ? s.length : lt);
    if (stack.length === 0 && text.trim()) throw new IconPackError(`${name}: text outside the <svg> element`);
    if (inStyle) checkCss(text, name);
    if (lt < 0) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(s);
    if (!m) throw new IconPackError(`${name}: not well-formed SVG`);
    const [, closing, rawTag, attrs = "", selfClosing] = m;
    const tag = rawTag!.toLowerCase();
    const local = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    if (closing) {
      if (stack.pop() !== tag) throw new IconPackError(`${name}: not well-formed SVG (</${rawTag}>)`);
      if (local === "style") inStyle = false;
    } else {
      if (BANNED.has(local)) throw new IconPackError(`${name}: <${rawTag}> is not allowed in an icon`);
      if (stack.length === 0) {
        if (local !== "svg") throw new IconPackError(`${name}: the root element is not <svg>`);
        if (++roots > 1) throw new IconPackError(`${name}: more than one <svg> root`);
      }
      for (const a of attrs.matchAll(ATTR)) {
        const attr = a[1]!.toLowerCase();
        const value = a[2] ?? a[3] ?? "";
        if (attr.startsWith("on")) throw new IconPackError(`${name}: an event attribute (${a[1]})`);
        if (/javascript:|vbscript:|data:/i.test(value) && attr !== "d") throw new IconPackError(`${name}: a script or embedded reference in ${a[1]}`);
        if ((attr === "href" || attr.endsWith(":href")) && !value.trim().startsWith("#")) throw new IconPackError(`${name}: a reference outside the icon (${a[1]})`);
        if (attr === "style") checkCss(value, name);
        else if (/url\(/i.test(value)) checkCss(value, name);
      }
      if (!selfClosing) {
        stack.push(tag);
        if (local === "style") inStyle = true;
      }
    }
    i = TAG.lastIndex;
  }
  if (stack.length) throw new IconPackError(`${name}: not well-formed SVG (<${stack[stack.length - 1]}> is not closed)`);
  if (roots !== 1) throw new IconPackError(`${name}: no <svg> element`);
  return s.trim();
}

// ---------------------------------------------------------------------------------------- choosing

/** Which icon a file is, if the HUDs use it: CS2's equipment or ui folder, or straight in the chosen folder. */
export function iconFor(path: string): { name: string; priority: number } | null {
  const p = path.replace(/\\/g, "/");
  const m = PANORAMA.exec(p);
  if (m) {
    const name = m[2]!.toLowerCase();
    if (!NAME.test(name)) return null;
    const folder = m[1]!.toLowerCase();
    if (folder === "ui" && !UI.has(name)) return null;
    // CS2's tree over others (a repository also holding CS:GO's); the HUD icons over the buy menu's on a shared name.
    const cs2 = /(?:^|\/)cs2\//i.test(p) ? 10 : 0;
    return { name, priority: cs2 + (folder === "ui" ? 2 : 1) };
  }
  if (p.includes("/")) return null;
  const name = p.replace(/\.svg$/i, "").toLowerCase();
  if (!/\.svg$/i.test(p) || !NAME.test(name)) return null;
  return UI.has(name) || EQUIPMENT.has(name) || name.startsWith("knife_") ? { name, priority: 0 } : null;
}

export interface CollectResult {
  icons: Map<string, string>;
  /** Files that looked like HUD icons but were refused, with why. */
  refused: { name: string; reason: string }[];
}

/** Picks, checks and sanitises the HUD's icons from `[path, read]` pairs (read only those it keeps). */
export function collectIcons(files: Iterable<[string, () => Uint8Array]>): CollectResult {
  const best = new Map<string, { priority: number; read: () => Uint8Array }>();
  for (const [path, read] of files) {
    const hit = iconFor(path);
    if (!hit) continue;
    const cur = best.get(hit.name);
    if (!cur || hit.priority > cur.priority) best.set(hit.name, { priority: hit.priority, read });
  }
  const icons = new Map<string, string>();
  const refused: CollectResult["refused"] = [];
  let total = 0;
  for (const [name, { read }] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
    if (icons.size >= ICON_PACK_LIMITS.maxIcons) throw new IconPackError(`more than ${ICON_PACK_LIMITS.maxIcons} icons`);
    const bytes = read();
    if (bytes.length > ICON_PACK_LIMITS.svgBytes) {
      refused.push({ name, reason: `larger than ${ICON_PACK_LIMITS.svgBytes / 1024} KB` });
      continue;
    }
    try {
      const svg = sanitizeSvg(bytes, name);
      total += Buffer.byteLength(svg);
      if (total > ICON_PACK_LIMITS.totalBytes) throw new IconPackError(`the icons come to more than ${ICON_PACK_LIMITS.totalBytes / 1024 / 1024} MB`);
      icons.set(name, svg);
    } catch (err) {
      if (err instanceof IconPackError && !err.message.startsWith(`${name}:`)) throw err;
      refused.push({ name, reason: err instanceof Error ? err.message.replace(`${name}: `, "") : "unreadable" });
    }
  }
  return { icons, refused };
}

/** The HUD's icons in a ZIP (only candidate SVGs within the size cap are decompressed). */
export function iconsFromZip(zip: Uint8Array): CollectResult {
  if (zip.length > ICON_PACK_LIMITS.zipBytes) throw new IconPackError(`the ZIP is larger than ${ICON_PACK_LIMITS.zipBytes / 1024 / 1024} MB`);
  let entries: Record<string, Uint8Array>;
  let declared = 0;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        if (!iconFor(f.name) || f.originalSize > ICON_PACK_LIMITS.svgBytes) return false;
        declared += f.originalSize;
        if (declared > ICON_PACK_LIMITS.totalBytes * 4) throw new IconPackError("the ZIP's icons are too large");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof IconPackError) throw err;
    throw new IconPackError("the file is not a valid ZIP archive");
  }
  const result = collectIcons(Object.entries(entries).map(([path, data]) => [path, () => data] as [string, () => Uint8Array]));
  if (result.icons.size === 0) throw new IconPackError("no CS2 icons found in the ZIP (looked for panorama/images/icons/equipment and ui)");
  return result;
}

/** The HUD's icons in a folder on this computer (no symbolic links followed). */
export function iconsFromFolder(dir: string): CollectResult {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new IconPackError("folder not found");
  const found: [string, () => Uint8Array][] = [];
  let seen = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > ICON_PACK_LIMITS.scanFiles) throw new IconPackError("the folder holds too many files; choose the icons folder itself");
      if (n === "node_modules" || n.startsWith(".")) continue;
      const full = join(d, n);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && n.toLowerCase().endsWith(".svg")) {
        const rel = relative(dir, full).split(sep).join("/");
        if (iconFor(rel)) found.push([rel, () => (st.size > ICON_PACK_LIMITS.svgBytes ? new Uint8Array(ICON_PACK_LIMITS.svgBytes + 1) : readFileSync(full))]);
      }
    }
  };
  walk(dir, 0);
  const result = collectIcons(found);
  if (result.icons.size === 0) throw new IconPackError("no CS2 icons found in the folder (looked for panorama/images/icons/equipment and ui, or icon SVGs in the folder itself)");
  return result;
}

// ---------------------------------------------------------------------------------------- the pack

export interface IconPackStatus {
  count: number;
  names: string[];
  source: "zip" | "folder" | "download" | null;
  importedAt: string | null;
  refused: { name: string; reason: string }[];
  /** A download in progress, or how the last one ended. */
  job: { state: "downloading"; done: number; total: number } | { state: "error"; message: string } | { state: "done"; count: number } | null;
}

interface PackMeta {
  names: string[];
  source: IconPackStatus["source"];
  importedAt: string;
  refused: IconPackStatus["refused"];
}

/** The pack stored in `<dataDir>/icon-pack/` (one `<name>.svg` per icon and `pack.json`). */
export class IconPack {
  private meta: PackMeta | null = null;
  private hud: { names: string[]; base: string } | null = null;
  private job: IconPackStatus["job"] = null;
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly onChange: () => void,
  ) {
    this.dir = join(dataDir, "icon-pack");
    this.load();
  }

  private load(): void {
    try {
      const m = JSON.parse(readFileSync(join(this.dir, "pack.json"), "utf8")) as PackMeta;
      const names = (Array.isArray(m.names) ? m.names : []).filter((n) => NAME.test(n) && existsSync(join(this.dir, `${n}.svg`)));
      this.meta = { names, source: m.source ?? null, importedAt: m.importedAt ?? null, refused: Array.isArray(m.refused) ? m.refused : [] } as PackMeta;
    } catch {
      this.meta = null;
    }
    this.hud = this.meta && this.meta.names.length ? { names: [...this.meta.names].sort(), base: "/icon-pack/" } : null;
  }

  status(): IconPackStatus {
    const m = this.meta;
    return { count: m?.names.length ?? 0, names: m ? [...m.names].sort() : [], source: m?.source ?? null, importedAt: m?.importedAt ?? null, refused: m?.refused ?? [], job: this.job };
  }

  /** What HUDs receive in `state.art.iconPack` (the same object until the pack changes). */
  hudState(): { names: string[]; base: string } | null {
    return this.hud;
  }

  /** The stored file for an icon name, or null. */
  file(name: string): string | null {
    if (!NAME.test(name) || !this.meta?.names.includes(name)) return null;
    const f = join(this.dir, `${name}.svg`);
    return existsSync(f) ? f : null;
  }

  /** Replaces the pack with these icons (written beside it, then swapped in). */
  install(result: CollectResult, source: NonNullable<IconPackStatus["source"]>): IconPackStatus {
    if (result.icons.size === 0) throw new IconPackError("no icons to keep");
    const next = `${this.dir}.new`;
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });
    for (const [name, svg] of result.icons) writeFileSync(join(next, `${name}.svg`), svg);
    const meta: PackMeta = { names: [...result.icons.keys()].sort(), source, importedAt: new Date().toISOString(), refused: result.refused };
    writeFileSync(join(next, "pack.json"), JSON.stringify(meta, null, 2));
    rmSync(this.dir, { recursive: true, force: true });
    renameSync(next, this.dir);
    this.load();
    this.onChange();
    return this.status();
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.load();
    this.onChange();
  }

  /** A download is running. */
  get downloading(): boolean {
    return this.job?.state === "downloading";
  }

  /**
   * Downloads the HUD's icons from `source` (at the operator's request): the equipment folder's
   * listing (names only; the built-in list when it can't be fetched), then each SVG with a timeout,
   * at most four at a time, each retried once. Every icon goes through the same checks as an import.
   */
  async download(source: IconPackSource, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<IconPackStatus> {
    if (this.downloading) throw new IconPackError("a download is already running");
    const get = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const fetchWithTimeout = async (url: string, accept: string) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await get(url, { signal: ctl.signal, headers: { accept, "user-agent": "MatchFrame" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } finally {
        clearTimeout(t);
      }
    };
    this.job = { state: "downloading", done: 0, total: 0 };
    try {
      let equipment = ICON_PACK_EQUIPMENT;
      try {
        const listing = (await (await fetchWithTimeout(source.listUrl, "application/vnd.github+json")).json()) as { name?: unknown; type?: unknown }[];
        const names = Array.isArray(listing) ? listing.filter((x) => x.type === "file" && typeof x.name === "string" && /\.svg$/i.test(x.name)).map((x) => (x.name as string).replace(/\.svg$/i, "").toLowerCase()).filter((n) => NAME.test(n)) : [];
        if (names.length) equipment = names;
      } catch {
        // The built-in list of names stands in.
      }
      const wanted: { folder: "equipment" | "ui"; name: string }[] = [...equipment.map((name) => ({ folder: "equipment" as const, name })), ...ICON_PACK_UI.map((name) => ({ folder: "ui" as const, name }))].slice(0, ICON_PACK_LIMITS.maxIcons * 2);
      this.job = { state: "downloading", done: 0, total: wanted.length };
      const got: [string, () => Uint8Array][] = [];
      let failures = 0;
      let next = 0;
      const worker = async () => {
        while (next < wanted.length) {
          const w = wanted[next++]!;
          const url = `${source.rawBase}/${w.folder}/${w.name}.svg`;
          let bytes: Uint8Array | null = null;
          for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
            try {
              const res = await fetchWithTimeout(url, "image/svg+xml");
              const buf = new Uint8Array(await res.arrayBuffer());
              bytes = buf.length > ICON_PACK_LIMITS.svgBytes ? new Uint8Array(ICON_PACK_LIMITS.svgBytes + 1) : buf;
            } catch {
              // Retried once; then counted as missing.
            }
          }
          if (bytes) {
            const b = bytes;
            got.push([`panorama/images/icons/${w.folder}/${w.name}.svg`, () => b]);
          } else failures++;
          if (this.job?.state === "downloading") this.job = { ...this.job, done: this.job.done + 1 };
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (got.length === 0) throw new IconPackError(`could not reach the icon collection (${failures} downloads failed); use Import ZIP… instead`);
      const result = collectIcons(got);
      const status = this.install(result, "download");
      this.job = { state: "done", count: status.count };
      return this.status();
    } catch (err) {
      this.job = { state: "error", message: err instanceof Error ? err.message : String(err) };
      throw err instanceof IconPackError ? err : new IconPackError(`${this.job.message}; use Import ZIP… instead`);
    }
  }
}
