import { useSyncExternalStore } from "react";
import display700 from "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2?url";
import display800 from "@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2?url";
import display800i from "@fontsource/barlow-condensed/files/barlow-condensed-latin-800-italic.woff2?url";
import { api, seg } from "../../api/index.ts";
import type { EventRecord, MatchDetail, TeamRow } from "../../api/types.ts";
import { assetUrl } from "../../components/AssetUpload.tsx";
import type { ArtInput, ArtTeam } from "./draw.ts";
import { drawStingerFrame, drawThumbnail, drawVersus, STINGER, THUMBNAILS } from "./draw.ts";
import { canEncodeVideo, encodeAlphaWebm } from "./encode.ts";

/** The graphics made for every match (engine kinds, see services/local-engine/src/domain/match-art.ts). */
export type ArtKind = "thumb-highlights" | "thumb-replay" | "thumb-live" | "up-next" | "stinger" | "stinger-replay";
export const ART_ORDER: ArtKind[] = ["thumb-highlights", "thumb-replay", "thumb-live", "up-next", "stinger", "stinger-replay"];

export interface ArtJob {
  matchId: string;
  state: "working" | "done" | "failed";
  /** What it is doing now ("Stinger", 40 %), or the outcome. */
  step: string;
  progress: number;
  /** Kinds made in this run. */
  made: ArtKind[];
  error: string | null;
}

const FAMILY = "Matchframe Display";
const DEFAULT_ACCENT = "#ffd23f";
const DEFAULT_EVENT_BRAND = "#2f7cf6";

// ------------------------------------------------------------------ jobs (one per match at a time)

const jobs = new Map<string, ArtJob>();
const running = new Map<string, Promise<ArtJob>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function setJob(j: ArtJob): void {
  jobs.set(j.matchId, j);
  emit();
}

/** The latest run for a match (live while it works), or null. */
export function useArtJob(matchId: string): ArtJob | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => jobs.get(matchId) ?? null,
  );
}

// ------------------------------------------------------------------ loading

let fontsReady: Promise<void> | null = null;
function loadFonts(): Promise<void> {
  fontsReady ??= (async () => {
    const faces = [new FontFace(FAMILY, `url(${display700})`, { weight: "700", style: "normal" }), new FontFace(FAMILY, `url(${display800})`, { weight: "800", style: "normal" }), new FontFace(FAMILY, `url(${display800i})`, { weight: "800", style: "italic" })];
    for (const f of faces) document.fonts.add(await f.load());
  })().catch((err) => {
    fontsReady = null;
    throw err;
  });
  return fontsReady;
}

/** A picture by URL, decoded (logos may be PNG, JPG, WebP, GIF or SVG); null if it can't be read. */
async function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    // An SVG without a size of its own: give it one.
    if (!img.naturalWidth || !img.naturalHeight) {
      img.width = 512;
      img.height = 512;
    }
    return img;
  } catch {
    return null;
  }
}

/** The average colour of a logo's visible pixels (#rrggbb). */
function averageColor(img: CanvasImageSource): string | null {
  try {
    const c = new OffscreenCanvas(24, 24);
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return null;
    x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) continue;
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
    if (!n) return null;
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return null;
  }
}

function relLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

async function team(t: TeamRow | undefined, fallback: string): Promise<ArtTeam> {
  const logo = await loadImage(assetUrl(t?.logoAssetId));
  return { name: t?.name ?? fallback, shortName: t?.shortName ?? fallback, color: t?.primaryColor ?? null, logo, logoColor: logo ? averageColor(logo) : null };
}

/** Everything the drawings need for a match. */
export async function artInput(matchId: string): Promise<ArtInput> {
  const [match, teams, events, settings] = await Promise.all([
    api.get<MatchDetail>(`/api/v1/matches/${seg(matchId)}`),
    api.get<TeamRow[]>("/api/v1/teams?archived=1"),
    api.get<EventRecord[]>("/api/v1/events"),
    api.get<{ settings: { backgroundAssetId: string | null } }>(`/api/v1/matches/${seg(matchId)}/art`).then((r) => r.settings),
    loadFonts(),
  ]);
  const event = events.find((e) => e.id === match.eventId) ?? null;
  const brand = event?.brandPrimary?.toLowerCase();
  const accent = brand && brand !== DEFAULT_EVENT_BRAND && relLuminance(brand) > 0.18 ? brand : DEFAULT_ACCENT;
  const [a, b, eventLogo, background] = await Promise.all([team(teams.find((t) => t.id === match.teamAId), "Team A"), team(teams.find((t) => t.id === match.teamBId), "Team B"), loadImage(assetUrl(event?.logoAssetId)), loadImage(assetUrl(settings.backgroundAssetId))]);
  return { a, b, title: match.title, eventName: event?.name ?? null, eventLogo, accent, bestOf: match.format.bestOf, scheduledAt: match.scheduledAt, background, fonts: { display: FAMILY, text: FAMILY } };
}

