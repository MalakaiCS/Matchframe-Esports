import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { hlaeKeys } from "@matchframe/observer-agent";
import { HlaeCameraServer } from "../src/game/hlae-camera.ts";

type View = { x: number; y: number; z: number; rX: number; rY: number; rZ: number; fov?: number } | undefined;

/**
 * HLAE's script API as far as the Matchframe camera script uses it (mirv.events, connect_async with
 * the in/out streams, run_jobs), over a real WebSocket. Stand-in; logic tests only.
 */
function fakeMirv() {
  const hooks: { view?: (e: unknown) => View; frame?: (e: { curStage: number; isBefore: boolean }) => void } = {};
  const sockets: WebSocket[] = [];
  const mirv = {
    events: {
      cViewRenderSetupView: { on: (_id: string, cb: (e: unknown) => View) => (hooks.view = cb), off: () => (hooks.view = undefined) },
      clientFrameStageNotify: { on: (_id: string, cb: (e: { curStage: number; isBefore: boolean }) => void) => (hooks.frame = cb), off: () => (hooks.frame = undefined) },
    },
    connect_async: (url: string) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        sockets.push(ws);
        const inbox: string[] = [];
        let waiter: ((m: string | null) => void) | null = null;
        let closed = false;
        ws.on("message", (d) => {
          const m = String(d);
          if (waiter) {
            const w = waiter;
            waiter = null;
            w(m);
          } else inbox.push(m);
        });
        ws.on("close", () => {
          closed = true;
          if (waiter) {
            const w = waiter;
            waiter = null;
            w(null);
          }
        });
        ws.on("error", reject);
        ws.on("open", () =>
          resolve({
            in: { next: () => (inbox.length ? Promise.resolve(inbox.shift()!) : closed ? Promise.resolve(null) : new Promise<string | null>((r) => (waiter = r))), drop: () => undefined },
            out: { send: (m: string) => new Promise<void>((r) => ws.send(m, () => r())), close: async () => ws.close(), drop: () => undefined },
          }),
        );
      }),
    message: () => undefined,
    run_jobs: () => undefined,
    run_jobs_async: () => undefined,
  };
  return { mirv, hooks, sockets };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const servers: { http: Server; hlae: HlaeCameraServer }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.hlae.close();
    s.http.close();
  }
});

async function setup() {
  const db = new Database(":memory:");
  db.migrate();
  const http = createServer();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  const hlae = new HlaeCameraServer({ settings: new SettingsRepo(db), logger: { info: () => undefined, warn: () => undefined }, dataDir: mkdtempSync(join(tmpdir(), "mf-hlae-")), port: () => port, enabled: () => true });
  http.on("upgrade", (req, socket, head) => hlae.upgrade(req, socket, head));
  servers.push({ http, hlae });
  const load = hlae.loadCommand();
  const file = /^mirv_script_load "(.+)"$/.exec(load)![1]!;
  const script = readFileSync(file, "utf8");
  const { mirv, hooks, sockets } = fakeMirv();
  const ctx = vm.createContext({ mirv });
  vm.runInContext(script, ctx);
  // A game frame: messages are handled at the start of each tick, the view set before each frame is
  // drawn. As in HLAE's CS2 hook, absTime is the frame's length (CS2's absoluteframetime, seconds) and
  // curTime the game's clock.
  let cur = 100;
  let lastAbs = 0.016;
  const frame = (dtMs = 16): View => {
    hooks.frame!({ curStage: 0, isBefore: true });
    cur += dtMs / 1000;
    const view = hooks.view!({ absTime: dtMs / 1000, curTime: cur, lastAbsTime: lastAbs, currentView: { x: 1, y: 2, z: 3, rX: 0, rY: 0, rZ: 0, fov: 90 }, gameView: {}, lastView: {}, width: 1920, height: 1080 });
    lastAbs = dtMs / 1000;
    return view;
  };
  for (let i = 0; i < 100 && !hlae.connected(); i++) {
    frame();
    await tick();
  }
  return { hlae, frame, hooks, ctx, script, sockets, port, load, file };
}

