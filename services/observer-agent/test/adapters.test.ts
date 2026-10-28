import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import type { CameraPath, CommandContext } from "@matchframe/contracts";
import { aimAt, glideMotion, panMotion, teamCamera } from "@matchframe/director-policy";
import { accountIdOf, KeyboardObserverAdapter, NetconObserverAdapter, safeName, samplePath, slotKey } from "../src/index.ts";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  commandId: "c1",
  sessionId: "s",
  epoch: 1,
  owner: "director",
  ownershipGeneration: 1,
  decisionId: null,
  basedOnSequence: null,
  issuedAtMonotonicMs: 0,
  expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER,
  confirmationTimeoutMs: 1000,
  ...over,
});

describe("account id conversion", () => {
  it("uses exact integer math for SteamID64", () => {
    expect(accountIdOf("76561198000000001")).toBe("39734273");
    expect(accountIdOf("76561197960265729")).toBe("1");
  });
});

describe("KeyboardObserverAdapter", () => {
  it("A14: sends no input when the observer window is not focused", async () => {
    const pressed: string[] = [];
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => "Notepad", pressKey: (k) => (pressed.push(k), true) }, { windowTitle: /^Counter-Strike 2$/, now: () => 0 });
    const r = await a.selectPlayer("7656", 3, ctx());
    expect(r.failureReason).toBe("window_not_focused");
    expect(pressed).toEqual([]);
  });

  it("sends the validated slot key only to the focused observer window, as transport-only", async () => {
    const pressed: string[] = [];
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => "Counter-Strike 2", pressKey: (k) => (pressed.push(k), true) }, { windowTitle: /^Counter-Strike 2$/, now: () => 0 });
    const r = await a.selectPlayer("7656", 0, ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(r.precision).toBe("transport_only");
    expect(pressed).toEqual(["0"]);
    expect((await a.selectPlayer("7656", null, ctx())).failureReason).toBe("target_invalid");
    expect(slotKey(12)).toBeNull();
  });

  it("reports unverified selection control and no camera control", async () => {
    const a = new KeyboardObserverAdapter({ foregroundWindowTitle: () => null, pressKey: () => true }, { windowTitle: /x/, now: () => 0 });
    const c = await a.getCapabilities();
    expect(c.playerSelectionControl.support).toBe("unverified");
    expect(c.staticCameraControl.support).toBe("unsupported");
  });
});

