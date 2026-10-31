import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipRecord, QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Overview {
  folders: { replays: string | null; highlights: string | null };
  where: { replayClips: string; replayFeed: string; keptClips: string; reels: string };
  free: { replays: number | null; highlights: number | null };
}

/**
 * Storage (the owner: highlights "on a separate drive instead of going into the C drive"): replay
 * clips, the replay feed's recording, kept highlight clips and reels go to chosen folders; clips
 * already kept stay usable where they are; a folder Matchframe can't use is refused.
 */
describe("Storage folders for replays and highlights", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let auth: Record<string, string>;
  const data = mkdtempSync(join(tmpdir(), "mf-storage-data-"));
  const src = mkdtempSync(join(tmpdir(), "mf-storage-src-"));
  const driveA = mkdtempSync(join(tmpdir(), "mf-storage-a-"));
  const driveB = mkdtempSync(join(tmpdir(), "mf-storage-b-"));
  const roster = syntheticRoster();
  const killer = roster.find((p) => p.side === "T")!;

  const call = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${api}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const played = (name: string): QueueItem => {
    const path = join(src, name);
    writeFileSync(path, "not really a video");
    const clip: ClipRecord = { clipId: `c${name}`, providerId: "replay-pc", sourceId: "replay-pc", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: 3, media: { path, durationMs: 4000, frameRate: null, timebase: null, startPts: null, hasAudio: null, width: null, height: null }, createdAt: new Date().toISOString() };
    const play: ReplayPlay = { kind: "missed", killer: { steamId: killer.steamId, name: killer.name }, victims: ["v"], kills: 1, weapon: "ak47", headshot: false };
    const it = e.replays.addExternal(`1K ${killer.name}`, "missed", 3, clip, { play });
    e.replays.approve(it.id);
    e.replays.markPlaying(it.id);
    e.replays.markPlayed(it.id);
    return it;
  };
  const kept = (id: string) => e.highlights.current()?.clips.find((c) => c.id === id) ?? null;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    e = new Engine(loadConfig({ dataDir: data, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    api = `http://127.0.0.1:${ports.api}`;
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    const payload = buildSyntheticGsiPayload({ mapName: "de_mirage", round: 2, players: roster, observed: roster[0]!.steamId, roundPhase: "live", phase: "live", phaseEndsIn: 40, token: e.secrets.gsiToken, timestamp: 1_700_000_000, ctName: "Northern Lights", tName: "Red Harbour" });
    expect((await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("uses the data folder until another is chosen", async () => {
    const r = await call<Overview>("GET", "/api/v1/storage");
    expect(r.status).toBe(200);
    expect(r.body.folders).toEqual({ replays: null, highlights: null });
    expect(r.body.where.replayClips).toBe(join(data, "replays"));
    expect(r.body.where.replayFeed).toBe(join(data, "replay-feed"));
    expect(r.body.where.keptClips).toBe(join(data, "highlights", "clips"));
    expect(r.body.where.reels).toBe(join(data, "exports", "highlights"));
    expect(typeof r.body.free.replays).toBe("number");
  });

  it("refuses a folder that isn't a full path, or can't be written", async () => {
    expect((await call("PUT", "/api/v1/storage", { highlights: "relative/folder" })).status).toBe(400);
    const file = join(src, "a-file");
    writeFileSync(file, "x");
    expect((await call("PUT", "/api/v1/storage", { replays: join(file, "inside") })).status).toBe(400);
    expect(e.storageFolders()).toEqual({ replays: null, highlights: null });
  });

  it("writes new replays and highlights to the chosen folders; clips kept before stay usable", async () => {
    e.highlights.tick();
    const before = played("before.mp4");
    e.highlights.tick();
    const k1 = kept(before.id)!;
    expect(k1).not.toBeNull();
    expect(e.highlights.filePath(k1).startsWith(join(data, "highlights", "clips"))).toBe(true);

    const r = await call<Overview>("PUT", "/api/v1/storage", { replays: driveA, highlights: driveB });
    expect(r.status).toBe(200);
    expect(r.body.where.replayClips).toBe(join(driveA, "replays"));
    expect(r.body.where.replayFeed).toBe(join(driveA, "replay-feed"));
    expect(r.body.where.keptClips).toBe(join(driveB, "Kept clips"));
    expect(r.body.where.reels).toBe(driveB);
    expect(e.replayDir()).toBe(join(driveA, "replays"));

    const after = played("after.mp4");
    e.highlights.tick();
    const k2 = kept(after.id)!;
    expect(e.highlights.filePath(k2).startsWith(join(driveB, "Kept clips"))).toBe(true);
    expect(existsSync(e.highlights.filePath(k2))).toBe(true);
    // The clip kept before the change is still where it was, and still in the map's clips.
    expect(existsSync(e.highlights.filePath(kept(before.id)!))).toBe(true);
  });

  it("still deletes clips of an earlier replay folder when they drop off the queue", async () => {
    expect(e.isReplayFile(join(data, "replays", "replaypc-x.mp4"))).toBe(true);
    expect(e.isReplayFile(join(driveA, "replays", "replaypc-y.mp4"))).toBe(true);
    expect(e.isReplayFile(join(src, "elsewhere.mp4"))).toBe(false);
  });

  it("goes back to the defaults", async () => {
    const r = await call<Overview>("PUT", "/api/v1/storage", { replays: null, highlights: null });
    expect(r.body.where.replayClips).toBe(join(data, "replays"));
    expect(r.body.where.reels).toBe(join(data, "exports", "highlights"));
  });
});