describe("the HLAE camera script and the engine's /hlae connection", () => {
  it("connects, draws a shot every frame from its keys, holds the last one, and is released", async () => {
    const { hlae, frame, load, file } = await setup();
    expect(hlae.connected()).toBe(true);
    expect(load).toBe(`mirv_script_load "${file.replace(/\\/g, "/")}"`);
    expect(frame()).toBeUndefined(); // nothing to draw: CS2's own view
    const shown = hlae.play(
      [
        { t: 0, x: 0, y: 0, z: 100, pitch: 10, yaw: 350 },
        { t: 100, x: 100, y: 0, z: 100, pitch: 10, yaw: 370 },
      ],
      { timeoutMs: 2000 },
    );
    await tick();
    expect(frame(0)).toEqual({ x: 0, y: 0, z: 100, rX: 10, rY: 350, rZ: 0 });
    await tick();
    frame(0);
    expect(await shown).toEqual({ view: { x: 1, y: 2, z: 3, rX: 0, rY: 0, rZ: 0, fov: 90 } });
    const mid = frame(50)!;
    expect(mid.x).toBeCloseTo(50, 5);
    expect(mid.rY).toBeCloseTo(360, 5); // the short way round, through 360
    expect(frame(200)).toMatchObject({ x: 100, rY: 370 }); // held at the end
    expect(hlae.status()).toMatchObject({ connected: true, shots: 1 });
    // Live: the view eases towards each pose.
    hlae.live({ position: { x: 500, y: 0, z: 100 }, pitch: 10, yaw: 10 });
    await tick();
    const a = frame(16)!;
    const b = frame(16)!;
    expect(a.x).toBeGreaterThan(100);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.x).toBeLessThan(500);
    hlae.release();
    await tick();
    expect(frame()).toBeUndefined();
  });

  it("moves a 10 s glide frame by frame at the game's frame rate, to its end on time", async () => {
    const { hlae, frame } = await setup();
    // A team shot's glide: 300 units in 10 s, in keys as the engine sends them.
    const keys = hlaeKeys((t) => ({ position: { x: t * 0.03, y: 0, z: 100 }, pitch: 10, yaw: 0 }), 10_000);
    const shown = hlae.play(keys, { timeoutMs: 2000 });
    await tick();
    const xs: number[] = [frame(6.94)!.x];
    await shown;
    // 144 frames a second for just over 10 s.
    for (let i = 0; i < 1445; i++) xs.push(frame(6.94)!.x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(6.94 * 0.03, 3);
    const stuck = xs.map((x, i) => (i > 0 && !(x > xs[i - 1]!) && x !== 300 ? `${i}:${xs[i - 1]}->${x}` : null)).filter(Boolean);
    expect(stuck).toEqual([]);
    expect(xs[720]).toBeCloseTo(150, 0); // half way after 5 s
    expect(xs.at(-1)).toBe(300);
  });

  it("falls back to the wall clock where HLAE gives no frame length", async () => {
    const { hlae, hooks, ctx } = await setup();
    let now = 1_000_000;
    (ctx as { Date: { now: () => number } }).Date = { now: () => now };
    const shown = hlae.play(
      [
        { t: 0, x: 0, y: 0, z: 0, pitch: 0, yaw: 0 },
        { t: 1000, x: 1000, y: 0, z: 0, pitch: 0, yaw: 0 },
      ],
      { timeoutMs: 2000 },
    );
    await tick();
    const draw = () => {
      hooks.frame!({ curStage: 0, isBefore: true });
      return hooks.view!({ currentView: { x: 0, y: 0, z: 0, rX: 0, rY: 0, rZ: 0, fov: 90 } });
    };
    draw();
    await shown;
    now += 250;
    expect(draw()!.x).toBeCloseTo(250, 5);
    now += 500;
    expect(draw()!.x).toBeCloseTo(750, 5);
  });

  it("stops drawing the moment the program goes away, and turns away a wrong token", async () => {
    const { hlae, frame, port } = await setup();
    const shown = hlae.play([{ t: 0, x: 7, y: 7, z: 7, pitch: 0, yaw: 0 }], { timeoutMs: 2000 });
    await tick();
    expect(frame()).toMatchObject({ x: 7 });
    await shown;
    hlae.close();
    for (let i = 0; i < 20; i++) await tick();
    frame();
    expect(frame()).toBeUndefined();
    const bad = new WebSocket(`ws://127.0.0.1:${port}/hlae?token=nope`);
    const status = await new Promise<number>((r) => bad.on("unexpected-response", (_req, res) => r(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("replaces the running copy when loaded again", async () => {
    const { hlae, frame, ctx, script } = await setup();
    expect(hlae.status().connections).toBe(1);
    vm.runInContext(script, ctx);
    for (let i = 0; i < 100 && hlae.status().connections < 2; i++) {
      frame();
      await tick();
    }
    const shown = hlae.play([{ t: 0, x: 9, y: 9, z: 9, pitch: 0, yaw: 0 }], { timeoutMs: 2000 });
    for (let i = 0; i < 5; i++) {
      await tick();
      frame();
    }
    expect(await shown).not.toBeNull();
    expect(frame()).toMatchObject({ x: 9 });
  });

  it("gives up on a shot nobody draws (no script connected)", async () => {
    const db = new Database(":memory:");
    db.migrate();
    const hlae = new HlaeCameraServer({ settings: new SettingsRepo(db), logger: { info: () => undefined, warn: () => undefined }, dataDir: mkdtempSync(join(tmpdir(), "mf-hlae-")), port: () => 1, enabled: () => true });
    expect(hlae.connected()).toBe(false);
    expect(await hlae.play([{ t: 0, x: 0, y: 0, z: 0, pitch: 0, yaw: 0 }], { timeoutMs: 50 })).toBeNull();
    hlae.close();
  });
});

describe("loading the HLAE camera script into CS2", () => {
  it("sends mirv_script_load after the options each time the console connects in the HLAE mode", async () => {
    const { GameConsoleService, GameLaunchProfile } = await import("../src/game/console.ts");
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const written: string[] = [];
    let onConnect: (() => void) | null = null;
    const fakeConn = { port: 2121, connected: true, start: () => onConnect?.(), stop: () => undefined, onConnect: (cb: () => void) => (onConnect = cb), write: async (l: string) => void written.push(l) };
    const svc = new GameConsoleService({
      settings,
      teams: { get: () => null } as never,
      logger: { info: () => undefined, warn: () => undefined },
      connect: () => fakeConn as never,
      connectLines: (p) => (p.mode === "hlae" ? ['mirv_script_load "C:/data/hlae/matchframe-camera.js"'] : []),
    });
    svc.setProfile(GameLaunchProfile.parse({ mode: "hlae", netconPort: 2121, insecureAcknowledgedAt: new Date().toISOString() }));
    await tick(20);
    expect(written.at(-1)).toBe('mirv_script_load "C:/data/hlae/matchframe-camera.js"');
    expect(written.length).toBeGreaterThan(1); // the options first
    written.length = 0;
    svc.setProfile(GameLaunchProfile.parse({ mode: "tools", netconPort: 2122 }));
    await tick(20);
    expect(written.some((l) => l.startsWith("mirv_script_load"))).toBe(false);
  });
});
