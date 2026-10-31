import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";

/**
 * Match graphics: the thumbnails, "Up next" screen and stinger transitions the program draws for each
 * match (the drawing happens in the program's window; the engine keeps the files, serves them and
 * points OBS at them). Files live in `<data>/graphics/<match id>/`. A stinger is a QuickTime file of
 * PNG frames with transparency (apps/operator-web/src/lib/match-art/mov.ts).
 */
export const ART_KINDS = {
  "thumb-highlights": { file: "thumbnail-highlights.png", type: "image/png", label: "Highlights thumbnail" },
  "thumb-replay": { file: "thumbnail-replay.png", type: "image/png", label: "Full replay thumbnail" },
  "thumb-live": { file: "thumbnail-live.png", type: "image/png", label: "Live thumbnail" },
  "up-next": { file: "up-next.png", type: "image/png", label: "Up next screen" },
  stinger: { file: "stinger.mov", type: "video/quicktime", label: "Stinger" },
  "stinger-replay": { file: "stinger-replay.mov", type: "video/quicktime", label: "Replay stinger" },
} as const;
export type ArtKind = keyof typeof ART_KINDS;
export const ArtKind = z.enum(Object.keys(ART_KINDS) as [ArtKind, ...ArtKind[]]);

/** The OBS Stinger transitions Matchframe fills in (OBS can't create transitions over obs-websocket). */
export const OBS_STINGERS = { stinger: "Matchframe Stinger", "stinger-replay": "Matchframe Replay Stinger" } as const;
/**
 * When OBS cuts to the next scene, in ms of the transition: late in the 400–1000 ms the stinger covers
 * the screen, since OBS starts the video a little late (see apps/operator-web/src/lib/match-art/draw.ts).
 */
export const STINGER_CUT_MS = 900;
/** Largest file accepted (a 1.6 s 1080p60 stinger of PNG frames is about 15 MB; logos add to it). */
export const ART_MAX_BYTES = 120 * 1024 * 1024;

export const ArtSettings = z.object({
  /** An uploaded picture (asset id) behind the thumbnails and "Up next" screen, or null. */
  backgroundAssetId: z.string().max(120).nullable().default(null),
});
export type ArtSettings = z.infer<typeof ArtSettings>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A QuickTime file whose video track is PNG frames ("png " sample entry). */
function isPngMov(b: Buffer): boolean {
  return b.length > 16 && b.toString("latin1", 4, 8) === "ftyp" && b.includes("moov") && b.includes("png ");
}

/**
 * One frame of a PNG QuickTime file (as written by the program: one sample per chunk), `at` from 0 to
 * 1 through the video; null if the file isn't laid out that way.
 */
export function movFrame(b: Buffer, at: number): Buffer | null {
  const stsz = b.lastIndexOf("stsz");
  const stco = b.lastIndexOf("stco");
  if (stsz < 4 || stco < 4) return null;
  const count = b.readUInt32BE(stsz + 12);
  if (!count || b.readUInt32BE(stco + 8) !== count) return null;
  const i = Math.min(count - 1, Math.max(0, Math.round(at * (count - 1))));
  const size = b.readUInt32BE(stsz + 16 + i * 4);
  const offset = b.readUInt32BE(stco + 12 + i * 4);
  if (offset + size > b.length) return null;
  const frame = b.subarray(offset, offset + size);
  return frame.subarray(0, 8).equals(PNG) ? Buffer.from(frame) : null;
}

export interface ArtItem {
  kind: ArtKind;
  label: string;
  file: string;
  url: string;
  /** A still of a stinger (its frame where it covers the screen), as a PNG URL. */
  still: string | null;
  bytes: number;
  updatedAt: string;
}

/** The still of a stinger is served as `<stinger file>.png` (e.g. stinger.mov.png). */
const STILL_SUFFIX = ".png";

export class MatchArt {
  constructor(private readonly e: Engine) {}

  /** The match's folder (the match must exist; its id is the engine's own). */
  dir(matchId: string): string {
    const m = this.e.matches.require(matchId);
    if (!/^[A-Za-z0-9_-]+$/.test(m.id)) throw new HttpError(400, "bad match id", "bad_id");
    return join(this.e.cfg.dataDir, "graphics", m.id);
  }

  path(matchId: string, kind: ArtKind): string {
    return join(this.dir(matchId), ART_KINDS[kind].file);
  }

  list(matchId: string): ArtItem[] {
    const dir = this.dir(matchId);
    const out: ArtItem[] = [];
    for (const [kind, k] of Object.entries(ART_KINDS) as [ArtKind, (typeof ART_KINDS)[ArtKind]][]) {
      const f = join(dir, k.file);
      if (!existsSync(f)) continue;
      const st = statSync(f);
      const base = `/api/v1/match-art/${encodeURIComponent(matchId)}/${k.file}`;
      const v = `?v=${Math.round(st.mtimeMs)}`;
      out.push({ kind, label: k.label, file: f, url: base + v, still: k.type === "video/quicktime" ? base + STILL_SUFFIX + v : null, bytes: st.size, updatedAt: st.mtime.toISOString() });
    }
    return out;
  }

