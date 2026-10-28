import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import type { CameraPath, CommandContext } from "@matchframe/contracts";
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

/** A console where the free camera is spec_mode 6 but in-eye is spec_mode 2, with game data following the camera. */
async function mixedNumberingCs2() {
  const lines: string[] = [];
  const game = { mode: 2, observed: "76561198000000001" as string | null };
  const server = createServer((sock) =>
    sock.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        lines.push(line);
        for (const cmd of line.split(";").map((c) => c.trim())) {
          const m = /^spec_mode (\d+)$/.exec(cmd);
          if (m) game.mode = Number(m[1]);
          if (/^spec_goto /.test(cmd) && game.mode === 6) game.observed = null;
          if (/^spec_player /.test(cmd) && game.mode === 2) game.observed = "76561198000000002";
          if (cmd === "getpos") sock.write("setpos 1200.500000 -340.000000 256.000000;setang 18.000000 -135.000000 0.000000\n");
        }
      }
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { lines, game, server, port: (server.address() as { port: number }).port };
}

const camera = (over: Record<string, unknown> = {}) => ({ id: "cam-a", position: { x: 1200.5, y: -340, z: 256 }, pitch: 18, yaw: -135, ...over }) as never;

describe("in-eye numbering", () => {
  it("learns the in-eye spec_mode from the game data when leaving the free camera doesn't reach the player", async () => {
    const c = await mixedNumberingCs2();
    const learned: unknown[] = [];
    const a = new NetconObserverAdapter({ host: "127.0.0.1", port: c.port, now: () => 0, playerName: () => "nova", onModesLearned: (m) => learned.push(m) });
    // The game data, every 100 ms.
    const feed = setInterval(() => a.noteObserverState({ cameraMode: c.game.observed ? "unknown" : "roaming", observedSteamId: c.game.observed }), 100);
    expect((await a.activateStaticCamera(camera(), ctx())).status).toBe("confirmed");
    await a.selectPlayer("76561198000000002", 2, ctx());
    for (let i = 0; i < 60 && !learned.length; i++) await new Promise((res) => setTimeout(res, 50));
    clearInterval(feed);
    expect(c.lines).toContain('spec_mode 4; spec_player "nova"');
    expect(c.lines).toContain('spec_mode 2; spec_player "nova"');
    expect(learned).toEqual([{ modeInEye: "spec_mode 2", modeChase: "spec_mode 3", modeRoaming: "spec_mode 6" }]);
    expect(c.game.observed).toBe("76561198000000002");
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