describe("NetconObserverAdapter", () => {
  it("writes the templated command over TCP and treats it as transport-only; never injects", async () => {
    const received: string[] = [];
    const server = createServer((sock) => sock.on("data", (d) => received.push(...d.toString().split("\n").filter(Boolean))));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0, playerName: () => "nova" });
    const r = await a.selectPlayer("76561198000000001", 1, ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(r.precision).toBe("transport_only");
    const cam = await a.activateStaticCamera(
      { id: "c", position: { x: 1.234, y: -5, z: 10 }, pitch: 12, yaw: 90 } as never,
      ctx(),
    );
    expect(cam.status).toBe("transport_acknowledged");
    await new Promise((r) => setTimeout(r, 50));
    expect(received[0]).toBe('spec_player "nova"');
    expect(received[1]).toContain("spec_goto 1.23 -5 10 12 90");
    const caps = await a.getCapabilities();
    expect(caps.playerSelectionControl.support).toBe("unverified");
    expect(caps.staticCameraControl.support).toBe("unverified");
    const bad = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0, templates: { selectPlayer: "spec_player {steamId}" } });
    // A malicious steamId value can never smuggle extra commands.
    expect((await bad.selectPlayer("1; quit", null, ctx())).failureReason).not.toBe(null);
    await a.dispose();
    await bad.dispose();
    server.close();
  });

  it("selects by in-game name only when the name is known and safe to quote", async () => {
    const received: string[] = [];
    const server = createServer((sock) => sock.on("data", (d) => received.push(...d.toString().split("\n").filter(Boolean))));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const id = (n: number) => `7656119800000000${n}`;
    const names: Record<string, string | null> = { [id(1)]: "Sam O'Neil", [id(2)]: 'x"; quit', [id(3)]: "evil;quit", [id(4)]: "line\nbreak", [id(5)]: "back\\slash", [id(6)]: null };
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0, playerName: (steamId) => names[steamId] ?? null });
    expect((await a.selectPlayer(id(1), 1, ctx())).status).toBe("transport_acknowledged");
    for (const n of [2, 3, 4, 5, 6]) {
      const r = await a.selectPlayer(id(n), 2, ctx());
      expect([n, r.status, r.failureReason]).toEqual([n, "failed", "target_invalid"]);
    }
    // The slot form still works for operators who change the template.
    const bySlot = new NetconObserverAdapter({ host: "127.0.0.1", port, now: () => 0, templates: { selectPlayer: "spec_player {slot}" } });
    expect((await bySlot.selectPlayer("76561198000000001", 7, ctx())).status).toBe("transport_acknowledged");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(['spec_player "Sam O\'Neil"', "spec_player 7"]);
    expect((await a.getCapabilities()).playerSelectionControl.limitations.join(" ")).toMatch(/in-game name/);
    expect(safeName("  nova  ")).toBe("nova");
    await a.dispose();
    await bySlot.dispose();
    server.close();
  });

  it("fails cleanly when the console port is closed", async () => {
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: 1, now: () => 0, connectTimeoutMs: 300, playerName: () => "nova" });
    const r = await a.selectPlayer("76561198000000001", 1, ctx());
    expect(r.status).toBe("failed");
    expect(r.failureReason).toBe("transport_error");
  });
});

/**
 * A stand-in CS2 console: applies `spec_mode`/`spec_goto` to a spectator camera and answers
 * `getpos` the way CS2 does. `freeMode` is the spec_mode number that enters the free camera on this
 * "build"; spec_goto only moves the camera when it is in the free camera.
 */