  /** Stores one file, checked to be what its kind says (a PNG, or a QuickTime file of PNG frames). */
  save(matchId: string, kind: ArtKind, body: Buffer): ArtItem {
    const picture = ART_KINDS[kind].type === "image/png";
    const ok = picture ? body.length > 8 && body.subarray(0, 8).equals(PNG) : isPngMov(body);
    if (!ok) throw new HttpError(400, `${ART_KINDS[kind].label} must be a ${picture ? "PNG" : "QuickTime file of PNG frames"}`, "bad_type");
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, ART_KINDS[kind].file);
    // Written beside, then renamed over: OBS may be playing the old one.
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, f);
    return this.list(matchId).find((i) => i.kind === kind)!;
  }

  /** What a public URL (`/api/v1/match-art/<id>/<file>`) serves: a file, or a stinger's still; or null. */
  file(matchId: string, file: string): { body: Buffer; type: string } | null {
    const exact = Object.values(ART_KINDS).find((x) => x.file === file);
    const still = !exact && file.endsWith(STILL_SUFFIX) ? file.slice(0, -STILL_SUFFIX.length) : null;
    const k = exact ?? Object.values(ART_KINDS).find((x) => x.file === still && x.type === "video/quicktime");
    if (!k || !this.e.matches.get(matchId)) return null;
    const f = join(this.dir(matchId), k.file);
    if (!existsSync(f)) return null;
    if (!still) return { body: readFileSync(f), type: k.type };
    // The frame at the cut, where the stinger covers the screen.
    const frame = movFrame(readFileSync(f), STINGER_CUT_MS / 1600);
    return frame ? { body: frame, type: "image/png" } : null;
  }

  settings(matchId: string): ArtSettings {
    const f = join(this.dir(matchId), "settings.json");
    try {
      return ArtSettings.parse(JSON.parse(readFileSync(f, "utf8")));
    } catch {
      return ArtSettings.parse({});
    }
  }

  setSettings(matchId: string, patch: Partial<ArtSettings>): ArtSettings {
    const next = ArtSettings.parse({ ...this.settings(matchId), ...patch });
    const dir = this.dir(matchId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Points OBS's "Matchframe Stinger" and "Matchframe Replay Stinger" transitions at this match's
   * stingers (cut at 800 ms). The replay one becomes the transition into replays and back out of them
   * where none is chosen; with `useStinger` the plain one becomes OBS's current transition.
   */
  async obsSetup(matchId: string, opts: { useStinger?: boolean } = {}): Promise<{ set: { kind: ArtKind; transition: string; confirmed: boolean }[]; missing: string[]; noFile: ArtKind[]; current: string | null; replayIn: string; replayOut: string }> {
    if (!this.e.obs.state.connected) throw new HttpError(409, "OBS is not connected (Settings → Devices)", "obs_not_connected");
    const list = await this.e.obs.transitionKinds();
    const set: { kind: ArtKind; transition: string; confirmed: boolean }[] = [];
    const missing: string[] = [];
    const noFile: ArtKind[] = [];
    for (const [kind, name] of Object.entries(OBS_STINGERS) as [ArtKind, string][]) {
      const t = list.transitions.find((x) => x.name === name);
      if (!t || t.kind !== "obs_stinger_transition") {
        missing.push(name);
        continue;
      }
      const f = this.path(matchId, kind);
      if (!existsSync(f)) {
        noFile.push(kind);
        continue;
      }
      const r = await this.e.obs.setTransitionSettings(name, { path: f, transition_point: STINGER_CUT_MS, tp_type: 0 }, { keepCurrent: kind === "stinger" && opts.useStinger === true });
      set.push({ kind, transition: name, confirmed: r.confirmed });
    }
    // Into replays and back out with the replay stinger, unless another transition was chosen for that way
    // (Replay out "the same as Replay in" follows Replay in).
    const auto = this.e.obsAuto.settings();
    if (set.some((s) => s.kind === "stinger-replay" && s.confirmed)) {
      const name = OBS_STINGERS["stinger-replay"];
      this.e.obsAuto.setSettings({ ...(auto.replayIn ? {} : { replayIn: name }), ...(auto.replayOut === "" ? { replayOut: name } : {}) });
    }
    const after = await this.e.obs.transitions();
    this.e.audit.record("match-art", "match_art.obs_setup", matchId, { set: set.map((s) => s.transition), missing });
    const now = this.e.obsAuto.settings();
    return { set, missing, noFile, current: after.current, replayIn: now.replayIn, replayOut: now.replayOut ?? now.replayIn };
  }

  /** When a match becomes the active one: its stingers in OBS, if the transitions are there (quietly). */
  async onActivated(matchId: string): Promise<void> {
    if (!this.e.obs.state.connected) return;
    try {
      if (!this.list(matchId).some((i) => i.kind === "stinger" || i.kind === "stinger-replay")) return;
      const names = (await this.e.obs.transitionKinds()).transitions.map((t) => t.name);
      if (!Object.values(OBS_STINGERS).some((n) => names.includes(n))) return;
      await this.obsSetup(matchId);
    } catch (err) {
      this.e.logger.warn("match graphics: could not point the OBS stingers at the active match", { error: String(err) });
    }
  }
}
