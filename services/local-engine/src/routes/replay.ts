import { mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ReplayPlay } from "@matchframe/replay-agent";
import { probeMedia } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
import { APP_VERSION } from "../config.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { GraphicsPatch } from "../live/graphics.ts";
import { ObsAutoPatch } from "../live/obs-auto.ts";
import { AutoReplayPatch, playPriority } from "../replay/auto.ts";
import { FeedPatch, ReplayFeed } from "../replay/feed.ts";
import { ReplayPcSettings, replayLabel } from "../replay/link.ts";

/** A clip from the replay PC: at most this big (the whole upload is held in memory; a 20 s 1080p60 clip is ~25 MB). */
const CLIP_MAX = 200 * 1024 * 1024;
const CLIP_EXT = new Set(["mp4", "mkv", "mov", "flv", "ts", "m4v"]);
/** Clips from the replay PC kept on disk (the oldest go first). */
const KEEP_CLIPS = 120;

/** This computer's network addresses (IPv4, not loopback), for the replay PC to connect to. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

export function registerReplayRoutes(r: Router, e: Engine): void {
  // ---- main PC: what the replay PC asks for ---------------------------------------------------
  r.get("/api/v1/replay-link/on-air", { permission: "state.read" }, (req) => {
    // The replay PC says which rounds it still has kills of to film or send (the break waits for them).
    const pending = req.query.get("pending");
    if (pending !== null) e.onAir.notePeer(pending.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 10));
    const s = e.session.state();
    // feed.recording: this computer records the replay PC's screen over NDI, so the replay PC only marks its kills (POST /api/v1/replays/mark).
    return { computer: hostname(), version: APP_VERSION, observedSteamId: s?.observer.observedSteamId ?? null, roundNumber: s?.roundNumber ?? null, roundPhase: s?.roundPhase ?? null, mapName: s?.mapName ?? null, clock: e.onAir.clock(s), kills: e.onAir.recentKills(), feed: { recording: e.replayFeed.recording() } };
  });

  /**
   * The replay PC filmed a kill (the replay feed): the moment, as how long ago it began, the first
   * kill happened and it ended, is cut here from the recording of its screen.
   */
  r.post(
    "/api/v1/replays/mark",
    {
      permission: "replay.control",
      body: z.object({
        label: z.string().max(120),
        kind: z.enum(["missed", "other_angle", "shown"]),
        round: z.number().int().nullable(),
        kills: z.number().int().min(1).max(5),
        killer: z.object({ steamId: z.string().max(32), name: z.string().max(64) }).nullable(),
        victims: z.array(z.string().max(64)).max(5),
        weapon: z.string().max(40).nullable(),
        headshot: z.boolean(),
        fromAgoMs: z.number().min(0).max(120_000),
        killAgoMs: z.number().min(0).max(120_000),
        endAgoMs: z.number().min(0).max(120_000),
      }),
    },
    async (req) => {
      if (!e.replayFeed.recording()) throw new HttpError(409, "this computer isn't recording the replay PC's picture", "feed_not_recording");
      const b = req.body;
      // When the replay PC said each moment happened, on this computer's clock and in the picture as it arrived here.
      const at = Date.now() + e.replayFeed.settings().latencyMs;
      const to = at - b.endAgoMs;
      const from = at - b.fromAgoMs;
      const kill = at - b.killAgoMs;
      const dir = e.replayDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mp4`);
      let cut: Awaited<ReturnType<typeof e.replayFeed.cut>>;
      try {
        cut = await e.replayFeed.cut(from, to, file);
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err), "feed_cut_failed");
      }
      ReplayFeed.pruneClips(dir, KEEP_CLIPS);
      const startsAt = Math.max(from, cut.startWall);
      const play: ReplayPlay = { kind: b.kind, killer: b.killer, victims: b.victims, kills: b.kills, weapon: b.weapon, headshot: b.headshot };
      const item = e.replays.addExternal(b.label || replayLabel(play), b.kind, b.round, {
        clipId: `clip_feed_${Date.now().toString(36)}`,
        providerId: "replay-feed",
        sourceId: "ndi",
        angle: "recorded_angle",
        matchTimeFromMs: null,
        matchTimeToMs: null,
        timeUncertaintyMs: null,
        epoch: null,
        roundNumber: b.round,
        media: { path: file, durationMs: cut.durationMs, frameRate: cut.fps, timebase: null, startPts: null, hasAudio: false, width: cut.width, height: cut.height },
        createdAt: new Date().toISOString(),
      }, { priority: playPriority(b.kind), playMs: Math.max(1000, Math.round(to - startsAt)), leadMs: Math.max(0, Math.round(kill - startsAt)), play });
      e.audit.record(req.principal!.label, "replay.feed_clip", item.id, { label: item.label, durationMs: cut.durationMs });
      return item;
    },
  );

  // ---- main PC: the replay feed (the replay PC's screen over NDI) -------------------------------
  r.get("/api/v1/replays/feed", { permission: "state.read" }, () => ({ settings: e.replayFeed.settings(), status: e.replayFeed.status() }));
  r.put("/api/v1/replays/feed", { permission: "settings.manage", body: FeedPatch }, (req) => {
    e.replayFeed.setSettings(req.body);
    e.audit.record(req.principal!.label, "replay.feed_settings", null, req.body);
    return { settings: e.replayFeed.settings(), status: e.replayFeed.status() };
  });
  r.post("/api/v1/replays/feed/sources", { permission: "settings.manage" }, async () => e.replayFeed.sources());
  r.post("/api/v1/replays/feed/ffmpeg", { permission: "settings.manage" }, async (req) => {
    const status = await e.ffmpeg.download();
    e.audit.record(req.principal!.label, "replay.ffmpeg_download", null, { ok: !status.error });
    if (status.error) throw new HttpError(502, status.error, "ffmpeg_download_failed");
    void e.replayFeed.restart();
    return status;
  });

  r.post("/api/v1/replays/incoming", { permission: "replay.control", maxBodyBytes: CLIP_MAX }, async (req) => {
    const q = req.query;
    const ext = String(q.get("ext") ?? "mp4").toLowerCase();
    if (!CLIP_EXT.has(ext)) throw new HttpError(400, `clip type .${ext} not accepted`, "bad_type");
    if (req.rawBody.length === 0) throw new HttpError(400, "empty clip", "bad_size");
    const kind = q.get("kind");
    if (kind !== "missed" && kind !== "other_angle" && kind !== "shown") throw new HttpError(400, "kind must be missed, other_angle or shown", "bad_kind");
    const num = (k: string) => (q.get(k) !== null && q.get(k) !== "" && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
    const killer = q.get("killer");
    const play: ReplayPlay = {
      kind,
      killer: killer ? { steamId: killer.slice(0, 32), name: String(q.get("killerName") ?? killer).slice(0, 64) } : null,
      victims: String(q.get("victims") ?? "").split("\n").filter(Boolean).slice(0, 5).map((v) => v.slice(0, 64)),
      kills: Math.max(1, Math.min(5, num("kills") ?? 1)),
      weapon: q.get("weapon") ? String(q.get("weapon")).slice(0, 40) : null,
      headshot: q.get("headshot") === "1",
    };
    const dir = e.replayDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `replaypc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    writeFileSync(file, req.rawBody);
    pruneClips(dir);
    const media = await probeMedia(file);
    const round = num("round");
    const playMs = num("playMs");
    const item = e.replays.addExternal(String(q.get("label") ?? replayLabel(play)).slice(0, 120), kind, round, {
      clipId: `clip_rp_${Date.now().toString(36)}`,
      providerId: "replay-pc",
      sourceId: "replay-pc",
      angle: "recorded_angle",
      matchTimeFromMs: null,
      matchTimeToMs: null,
      timeUncertaintyMs: null,
      epoch: null,
      roundNumber: round,
      media,
      createdAt: new Date().toISOString(),
    }, { priority: playPriority(kind), playMs: playMs !== null ? Math.max(1000, Math.min(60000, playMs)) : null, leadMs: num("leadMs"), play });
    e.audit.record(req.principal!.label, "replay.incoming", item.id, { label: item.label, bytes: req.rawBody.length });
    return item;
  });

  r.get("/api/v1/replays/auto", { permission: "state.read" }, () => ({ settings: e.autoReplay.settings(), status: e.autoReplay.getStatus() }));
  /** vMix as the replay mixer: does its Web Controller answer at the set address? */
  r.post("/api/v1/replays/vmix/test", { permission: "replay.control" }, async () => {
    await e.autoReplay.checkVmix();
    return e.autoReplay.getStatus().vmix ?? { connected: false, version: null, error: "vMix isn't the replay mixer" };
  });
  r.put("/api/v1/replays/auto", { permission: "replay.control", body: AutoReplayPatch }, (req) => {
    e.autoReplay.setSettings(req.body);
    e.audit.record(req.principal!.label, "replay.auto_settings", null, req.body);
    return { settings: e.autoReplay.settings(), status: e.autoReplay.getStatus() };
  });

  /**
   * One click: the replay scene and its media source in OBS, mapped for replays, and its twin (for
   * fading from one replay of a break to the next; replay/twin.ts).
   */
  r.post("/api/v1/replays/obs-setup", { permission: "settings.manage" }, async (req) => {
    if (!e.obs.state.connected) throw new HttpError(409, "connect OBS first (Settings → Devices)", "obs_not_connected");
    const scene = "Matchframe Replay";
    const input = "Matchframe Replay Clip";
    const made = await e.obs.ensureInput({ sceneName: scene, inputName: input, inputKind: "ffmpeg_source", settings: { is_local_file: true, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false } });
    const scenes = { ...e.program.sceneMap, REPLAY: scene, LIVE: e.program.sceneMap.LIVE ?? (e.obs.state.programScene !== scene ? e.obs.state.programScene : null) };
    e.settings.set("program.scenes", scenes);
    e.program.setScenes(scenes);
    e.settings.set("replay.mediaInput", input);
    const twin = await e.replayTwin.sync();
    e.audit.record(req.principal!.label, "replay.obs_setup", scene, { ...made, scenes, twin: twin?.scene ?? null });
    return { scene, input, created: made.created, scenes, twin: e.replayTwin.getStatus() };
  });

  // ---- replay PC: its link to the main PC -------------------------------------------------------
  r.get("/api/v1/replay-pc", { permission: "state.read" }, () => ({ settings: e.replayLink.settings(), hasToken: e.replayLink.hasToken(), status: e.replayLink.getStatus() }));
  r.put("/api/v1/replay-pc", { permission: "settings.manage", body: z.object({ enabled: z.boolean().optional(), mainUrl: z.string().max(200).optional(), token: z.string().max(200).nullable().optional(), preRollMs: ReplayPcSettings.shape.preRollMs.unwrap().optional(), postRollMs: ReplayPcSettings.shape.postRollMs.unwrap().optional(), sameCstv: ReplayPcSettings.shape.sameCstv.unwrap().optional(), behindMs: ReplayPcSettings.shape.behindMs.unwrap().optional(), filmAll: z.boolean().optional() }) }, (req) => {
    try {
      e.replayLink.setSettings(req.body);
    } catch (err) {
      throw new HttpError(400, `not a usable address: ${err instanceof Error ? err.message : String(err)}`, "bad_address");
    }
    e.audit.record(req.principal!.label, "replay_pc.settings", null, { ...req.body, token: req.body.token ? "(set)" : req.body.token });
    return { settings: e.replayLink.settings(), hasToken: e.replayLink.hasToken(), status: e.replayLink.getStatus() };
  });

  // ---- HUD graphics timed to the shots ---------------------------------------------------------
  r.get("/api/v1/graphics/auto", { permission: "state.read" }, () => e.graphics.settings());
  r.put("/api/v1/graphics/auto", { permission: "hud.publish", body: GraphicsPatch }, (req) => {
    const next = e.graphics.setSettings(req.body);
    e.audit.record(req.principal!.label, "graphics.auto_settings", null, req.body);
    return next;
  });

  // ---- OBS scene automation ----------------------------------------------------------------------
  // transitions: OBS's own, every transition's name, and their kinds (a Stinger is obs_stinger_transition).
  const transitionList = async () => {
    if (!e.obs.state.connected) return null;
    const t = await e.obs.transitionKinds().catch(() => null);
    return t ? { current: t.current, names: t.transitions.map((x) => x.name), kinds: t.transitions.map((x) => ({ name: x.name, kind: x.kind })) } : null;
  };
  r.get("/api/v1/obs/auto", { permission: "state.read" }, async () => ({ settings: e.obsAuto.settings(), scenes: e.program.sceneMap, replayScenes: e.program.replayScenes, transitions: await transitionList() }));
  r.put("/api/v1/obs/auto", { permission: "program.control", body: ObsAutoPatch }, (req) => {
    const next = e.obsAuto.setSettings(req.body);
    e.audit.record(req.principal!.label, "obs.auto_settings", null, req.body);
    return { settings: next, scenes: e.program.sceneMap, replayScenes: e.program.replayScenes, transitions: null };
  });

  // ---- this computer on the network --------------------------------------------------------------
  r.get("/api/v1/network", { permission: "settings.manage" }, () => {
    const host = e.cfg.host;
    const lan = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
    return { computer: hostname(), host, apiPort: e.cfg.apiPort, reachable: lan, addresses: lan ? lanAddresses() : [] };
  });
}

function pruneClips(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("replaypc-"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP_CLIPS)) rmSync(join(dir, old.f), { force: true });
}