async function fakeCs2Console(freeMode: number) {
  const lines: string[] = [];
  let mode = 4;
  const cam = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
  const server = createServer((sock) =>
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        lines.push(line);
        for (const cmd of line.split(";").map((c) => c.trim())) {
          const m = /^spec_mode (\d+)$/.exec(cmd);
          if (m) mode = Number(m[1]);
          const g = /^spec_goto (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(cmd);
          if (g && mode === freeMode) Object.assign(cam, { x: Number(g[1]), y: Number(g[2]), z: Number(g[3]), pitch: Number(g[4]), yaw: Number(g[5]) });
          if (cmd === "getpos") sock.write(`setpos ${cam.x.toFixed(6)} ${cam.y.toFixed(6)} ${cam.z.toFixed(6)};setang ${cam.pitch.toFixed(6)} ${cam.yaw.toFixed(6)} 0.000000\n`);
        }
      }
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { lines, server, port: (server.address() as { port: number }).port };
}

/**
 * A console whose free camera and first person are the spec_mode numbers given (6 and 2: the free
 * camera from CS:GO's numbering, first person from CS2's), with game data following the camera:
 * spec_player only reaches the player from first person.
 */
async function numberedCs2(free = 6, inEye = 2) {
  const lines: string[] = [];
  const game = { mode: inEye, observed: "76561198000000001" as string | null };
  const server = createServer((sock) =>
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        lines.push(line);
        for (const cmd of line.split(";").map((c) => c.trim())) {
          const m = /^spec_mode (\d+)$/.exec(cmd);
          if (m) game.mode = Number(m[1]);
          if (/^spec_goto /.test(cmd) && game.mode === free) game.observed = null;
          if (/^spec_player /.test(cmd) && game.mode === inEye) game.observed = "76561198000000002";
          if (cmd === "getpos") sock.write("setpos 1200.500000 -340.000000 256.000000;setang 18.000000 -135.000000 0.000000\n");
        }
      }
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { lines, game, server, port: (server.address() as { port: number }).port };
}

const camera = (over: Record<string, unknown> = {}) => ({ id: "cam-a", position: { x: 1200.5, y: -340, z: 256 }, pitch: 18, yaw: -135, ...over }) as never;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Game data every 100 ms showing what the game showed `lagMs` earlier (CS2's lags its console). */
function gameData(a: NetconObserverAdapter, game: { observed: string | null }, lagMs = 0) {
  const past: { at: number; observed: string | null }[] = [];
  return setInterval(() => {
    const now = performance.now();
    past.push({ at: now, observed: game.observed });
    const seen = [...past].reverse().find((p) => p.at <= now - lagMs) ?? past[0]!;
    a.noteObserverState({ cameraMode: seen.observed ? "unknown" : "roaming", observedSteamId: seen.observed });
  }, 100);
}

describe("leaving the free camera", () => {
  it("tries the other in-eye spec_mode when the game data still shows the free camera 2 s on, and keeps the one that works", async () => {
    const c = await numberedCs2();
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    const feed = gameData(a, c.game);
    expect((await a.activateStaticCamera(camera(), ctx())).status).toBe("confirmed");
    await a.selectPlayer("76561198000000002", 2, ctx());
    // The director tries again after each confirmation timeout: the same command for the first 2 s.
    await sleep(1600);
    await a.selectPlayer("76561198000000002", 2, ctx());
    await sleep(600);
    await a.selectPlayer("76561198000000002", 2, ctx());
    for (let i = 0; i < 40 && !learned.length; i++) await sleep(50);
    clearInterval(feed);
    expect(c.lines.filter((l) => l === 'spec_mode 4; spec_player "nova"')).toHaveLength(2);
    expect(c.lines).toContain('spec_mode 2; spec_player "nova"');
    expect(learned).toEqual([{ modeInEye: "spec_mode 2", modeChase: "spec_mode 3", modeRoaming: "spec_mode 6" }]);
    expect(c.game.observed).toBe("76561198000000002");
    await a.dispose();
    c.server.close();
  });

  it("leaves the free camera even when game data from before the camera still shows the old player", async () => {
    const c = await numberedCs2(6, 4);
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova" });
    // The game data is a quarter of a second behind the console.
    const feed = gameData(a, c.game, 250);
    await sleep(300);
    expect((await a.activateStaticCamera(camera(), ctx())).status).toBe("confirmed");
    // Straight back to a player, while the game data still shows the one from before the camera.
    await a.selectPlayer("76561198000000002", 2, ctx());
    for (let i = 0; i < 20 && !c.lines.some((l) => /spec_player/.test(l)); i++) await sleep(25);
    clearInterval(feed);
    expect(c.lines.filter((l) => /spec_player/.test(l))).toEqual(['spec_mode 4; spec_player "nova"']);
    expect(c.game.observed).toBe("76561198000000002");
    await a.dispose();
    c.server.close();
  });

  it("never changes a working in-eye spec_mode because the game data is slow to show the player", async () => {
    const c = await numberedCs2(6, 4);
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    const feed = gameData(a, c.game, 700);
    await sleep(800);
    expect((await a.activateStaticCamera(camera(), ctx())).status).toBe("confirmed");
    await sleep(2000);
    await a.selectPlayer("76561198000000002", 2, ctx());
    await sleep(1600);
    // A retry before the game data caught up: still the same command.
    await a.selectPlayer("76561198000000002", 2, ctx());
    await sleep(1500);
    clearInterval(feed);
    expect(c.lines.filter((l) => /spec_player/.test(l))).toEqual(['spec_mode 4; spec_player "nova"', 'spec_player "nova"']);
    expect(learned).toEqual([]);
    await a.dispose();
    c.server.close();
  });

  it("corrects an in-eye spec_mode saved wrongly earlier", async () => {
    const c = await numberedCs2(6, 4);
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova", templates: { modeInEye: "spec_mode 2", modeChase: "spec_mode 3" }, onModesLearned: (m) => learned.push(m) });
    const feed = gameData(a, c.game);
    expect((await a.activateStaticCamera(camera(), ctx())).status).toBe("confirmed");
    await a.selectPlayer("76561198000000002", 2, ctx());
    await sleep(2100);
    await a.selectPlayer("76561198000000002", 2, ctx());
    for (let i = 0; i < 40 && !learned.length; i++) await sleep(50);
    clearInterval(feed);
    expect(c.lines).toContain('spec_mode 4; spec_player "nova"');
    expect(learned).toEqual([{ modeInEye: "spec_mode 4", modeChase: "spec_mode 5", modeRoaming: "spec_mode 6" }]);
    await a.dispose();
    c.server.close();
  });
});

/**
 * A console whose free camera (spec_mode 6) behaves like CS2's: spec_goto moves it, and +left/+right
 * (CS2's strafe keys, not turning) slide it sideways at 400 units a second while held.
 */
async function freeCamCs2() {
  const lines: { at: number; line: string }[] = [];
  const cam = { mode: 4, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, strafe: 0, since: 0 };
  const xNow = () => cam.x + cam.strafe * 400 * ((performance.now() - cam.since) / 1000);
  const server = createServer((sock) =>
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        lines.push({ at: performance.now(), line });
        for (const cmd of line.split(";").map((c) => c.trim())) {
          const m = /^spec_mode (\d+)$/.exec(cmd);
          if (m) cam.mode = Number(m[1]);
          const g = /^spec_goto (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(cmd);
          if (g && cam.mode === 6) Object.assign(cam, { x: Number(g[1]), y: Number(g[2]), z: Number(g[3]), pitch: Number(g[4]), yaw: Number(g[5]), since: performance.now() });
          if (/^[+-](left|right)$/.test(cmd)) {
            cam.x = xNow();
            cam.since = performance.now();
            cam.strafe = cmd === "+left" ? -1 : cmd === "+right" ? 1 : 0;
          }
          if (cmd === "getpos") sock.write(`setpos ${xNow().toFixed(6)} ${cam.y.toFixed(6)} ${cam.z.toFixed(6)};setang ${cam.pitch.toFixed(6)} ${cam.yaw.toFixed(6)} 0.000000\n`);
        }
      }
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const gotos = () => lines.filter((l) => /^spec_goto /.test(l.line)).map((l) => ({ at: l.at, v: l.line.split(" ").slice(1).map(Number) }));
  return { lines, cam, xNow, gotos, server, port: (server.address() as { port: number }).port };
}

describe("smooth camera motion", () => {
  it("turns a freeze-time camera by sending its poses, centred on its aim, never with +left/+right (they strafe in CS2)", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova" });
    // 3° a second for 10 s: starts 15° to the right of the camera's aim (-135°).
    const r = await a.activateStaticCamera(camera(), ctx(), panMotion(camera(), 3, 10000));
    expect(r.status).toBe("confirmed");
    expect(c.lines.map((l) => l.line)).toContain("spec_mode 6; spec_goto 1200.5 -340 256 18 -150");
    await sleep(1500);
    // Turning about 3° a second, the camera where it was put.
    expect(c.cam.yaw).toBeGreaterThan(-150 + 3);
    expect(c.cam.yaw).toBeLessThan(-150 + 6);
    expect(c.xNow()).toBe(1200.5);
    expect(c.lines.filter((l) => /[+-](left|right)|cl_yawspeed/.test(l.line))).toEqual([]);
    // About 64 poses a second, waiting on timers between them.
    const recent = c.gotos().filter((g) => g.at > performance.now() - 1000);
    expect(recent.length).toBeGreaterThan(40);
    expect(recent.length).toBeLessThan(75);
    await a.selectPlayer("76561198000000002", 2, ctx());
    await sleep(100);
    const after = c.lines.slice(c.lines.findIndex((l) => /spec_player/.test(l.line)) + 1);
    expect(after.filter((l) => /spec_goto/.test(l.line))).toEqual([]);
    await a.dispose();
    c.server.close();
  });

  it("stops at the end of the shot's planned length and stays there", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now() });
    await a.activateStaticCamera(camera(), ctx(), panMotion(camera(), -4, 1200));
    await sleep(1600);
    const g = c.gotos();
    // From 2.4° left of the aim to 2.4° right of it.
    expect(g[0]!.v[4]).toBeCloseTo(-132.6, 1);
    expect(g.at(-1)!.v[4]).toBeCloseTo(-137.4, 1);
    expect(performance.now() - g.at(-1)!.at).toBeGreaterThan(250);
    await a.dispose();
    c.server.close();
  });

  it("glides a team shot round the team, always looking at it", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now() });
    const focus = { x: 0, y: 0, z: 40 };
    const move = { from: { x: 400, y: 0, z: 150 }, to: { x: 400 * Math.cos(0.17), y: 400 * Math.sin(0.17), z: 150 }, focus };
    const r = await a.activateStaticCamera(teamCamera("T", "m", move, 1000), ctx(), glideMotion(move, 1000));
    expect(r.status).toBe("confirmed");
    await sleep(1300);
    const g = c.gotos();
    expect(g.length).toBeGreaterThan(30);
    for (const { v } of g) {
      const [x, y, z, pitch, yaw] = v as [number, number, number, number, number];
      expect(Math.hypot(x, y)).toBeCloseTo(400, 0);
      expect(z).toBe(150);
      const aim = aimAt({ x, y, z }, focus);
      expect(Math.abs(pitch - aim.pitch)).toBeLessThan(0.05);
      expect(Math.abs(((yaw - aim.yaw + 540) % 360) - 180)).toBeLessThan(0.05);
    }
    expect(g.at(-1)!.v[1]).toBeCloseTo(400 * Math.sin(0.17), 0);
    await a.dispose();
    c.server.close();
  });

  it("doesn't start a move when another command came while the camera was being confirmed", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now(), playerName: () => "nova" });
    const shown = a.activateStaticCamera(camera(), ctx(), panMotion(camera(), 3, 5000));
    // Before its getpos check (60 ms after the command): a player.
    await sleep(20);
    await a.selectPlayer("76561198000000002", 2, ctx());
    await shown;
    await sleep(300);
    expect(c.lines.filter((l) => /^spec_goto /.test(l.line))).toEqual([]);
    await a.dispose();
    c.server.close();
  });

  it("shows a still team shot with one command", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now() });
    const move = { from: { x: 400, y: 0, z: 150 }, to: { x: 400, y: 0, z: 150 }, focus: { x: 0, y: 0, z: 40 } };
    expect((await a.activateStaticCamera(teamCamera("CT", "m", move, 60000), ctx(), glideMotion(move, 60000))).status).toBe("confirmed");
    await sleep(400);
    expect(c.lines.map((l) => l.line).filter((l) => /spec_goto/.test(l))).toEqual(["spec_mode 6; spec_goto 400 0 150 15.38 -180"]);
    await a.dispose();
    c.server.close();
  });

  it("sends a camera path's poses evenly, about 128 a second", async () => {
    const c = await freeCamCs2();
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => performance.now() });
    const p = {
      id: "push",
      displayName: "push",
      mapName: "m",
      mapRevision: "r",
      keyframes: [
        { tMs: 0, position: { x: 0, y: 0, z: 200 }, pitch: 20, yaw: 0 },
        { tMs: 1500, position: { x: 300, y: 0, z: 200 }, pitch: 20, yaw: 30 },
      ],
      maxDurationMs: 2000,
      maxSpeedUnitsPerSec: 300,
      collisionValidated: false,
      validation: "unvalidated",
      targetRegionIds: [],
    } satisfies CameraPath;
    await a.playCameraPath(p, ctx());
    await sleep(1800);
    const t = c.lines.filter((l) => /^spec_goto /.test(l.line)).map((l) => l.at);
    const gaps = t.slice(1).map((x, i) => x - t[i]!).sort((x, y) => x - y);
    const q = (f: number) => gaps[Math.floor(f * (gaps.length - 1))]!;
    expect(t.length).toBeGreaterThan(150);
    expect(q(0.5)).toBeGreaterThan(6);
    expect(q(0.5)).toBeLessThan(10);
    expect(q(0.95)).toBeLessThan(14);
    await a.dispose();
    c.server.close();
  });
});

