import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writePngMov } from "../../../apps/operator-web/src/lib/match-art/mov.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Real integration: a match's stingers put in a running OBS's "Matchframe Stinger" and "Matchframe
 * Replay Stinger" transitions (obs-websocket v5). Opt-in: set MF_OBS_URL and MF_OBS_PASSWORD; the OBS
 * scene collection needs the two Stinger transitions (OBS can't create them over obs-websocket).
 */
const url = process.env.MF_OBS_URL;
const password = process.env.MF_OBS_PASSWORD;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const PNG_FRAME = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const MOV = Buffer.from(writePngMov({ width: 1920, height: 1080, fps: 60, frames: [PNG_FRAME, PNG_FRAME] }));

describe.skipIf(!url || !password)("match stingers in a real OBS", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let port: number;
  const api = async (path: string, init: { body?: unknown; raw?: Buffer } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.body !== undefined || init.raw ? "POST" : "GET", headers: { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": init.raw ? "application/octet-stream" : "application/json" }, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    port = await freePort();
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-art-obs-")), gsiPort: await freePort(), apiPort: port, overlayPort: await freePort(), host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("sets both transitions' video and cut point, confirmed from OBS, and keeps OBS's transition unless asked", async () => {
    expect((await api("/api/v1/obs/connect", { body: { url, password, remember: false } })).status).toBe(200);
    const kinds = await e.obs.transitionKinds();
    const names = kinds.transitions.filter((t) => t.kind === "obs_stinger_transition").map((t) => t.name);
    const a = await api("/api/v1/teams", { body: { name: "Northern Lights", shortName: "NL" } });
    const b = await api("/api/v1/teams", { body: { name: "Redline", shortName: "RED" } });
    const m = await api("/api/v1/matches", { body: { teamAId: a.json.id, teamBId: b.json.id, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, mapPool: ["de_mirage"] } });
    const id = m.json.id as string;
    for (const kind of ["stinger", "stinger-replay"]) expect((await api(`/api/v1/matches/${id}/art/${kind}`, { raw: MOV })).status).toBe(200);
    const before = kinds.current;
    const r = await api(`/api/v1/matches/${id}/art/obs`, { body: { useStinger: false } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const want = ["Matchframe Stinger", "Matchframe Replay Stinger"];
    expect(r.json.missing).toEqual(want.filter((n) => !names.includes(n)));
    expect(r.json.set).toEqual(want.filter((n) => names.includes(n)).map((n) => ({ kind: n === want[0] ? "stinger" : "stinger-replay", transition: n, confirmed: true })));
    expect(r.json.current).toBe(before);
    if (!names.includes(want[0]!)) return;
    // Read back from OBS itself.
    const settings = await e.obs.setTransitionSettings(want[0]!, {});
    expect(String(settings.settings.path)).toBe(join(e.cfg.dataDir, "graphics", id, "stinger.mov"));
    expect(settings.settings.transition_point).toBe(900);
    const used = await api(`/api/v1/matches/${id}/art/obs`, { body: { useStinger: true } });
    expect(used.json.current).toBe(want[0]);
    if (before) await e.obs.setTransition(before);
  });
});
