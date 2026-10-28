import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyntheticPlayer } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Two programs, one game seen at two moments: the replay PC's game runs some seconds behind the
 * main PC's (a CSTV with more delay), or goes back when it rewinds. A stand-in plays the game on both
 * (game data every 100 ms with a running round clock) and the replay PC's camera follows its
 * director's pin, as CS2 does over the console.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Pc {
  e: Engine;
  servers: Awaited<ReturnType<typeof startServers>>;
  ports: { gsi: number; api: number; overlay: number };
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> }>;
  ts: number;
}

async function pc(name: string): Promise<Pc> {
  const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  const e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), `mf-${name}-`)), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
  await e.init();
  const servers = await startServers(e);
  const token = e.secrets.operatorToken;
  return {
    e,
    servers,
    ports,
    ts: 1_700_000_000,
    api: async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
  };
}

const roster = syntheticRoster();
const [T1, T2, , T4] = roster.filter((p) => p.side === "T");
const ct = (slot: number) => roster.find((p) => p.side === "CT" && p.slot === slot)!;
const CT6 = ct(6);
const CT7 = ct(7);
const CT8 = ct(8);
const CT9 = ct(9);
/** The game's kills, `at` ms into the round. Unless a test says otherwise: T4 kills CT9 at 4 s. */
const KILL_AT = 4000;
let script: { at: number; killer: SyntheticPlayer; victim: SyntheticPlayer }[] = [];
function playersAt(t: number): SyntheticPlayer[] {
  const done = script.filter((k) => k.at <= t);
  return roster.map((p) => {
    const kills = done.filter((k) => k.killer.steamId === p.steamId).length;
    const died = done.some((k) => k.victim.steamId === p.steamId);
    return { ...p, ...(kills ? { kills, roundKills: kills } : {}), ...(died ? { health: 0, deaths: 1 } : {}) };
  });
}