describe("camera paths", () => {
  const path = {
    id: "p",
    keyframes: [
      { tMs: 0, position: { x: 0, y: 0, z: 100 }, pitch: 10, yaw: 170 },
      { tMs: 1000, position: { x: 100, y: 0, z: 100 }, pitch: 12, yaw: -170 },
      { tMs: 2000, position: { x: 100, y: 100, z: 120 }, pitch: 14, yaw: -150 },
    ],
  };

  it("samples keyframes exactly at the ends, smoothly between, and turns the short way round", () => {
    expect(samplePath(path, 0)).toMatchObject({ position: { x: 0, y: 0, z: 100 }, pitch: 10, yaw: 170 });
    const end = samplePath(path, 2000);
    expect([end.position.x, end.position.y, end.position.z, end.pitch, end.yaw]).toEqual([100, 100, 120, 14, -150]);
    // Eased: barely moved after 5 % of the time.
    expect(samplePath(path, 100).position.x).toBeLessThan(5);
    // 170° → -170° crosses 180°, not 0°.
    const mid = samplePath(path, 700);
    expect(Math.abs(mid.yaw)).toBeGreaterThan(160);
    let prev = samplePath(path, 0).position;
    for (let t = 50; t <= 2000; t += 50) {
      const p = samplePath(path, t).position;
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThan(15);
      prev = p;
    }
  });
});