// ------------------------------------------------------------------ making and storing

async function png(w: number, h: number, draw: (ctx: OffscreenCanvasRenderingContext2D) => void): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  // Drawn on the CPU (read back at once as a PNG): no GPU round trips, and no slow GPU emulation on a
  // computer without a usable graphics card.
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This computer can't draw the graphics (no 2D canvas).");
  draw(ctx);
  return c.convertToBlob({ type: "image/png" });
}

const store = (matchId: string, kind: ArtKind, data: Blob | Uint8Array, type: string) => api.upload(`/api/v1/matches/${seg(matchId)}/art/${kind}`, data instanceof Blob ? data : new Blob([data as BlobPart]), type);

/**
 * Makes a match's thumbnails, "Up next" screen and both stingers (or just `only`), and stores each
 * on the engine as soon as it is done. One run per match at a time: a second call while one runs
 * gets the same run.
 */
export function makeMatchArt(matchId: string, only?: ArtKind[]): Promise<ArtJob> {
  const already = running.get(matchId);
  if (already) return already;
  const want = only ?? ART_ORDER;
  const job: ArtJob = { matchId, state: "working", step: "Loading team logos", progress: 0, made: [], error: null };
  setJob({ ...job });
  const run = (async (): Promise<ArtJob> => {
    const skipped: string[] = [];
    try {
      const input = await artInput(matchId);
      // Weights for the progress bar: a stinger takes far longer than a picture.
      const weight = (k: ArtKind) => (k.startsWith("stinger") ? 10 : 1);
      const total = want.reduce((n, k) => n + weight(k), 0);
      let done = 0;
      const step = (label: string, part = 0, k?: ArtKind) => setJob({ ...job, step: label, progress: Math.min(1, (done + (k ? weight(k) * part : 0)) / total) });
      for (const kind of want) {
        if (kind.startsWith("thumb-")) {
          const t = THUMBNAILS.find((x) => `thumb-${x.kind}` === kind)!;
          step(`${t.words.join(" ").toLowerCase()} thumbnail`);
          await store(matchId, kind, await png(1280, 720, (ctx) => drawThumbnail(ctx, 1280, 720, t.kind, input, matchId)), "image/png");
        } else if (kind === "up-next") {
          step("Up next screen");
          await store(matchId, kind, await png(1920, 1080, (ctx) => drawVersus(ctx, 1920, 1080, input, matchId)), "image/png");
        } else {
          const replay = kind === "stinger-replay";
          const label = replay ? "Replay stinger" : "Stinger";
          if (!(await canEncodeVideo(STINGER.width, STINGER.height))) {
            skipped.push(`${label}: this computer can't encode video here (WebCodecs VP8).`);
            done += weight(kind);
            continue;
          }
          const frames = Math.round((STINGER.durationMs / 1000) * STINGER.fps);
          const bytes = await encodeAlphaWebm({
            width: STINGER.width,
            height: STINGER.height,
            fps: STINGER.fps,
            frames,
            draw: (ctx, i) => drawStingerFrame(ctx, STINGER.width, STINGER.height, (i * 1000) / STINGER.fps, input, replay),
            onProgress: (n, of) => step(label, n / of, kind),
          });
          await store(matchId, kind, bytes, "video/webm");
        }
        job.made.push(kind);
        done += weight(kind);
        step("Saved");
      }
      const final: ArtJob = { ...job, state: skipped.length ? "failed" : "done", step: skipped.length ? "Made the pictures; not the stingers" : "Done", progress: 1, error: skipped.length ? skipped.join(" ") : null };
      setJob(final);
      return final;
    } catch (err) {
      const final: ArtJob = { ...job, state: "failed", step: "Stopped", error: err instanceof Error ? err.message : String(err) };
      setJob(final);
      return final;
    } finally {
      running.delete(matchId);
    }
  })();
  running.set(matchId, run);
  return run;
}