async function feed(p: Pc, t: number, observed: string) {
  const endsIn = Math.round((115 - t / 1000) * 10) / 10;
  const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", round: 7, players: playersAt(t), observed, roundPhase: "live", phase: "live", phaseEndsIn: endsIn, token: p.e.secrets.gsiToken, timestamp: p.ts++ });
  await fetch(`http://127.0.0.1:${p.ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) });
}

interface Clip {
  label: string;
  state: string;
  origin: string;
  playMs: number;
  roundNumber: number;
  play: { kind: string; kills: number };
}

describe("Replay PC behind the main PC, or rewinding to get there", () => {
  let main: Pc;
  let replay: Pc;
  let stop = false;
  /** How far the replay PC's game is behind (ms): fixed, or moved by demo_gototick. */
  let offset = 0;
  let t0 = 0;
  const written: string[] = [];
  const clipFile = join(mkdtempSync(join(tmpdir(), "mf-clip-")), "Replay.mkv");
  writeFileSync(clipFile, Buffer.alloc(32 * 1024, 7));

  async function setup(opts: { offsetMs: number; rewind?: boolean; consoleRefuses?: boolean; kills?: typeof script }) {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    script = opts.kills ?? [{ at: KILL_AT, killer: T4!, victim: CT9 }];
    main = await pc("main");
    replay = await pc("replay");
    offset = opts.offsetMs;
    stop = false;
    written.length = 0;
    Object.assign(replay.e.obs.state, { connected: true, replayBuffer: true });
    replay.e.obs.saveReplayBuffer = async () => ({ savedPath: clipFile });
    // The replay PC's CS2 console (a CSTV+ stream, unless it refuses demo commands).
    const lines = new Set<(l: string) => void>();
    const conn = {
      connected: true,
      write: async (line: string) => {
        written.push(line);
        const m = /^demo_gototick (-?\d+) 1$/.exec(line);
        if (opts.consoleRefuses) for (const fn of lines) fn("Error - Not currently playing back a demo.");
        else if (m) offset = Math.max(0, offset - (Number(m[1]) / 64) * 1000);
      },
      onLine: (fn: (l: string) => void) => {
        lines.add(fn);
        return () => lines.delete(fn);
      },
    };
    Object.defineProperty(replay.e.gameConsole, "connection", { get: () => conn, configurable: true });
    replay.e.session.setMode("automatic");
    const code = (await main.api("/api/v1/tokens", { method: "POST", body: { role: "replay", label: "Replay PC" } })).json as { token: string };
    const r = await replay.api("/api/v1/replay-pc", { method: "PUT", body: { enabled: true, mainUrl: `127.0.0.1:${main.ports.api}`, token: code.token, preRollMs: 2000, postRollMs: 500, rewind: opts.rewind ?? false } });
    expect(r.status).toBe(200);
    // The game runs: the main camera stays on T1; the replay PC's camera on CT6 unless its director is pinned.
    t0 = Date.now();
    void (async () => {
      while (!stop) {
        const t = Date.now() - t0;
        const pin = replay.e.session.director.controls.pin;
        await Promise.all([feed(main, t, T1!.steamId), t - offset >= 0 ? feed(replay, t - offset, pin?.kind === "player" ? pin.steamId : CT6.steamId) : Promise.resolve()]);
        await new Promise((res) => setTimeout(res, 100));
      }
    })();
  }

  afterEach(async () => {
    stop = true;
    await new Promise((r) => setTimeout(r, 200));
    for (const p of [replay, main]) {
      await p?.servers.close();
      await p?.e.shutdown();
    }
  });

  const status = async () => (await replay.api("/api/v1/replay-pc")).json.status as { timing: { state: string; delayMs: number | null }; rewind: { state: string; count: number; detail: string }; sent: number; skipped: number; lastSkip: { reason: string } | null; filming: string | null };
  const clips = async () => (await main.api("/api/v1/replays")).json.items as Clip[];

  it("3 s behind: knows the missed kill is coming, gets on the killer first and sends the clip", async () => {
    await setup({ offsetMs: 3000 });
    await waitFor(async () => (await status()).timing.state === "behind");
    expect(Math.abs((await status()).timing.delayMs! - 3000)).toBeLessThan(400);
    // The kill happens on the main PC at 4 s: on the replay PC it plays at 7 s, and the director is pinned to T4 before that.
    await waitFor(() => replay.e.session.director.controls.pin?.kind === "player");
    const pinnedAt = Date.now() - t0;
    expect(replay.e.session.director.controls.pin).toEqual({ kind: "player", steamId: T4!.steamId });
    expect(pinnedAt).toBeGreaterThan(KILL_AT);
    expect(pinnedAt).toBeLessThan(KILL_AT + 3000 - 1500);
    await waitFor(async () => (await clips()).length > 0);
    const clip = (await clips())[0]!;
    expect(clip).toMatchObject({ state: "prepared", origin: "replay_pc", roundNumber: main.e.session.state()!.roundNumber, play: { kind: "missed", kills: 1 } });
    expect(clip.label).toBe(`${T4!.name} ▸ ${CT9.name} (AK47)`);
    // From 2 s before the kill to 0.5 s after it.
    expect(clip.playMs).toBeGreaterThanOrEqual(2300);
    expect(clip.playMs).toBeLessThanOrEqual(2900);
    // The pin is released after the clip.
    expect(replay.e.session.director.controls.pin).toBeNull();
    expect((await status()).sent).toBe(1);
  }, 30000);

  it("two missed kills at once, one of them a 2K: films the 2K, even after starting on the other", async () => {
    // T2 kills CT7 at 4.0 s; T4 kills CT9 at 4.4 s and CT8 at 5.2 s. The main camera has T1 throughout.
    await setup({ offsetMs: 3000, kills: [{ at: 4000, killer: T2!, victim: CT7 }, { at: 4400, killer: T4!, victim: CT9 }, { at: 5200, killer: T4!, victim: CT8 }] });
    await waitFor(async () => (await status()).timing.state === "behind");
    // It starts on T2's kill (planned first) ...
    await waitFor(() => (replay.e.session.director.controls.pin as { steamId?: string } | null)?.steamId === T2!.steamId);
    // ... and switches to T4 once the second kill makes it a 2K.
    await waitFor(() => (replay.e.session.director.controls.pin as { steamId?: string } | null)?.steamId === T4!.steamId);
    await waitFor(async () => (await clips()).length > 0);
    await new Promise((r) => setTimeout(r, 1500));
    const all = await clips();
    expect(all).toHaveLength(1);
    expect(all[0]!).toMatchObject({ origin: "replay_pc", play: { kind: "missed", kills: 2 } });
    expect(all[0]!.label).toBe(`${T4!.name} ▸ ${CT9.name}, ${CT8.name} (AK47)`);
    const st = await status();
    expect(st.lastSkip?.reason).toBe(`${T4!.name}'s 2K is filmed instead`);
    expect(st.sent).toBe(1);
  }, 30000);

  it("live with rewinding on: goes back for a missed kill its camera didn't have, films it, and comes back to live", async () => {
    await setup({ offsetMs: 0, rewind: true });
    await waitFor(async () => (await status()).timing.state === "live");
    await waitFor(async () => (await status()).rewind.count === 1);
    expect(written[0]).toMatch(/^demo_gototick -\d+ 1$/);
    const back = (Number(/-(\d+)/.exec(written[0]!)![1]) / 64) * 1000;
    expect(back).toBeGreaterThanOrEqual(3000);
    await waitFor(async () => (await clips()).length > 0);
    const clip = (await clips())[0]!;
    expect(clip).toMatchObject({ origin: "replay_pc", play: { kind: "missed", kills: 1 } });
    expect(clip.label).toBe(`${T4!.name} ▸ ${CT9.name} (AK47)`);
    // The whole lead-up is in it: 2 s before the kill to 0.5 s after.
    expect(clip.playMs).toBeGreaterThanOrEqual(2300);
    // Then forward again, and live.
    await waitFor(async () => (await status()).rewind.state === "ready" && written.length === 2);
    expect(written[1]).toMatch(/^demo_gototick \d+ 1$/);
    await waitFor(async () => (await status()).timing.state === "live");
    expect(offset).toBeLessThan(1000);
  }, 30000);

  it("a CSTV connection that can't go back: says so and keeps filming someone else", async () => {
    await setup({ offsetMs: 0, rewind: true, consoleRefuses: true });
    await waitFor(async () => (await status()).rewind.state === "unsupported");
    expect((await status()).rewind.detail).toMatch(/CSTV\+/);
    expect(written).toHaveLength(1);
    expect(await clips()).toHaveLength(0);
  }, 30000);
});