describe("NetconObserverAdapter cameras on a stand-in CS2 console", () => {
  it("confirms a static camera with getpos, reports the evidence and goes back to in-eye before a player", async () => {
    const c = await fakeCs2Console(6);
    const evidence: string[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onEvidence: (k, s) => evidence.push(`${k}:${s}`) });
    const r = await a.activateStaticCamera(camera(), ctx());
    expect([r.status, r.precision]).toEqual(["confirmed", "observed_exact"]);
    expect(c.lines[0]).toBe("spec_mode 6; spec_goto 1200.5 -340 256 18 -135");
    expect(evidence).toEqual(["staticCameraControl:supported", "cameraReadback:supported", "observerModeControl:partial"]);
    expect((await a.selectPlayer("76561198000000001", 1, ctx())).status).toBe("transport_acknowledged");
    await new Promise((res) => setTimeout(res, 50));
    expect(c.lines.at(-1)).toBe('spec_mode 4; spec_player "nova"');
    // Back on a player: no mode change needed next time.
    await a.selectPlayer("76561198000000001", 1, ctx());
    await new Promise((res) => setTimeout(res, 50));
    expect(c.lines.at(-1)).toBe('spec_player "nova"');
    await a.dispose();
    c.server.close();
  });

  it("learns the CS2 spec_mode numbering when the CS:GO numbers don't move the camera", async () => {
    const c = await fakeCs2Console(4);
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    const r = await a.activateStaticCamera(camera(), ctx());
    expect(r.status).toBe("confirmed");
    expect(learned).toEqual([{ modeInEye: "spec_mode 2", modeChase: "spec_mode 3", modeRoaming: "spec_mode 4" }]);
    expect(c.lines.filter((l) => l.includes("spec_goto"))).toEqual(["spec_mode 6; spec_goto 1200.5 -340 256 18 -135", "spec_mode 4; spec_goto 1200.5 -340 256 18 -135"]);
    await a.selectPlayer("76561198000000001", 1, ctx());
    await new Promise((res) => setTimeout(res, 50));
    expect(c.lines.at(-1)).toBe('spec_mode 2; spec_player "nova"');
    await a.dispose();
    c.server.close();
  });

  it("leaves a camera it can't confirm as transport-only (the game data may still confirm it)", async () => {
    const c = await fakeCs2Console(9);
    const evidence: string[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, onEvidence: (k) => evidence.push(k), readbackTimeoutMs: 200 });
    const r = await a.activateStaticCamera(camera(), ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(evidence).toEqual([]);
    await a.dispose();
    c.server.close();
  });

  it("streams a camera path as spec_goto frames and confirms where it ended", async () => {
    const c = await fakeCs2Console(6);
    const evidence: string[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, pathHz: 50, onEvidence: (k) => evidence.push(k) });
    const p = {
      id: "orbit",
      displayName: "A site orbit",
      mapName: "de_dust2",
      mapRevision: "r",
      keyframes: [
        { tMs: 0, position: { x: 0, y: 0, z: 200 }, pitch: 20, yaw: 0 },
        { tMs: 400, position: { x: 200, y: 0, z: 200 }, pitch: 20, yaw: 45 },
      ],
      maxDurationMs: 1400,
      maxSpeedUnitsPerSec: 300,
      collisionValidated: false,
      validation: "unvalidated",
      targetRegionIds: [],
    } satisfies CameraPath;
    const r = await a.playCameraPath(p, ctx());
    expect(r.status).toBe("transport_acknowledged");
    expect(a.playingPath).toBe(true);
    for (let i = 0; i < 40 && !evidence.includes("cameraPathControl"); i++) await new Promise((res) => setTimeout(res, 50));
    expect(evidence).toContain("cameraPathControl");
    expect(a.playingPath).toBe(false);
    const frames = c.lines.filter((l) => l.startsWith("spec_goto"));
    expect(frames.length).toBeGreaterThan(8);
    expect(frames.at(-1)).toBe("spec_goto 200 0 200 20 45");
    await a.dispose();
    c.server.close();
  });

  it("stops a playing path when a player is selected", async () => {
    const c = await fakeCs2Console(6);
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova" });
    const long = { id: "x", displayName: "x", mapName: "m", mapRevision: "r", keyframes: [{ tMs: 0, position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0 }, { tMs: 60000, position: { x: 1, y: 0, z: 0 }, pitch: 0, yaw: 0 }], maxDurationMs: 61000, maxSpeedUnitsPerSec: 300, collisionValidated: false, validation: "unvalidated", targetRegionIds: [] } satisfies CameraPath;
    await a.playCameraPath(long, ctx());
    expect(a.playingPath).toBe(true);
    await a.selectPlayer("76561198000000001", 1, ctx());
    expect(a.playingPath).toBe(false);
    await a.dispose();
    c.server.close();
  });
});

/** A console where getpos is the player's eyes in first person and 100 units behind them in the chase view. */
async function chaseCs2(chaseMode: number) {
  const lines: string[] = [];
  const player = { x: 1000, y: 200, z: 0 };
  let mode = 4;
  const server = createServer((sock) =>
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        lines.push(line);
        for (const cmd of line.split(";").map((c) => c.trim())) {
          const m = /^spec_mode (\d+)$/.exec(cmd);
          if (m) mode = Number(m[1]);
          const back = mode === chaseMode ? 100 : 0;
          if (cmd === "getpos") sock.write(`setpos ${(player.x - back).toFixed(6)} ${player.y.toFixed(6)} ${(player.z + 64).toFixed(6)};setang 10.000000 0.000000 0.000000\n`);
        }
      }
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { lines, player, server, port: (server.address() as { port: number }).port };
}

describe("chase view", () => {
  const id = "76561198000000001";
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 80 && !ok(); i++) await new Promise((res) => setTimeout(res, 25));
  };

  it("sets the chase view after the player, confirms it with getpos and goes back to first person", async () => {
    const c = await chaseCs2(5);
    const evidence: string[] = [];
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onEvidence: (k, s, d) => evidence.push(`${k}:${s}:${d}`), onModesLearned: (m) => learned.push(m) });
    const feed = setInterval(() => a.noteObserverState({ cameraMode: "in_eye", observedSteamId: id, observedPosition: c.player }), 20);
    expect(a.supportsChase).toBe(true);
    expect((await a.selectPlayer(id, 1, ctx(), "chase")).status).toBe("transport_acknowledged");
    await until(() => evidence.length > 0);
    expect(c.lines[0]).toBe('spec_player "nova"; spec_mode 5');
    expect(evidence).toEqual(["observerModeControl:supported:getpos showed the chase view 100 units behind the player (spec_mode 5)"]);
    expect(learned).toEqual([]);
    await a.selectPlayer(id, 1, ctx());
    await new Promise((res) => setTimeout(res, 50));
    expect(c.lines.at(-1)).toBe('spec_mode 4; spec_player "nova"');
    clearInterval(feed);
    await a.dispose();
    c.server.close();
  });

  it("learns CS2's chase number when the CS:GO one leaves the camera in the player's eyes", async () => {
    const c = await chaseCs2(3);
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    const feed = setInterval(() => a.noteObserverState({ cameraMode: "in_eye", observedSteamId: id, observedPosition: c.player }), 20);
    await a.selectPlayer(id, 1, ctx(), "chase");
    await until(() => learned.length > 0);
    expect(c.lines).toEqual(['spec_player "nova"; spec_mode 5', "getpos", "spec_mode 3", "getpos"]);
    expect(learned).toEqual([{ modeInEye: "spec_mode 4", modeChase: "spec_mode 3", modeRoaming: "spec_mode 6" }]);
    await a.selectPlayer(id, 1, ctx(), "chase");
    await new Promise((res) => setTimeout(res, 50));
    expect(c.lines.at(-1)).toBe('spec_player "nova"; spec_mode 3');
    clearInterval(feed);
    await a.dispose();
    c.server.close();
  });

  it("goes back to the chase command it had when neither number moves the camera", async () => {
    const c = await chaseCs2(99);
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    const feed = setInterval(() => a.noteObserverState({ cameraMode: "in_eye", observedSteamId: id, observedPosition: c.player }), 20);
    await a.selectPlayer(id, 1, ctx(), "chase");
    await until(() => c.lines.length >= 5);
    expect(c.lines).toEqual(['spec_player "nova"; spec_mode 5', "getpos", "spec_mode 3", "getpos", "spec_mode 5"]);
    expect(learned).toEqual([]);
    clearInterval(feed);
    await a.dispose();
    c.server.close();
  });
});

describe("streamed camera (follow cam)", () => {
  it("starts in the free camera at the first pose, then streams spec_goto until the poses end", async () => {
    const c = await fakeCs2Console(6);
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", pathHz: 50 });
    let calls = 0;
    const poses = (t: number) => (t > 400 ? null : (calls++, { position: { x: 100 + t / 10, y: 0, z: 80 }, pitch: 10, yaw: 0 }));
    const r = await a.streamCamera(poses, 2000, ctx());
    expect(r.status).toBe("transport_acknowledged");
    await new Promise((res) => setTimeout(res, 700));
    expect(c.lines[0]).toBe("spec_mode 6; spec_goto 100 0 80 10 0");
    expect(a.playingPath).toBe(false);
    const frames = c.lines.filter((l) => /^spec_goto /.test(l));
    expect(frames.length).toBeGreaterThan(10);
    expect(frames.length).toBeLessThan(40);
    expect(calls).toBeGreaterThan(10);
    await a.dispose();
    c.server.close();
  });

  it("stops streaming when a player is selected", async () => {
    const c = await fakeCs2Console(6);
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova" });
    await a.streamCamera(() => ({ position: { x: 0, y: 0, z: 80 }, pitch: 0, yaw: 0 }), 10000, ctx());
    await new Promise((res) => setTimeout(res, 100));
    expect(a.playingPath).toBe(true);
    await a.selectPlayer("76561198000000001", 1, ctx());
    expect(a.playingPath).toBe(false);
    await a.dispose();
    c.server.close();
  });
});
