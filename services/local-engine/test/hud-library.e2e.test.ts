import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HudLibrary, HudLibraryEntry, HudRuntimeControl } from "@matchframe/contracts";
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

type Ports = { gsi: number; api: number; overlay: number };

async function boot(dataDir: string, sampleHudsDirs: string[], ports: Ports) {
  process.env.MATCHFRAME_LOG_STDOUT = "0";
  const cfg = loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  return { engine, servers };
}

function manifest(id: string, over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id,
    name: `HUD ${id}`,
    version: "1.0.0",
    author: "Tests",
    licence: "MIT",
    game: "cs2",
    schemaVersions: [1],
    entryPoints: { live: "index.html" },
    permissions: ["match.public"],
    thumbnail: "thumb.svg",
    category: "Scorebug",
    tags: ["test"],
    settingsSchema: {
      accent: { type: "color", label: "Accent", default: "#2f7cf6" },
      showPlayers: { type: "boolean", label: "Show players", default: true },
      opacity: { type: "number", min: 0, max: 1, default: 0.8 },
      names: { type: "select", options: [{ value: "short", label: "Short" }, { value: "full", label: "Full" }], default: "short" },
    },
    ...over,
  };
}

const FILES = (m: object): Record<string, Uint8Array> => ({
  "manifest.json": strToU8(JSON.stringify(m)),
  "index.html": strToU8('<!doctype html><html><body style="background:transparent">HUD</body></html>'),
  "thumb.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>'),
});
const zip = (m: object) => zipSync(FILES(m));

function writeFolder(dir: string, m: object): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(FILES(m))) writeFileSync(join(dir, name), data);
  return dir;
}

/** Collects JSON messages from a WebSocket; `next(pred)` resolves with the first matching one (including already received). */
function socket(url: string) {
  const ws = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  let closeCode: number | null = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    messages.push(m);
    for (const w of [...waiters]) {
      if (!w.pred(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  ws.on("close", (code) => (closeCode = code));
  return {
    ws,
    messages,
    opened: new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject))),
    closed: () => closeCode,
    next(pred: (m: Record<string, unknown>) => boolean, ms = 4000): Promise<Record<string, unknown>> {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HUD Library (real HTTP/WS servers)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-hudlib-"));
  const samples = mkdtempSync(join(tmpdir(), "mf-samples-"));
  const work = mkdtempSync(join(tmpdir(), "mf-hudwork-"));
  writeFolder(join(samples, "sample-one"), manifest("test.sample", { name: "Bundled sample" }));
  let ports: Ports;
  let ctx: Awaited<ReturnType<typeof boot>>;
  const sockets: ReturnType<typeof socket>[] = [];
  let api: (path: string, init?: RequestInit) => Promise<Response>;
  const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;
  const library = () => json<HudLibrary>(api("/api/v1/hud/library"));
  const entry = async (id: string) => (await library()).huds.find((h) => h.id === id);
  const importZip = (bytes: Uint8Array, q = "") => api(`/api/v1/hud/library/import${q}`, { method: "POST", body: Buffer.from(bytes), headers: { "content-type": "application/zip" } });
  const open = (url: string) => {
    const s = socket(url);
    sockets.push(s);
    return s;
  };
  const overlay = () => `127.0.0.1:${ports.overlay}`;

  beforeAll(async () => {
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    ctx = await boot(dataDir, [samples, join(work, "missing-folder")], ports);
    const token = ctx.engine.secrets.operatorToken;
    api = (path, init = {}) => fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  });

  afterAll(async () => {
    for (const s of sockets) s.ws.terminate();
    await ctx?.servers.close();
    await ctx?.engine.shutdown();
  });

  it("lists the built-in HUD and installs a bundled sample (a missing sample folder is skipped)", async () => {
    const lib = await library();
    expect(lib.hudsDir).toBe(join(dataDir, "huds"));
    expect(lib.hiddenAll).toBe(false);
    const builtin = lib.huds.find((h) => h.kind === "builtin")!;
    expect(builtin.id).toBe("matchframe-default");
    expect(builtin.folder).toBeNull();
    expect(builtin.variants).toContain("live");
    expect(Object.keys(builtin.settingsSchema)).toContain("hide.radar");
    const sample = lib.huds.find((h) => h.id === "test.sample")!;
    expect(sample.kind).toBe("sample");
    expect(sample.folder).toBe(join(dataDir, "huds", "test.sample", "1.0.0"));
    expect(existsSync(join(sample.folder!, "index.html"))).toBe(true);
    expect(sample.thumbnailUrl).toBe(`http://${overlay()}/huds/test.sample/thumb.svg`);
    expect(sample.settings).toEqual({ accent: "#2f7cf6", showPlayers: true, opacity: 0.8, names: "short" });
    expect(sample.urls.live).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${ports.overlay}/hud/test\\.sample/live\\?t=[0-9a-f]{24}$`));
    expect(sample.status).toBe("ready");
  });

  it("imports a ZIP and a folder, and refuses invalid packages and reserved ids", async () => {
    const r = await importZip(zip(manifest("test.zip-hud")));
    expect(r.status).toBe(200);
    const e = (await r.json()) as HudLibraryEntry;
    expect(e).toMatchObject({ id: "test.zip-hud", kind: "imported", version: "1.0.0", category: "Scorebug", tags: ["test"], designResolution: { width: 1920, height: 1080 } });

    const folder = writeFolder(join(work, "src-folder"), manifest("test.folder-hud", { designResolution: { width: 2560, height: 1440 } }));
    const f = await json<HudLibraryEntry>(api("/api/v1/hud/library/import-folder", { method: "POST", body: JSON.stringify({ path: folder }) }));
    expect(f.designResolution).toEqual({ width: 2560, height: 1440 });
    // The installed copy is independent of the original.
    writeFileSync(join(folder, "index.html"), "changed");
    expect(readFileSync(join(f.folder!, "index.html"), "utf8")).toContain("HUD");

    const reserved = await importZip(zip(manifest("assets")));
    expect(reserved.status).toBe(400);
    const missingEntry = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest("test.broken"))) });
    expect((await importZip(missingEntry)).status).toBe(400);
    expect((await importZip(strToU8("not a zip"))).status).toBe(400);
    expect(await entry("test.broken")).toBeUndefined();
  });

  it("asks what to do with a duplicate id: replace keeps a rollback version, copy installs a new HUD", async () => {
    const dup = await importZip(zip(manifest("test.zip-hud", { version: "1.1.0" })));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "duplicate_id", detail: { id: "test.zip-hud", installedVersion: "1.0.0", incomingVersion: "1.1.0", builtin: false } });

    const before = (await json<HudLibraryEntry>(api("/api/v1/hud/library/test.zip-hud/start", { method: "POST" }))).id;
    expect(before).toBe("test.zip-hud");
    const rt = (await entry("test.zip-hud"))!;
    const ctl = open(`ws://${overlay()}/hud-runtime-ws?hud=test.zip-hud&variant=live&mode=obs&t=${new URL(rt.urls.live!).searchParams.get("t")}`);
    const first = (await ctl.next((m) => m.type === "control")) as unknown as HudRuntimeControl;

    const replaced = await json<HudLibraryEntry>(importZip(zip(manifest("test.zip-hud", { version: "1.1.0" })), "?onConflict=replace"));
    expect(replaced.version).toBe("1.1.0");
    expect(replaced.previousVersion).toBe("1.0.0");
    // Running outputs reload the new version.
    const reload = (await ctl.next((m) => m.type === "control" && m.reloadSeq !== first.reloadSeq)) as unknown as HudRuntimeControl;
    expect(reload.reloadSeq).toBe(first.reloadSeq + 1);

    const copy = await json<HudLibraryEntry>(importZip(zip(manifest("test.zip-hud", { version: "1.1.0" })), "?onConflict=copy"));
    expect(copy.id).toBe("test.zip-hud-copy");
    expect(copy.name).toBe("HUD test.zip-hud (copy)");

    const builtinReplace = await importZip(zip(manifest("matchframe-default")), "?onConflict=replace");
    expect(builtinReplace.status).toBe(409);

    const rolled = await json<HudLibraryEntry>(api("/api/v1/hud/library/test.zip-hud/rollback", { method: "POST" }));
    expect(rolled.version).toBe("1.0.0");
  });

  it("duplicates a HUD (manifest rewritten, settings copied) and exports a ZIP that imports again", async () => {
    await json(api("/api/v1/hud/library/test.folder-hud/settings", { method: "PUT", body: JSON.stringify({ settings: { accent: "#ff3300", custom: "kept" } }) }));
    const d = await json<HudLibraryEntry>(api("/api/v1/hud/library/test.folder-hud/duplicate", { method: "POST" }));
    expect(d.id).toBe("test.folder-hud-copy");
    expect(d.settings).toMatchObject({ accent: "#ff3300", custom: "kept" });
    const written = JSON.parse(readFileSync(join(d.folder!, "manifest.json"), "utf8")) as { id: string; name: string };
    expect(written).toMatchObject({ id: "test.folder-hud-copy", name: "HUD test.folder-hud (copy)" });

    const ex = await api("/api/v1/hud/library/test.folder-hud/export");
    expect(ex.headers.get("content-type")).toBe("application/zip");
    expect(ex.headers.get("content-disposition")).toContain('filename="test.folder-hud-1.0.0.zip"');
    const bytes = new Uint8Array(await ex.arrayBuffer());
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(["index.html", "manifest.json", "thumb.svg"]);
    const again = await json<HudLibraryEntry>(importZip(bytes, "?onConflict=copy"));
    expect(again.id).toBe("test.folder-hud-copy-2");

    expect((await api("/api/v1/hud/library/matchframe-default/export")).status).toBe(409);
    expect((await api("/api/v1/hud/library/matchframe-default/duplicate", { method: "POST" })).status).toBe(409);
  });

  it("validates settings against the HUD's schema", async () => {
    const bad = await api("/api/v1/hud/library/test.zip-hud/settings", { method: "PUT", body: JSON.stringify({ settings: { accent: "red; background:url(x)", opacity: 5, names: "huge" } }) });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { message: string };
    expect(body.message).toContain("Accent");
    expect(body.message).toContain("at most 1");
    const ok = await json<HudLibraryEntry>(api("/api/v1/hud/library/test.zip-hud/settings", { method: "PUT", body: JSON.stringify({ settings: { showPlayers: "false", opacity: "0.5", names: "full" } }) }));
    expect(ok.settings).toMatchObject({ showPlayers: false, opacity: 0.5, names: "full", accent: "#2f7cf6" });
    const preset = await api("/api/v1/hud/library/matchframe-default/settings", { method: "PUT", body: JSON.stringify({ settings: {}, presetId: "nope" }) });
    expect(preset.status).toBe(400);
    const builtin = await json<HudLibraryEntry & { presetId: string }>(api("/api/v1/hud/library/matchframe-default/settings", { method: "PUT", body: JSON.stringify({ settings: { "hide.radar": true }, presetId: "arena" }) }));
    expect(builtin.presetId).toBe("arena");
  });

  it("serves the output page only with the HUD's token", async () => {
    const e = (await entry("test.zip-hud"))!;
    const page = await fetch(`${e.urls.live!}&mode=desktop`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("background: transparent");
    expect(html).toContain('data-mode="desktop"');
    expect(html).toContain(`data-frame="/huds/test.zip-hud/index.html?output=hud:test.zip-hud&amp;variant=live&amp;t=`);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect((await fetch(`http://${overlay()}/hud/test.zip-hud/live`)).status).toBe(401);
    expect((await fetch(`http://${overlay()}/hud/test.zip-hud/live?t=wrong`)).status).toBe(401);
    expect((await fetch(`http://${overlay()}/hud/test.zip-hud/veto?${new URL(e.urls.live!).search.slice(1)}`)).status).toBe(404);
    expect((await fetch(`http://${overlay()}/hud-runtime/wrapper.js`)).headers.get("content-type")).toContain("javascript");
    const builtin = (await entry("matchframe-default"))!;
    expect(await (await fetch(builtin.urls.studio!)).text()).toContain(`data-frame="/hud/index.html?output=hud:matchframe-default&amp;variant=studio`);
  });

  it("sends every output of a HUD the current state at once, and new settings to all of them", async () => {
    const e = (await entry("test.sample"))!;
    const t = new URL(e.urls.live!).searchParams.get("t")!;
    const url = `ws://${overlay()}/overlay-ws?output=hud:test.sample&variant=live&t=${t}`;
    const desktop = open(url);
    const obs = open(url);
    const snap = (await desktop.next((m) => m.topic === "hud.snapshot")) as { payload: { outputId: string; settings: Record<string, unknown> } };
    expect(snap.payload.outputId).toBe("hud:test.sample");
    expect(snap.payload.settings.accent).toBe("#2f7cf6");
    await obs.next((m) => m.topic === "hud.snapshot");
    await json(api("/api/v1/hud/library/test.sample/settings", { method: "PUT", body: JSON.stringify({ settings: { accent: "#00ff88" } }) }));
    const isNew = (m: Record<string, unknown>) => m.topic === "hud.snapshot" && (m.payload as { settings: Record<string, unknown> }).settings.accent === "#00ff88";
    await desktop.next(isNew);
    await obs.next(isNew);
    // Another HUD's token does not open this HUD's state.
    const other = new URL((await entry("test.zip-hud"))!.urls.live!).searchParams.get("t");
    const denied = socket(`ws://${overlay()}/overlay-ws?output=hud:test.sample&variant=live&t=${other}`);
    await expect(denied.opened).rejects.toThrow();
    const state = await json<{ outputId: string; settings: Record<string, unknown> }>(api("/api/v1/hud/library/test.sample/state"));
    expect(state.settings.accent).toBe("#00ff88");
  });

  it("counts outputs by mode; stop affects only that HUD, hide-all affects every HUD, reload bumps the sequence", async () => {
    const a = (await entry("test.sample"))!;
    const b = (await entry("test.folder-hud"))!;
    const tokenOf = (e: HudLibraryEntry) => new URL(e.urls.live!).searchParams.get("t");
    const ctl = (e: HudLibraryEntry, mode: string) => open(`ws://${overlay()}/hud-runtime-ws?hud=${e.id}&variant=live&mode=${mode}&t=${tokenOf(e)}`);
    const aDesktop = ctl(a, "desktop");
    const aObs = ctl(a, "obs");
    const bObs = ctl(b, "obs");
    // The manager's embedded preview (details panel) gets control messages but is not counted as an output.
    const aEmbedded = open(`ws://${overlay()}/hud-runtime-ws?hud=${a.id}&variant=live&mode=preview&embed=1&t=${tokenOf(a)}`);
    const control = (m: Record<string, unknown>) => m.type === "control";
    await Promise.all([aDesktop.next(control), aObs.next(control), bObs.next(control), aEmbedded.next(control)]);
    expect((await entry("test.sample"))!.outputs).toEqual({ obs: 1, desktop: 1, preview: 0 });
    // The output pages report how smoothly they draw where they run: the worst of each mode, a stall in the director log.
    aObs.ws.send(JSON.stringify({ type: "perf", fps: 31, worstMs: 620, pauses: 3 }));
    aDesktop.ws.send(JSON.stringify({ type: "perf", fps: 60, worstMs: 21, pauses: 0 }));
    aEmbedded.ws.send(JSON.stringify({ type: "perf", fps: 1, worstMs: 9000, pauses: 99 }));
    aDesktop.ws.send(JSON.stringify({ type: "perf", fps: "x", worstMs: 1, pauses: 0 }));
    await sleep(200);
    expect((await entry("test.sample"))!.smoothness).toEqual({ obs: { fps: 31, worstPauseMs: 620, pauses: 3 }, desktop: { fps: 60, worstPauseMs: 21, pauses: 0 } });
    const stalls = readFileSync(join(dataDir, "logs", "director.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { msg: string; data?: Record<string, unknown> }).filter((l) => l.msg === "hud stall");
    expect(stalls.map((l) => l.data)).toEqual([{ hud: "test.sample", mode: "obs", worstMs: 620, pauses: 3, fps: 31 }]);
    aEmbedded.ws.close();
    expect((await entry("test.sample"))!.status).toBe("running");

    await api("/api/v1/hud/library/test.sample/stop", { method: "POST" });
    await aDesktop.next((m) => control(m) && m.stopped === true);
    await aObs.next((m) => control(m) && m.stopped === true);
    await sleep(200);
    expect(bObs.messages.filter(control).every((m) => m.stopped === false)).toBe(true);
    expect((await entry("test.sample"))!.status).toBe("stopped");

    await api("/api/v1/hud/library/visibility", { method: "POST", body: JSON.stringify({ hidden: true }) });
    await aObs.next((m) => control(m) && m.hidden === true);
    await bObs.next((m) => control(m) && m.hidden === true);
    expect((await library()).hiddenAll).toBe(true);
    await api("/api/v1/hud/library/visibility", { method: "POST", body: JSON.stringify({ hidden: false }) });

    const seq = (bObs.messages.filter(control).at(-1) as unknown as HudRuntimeControl).reloadSeq;
    await api("/api/v1/hud/library/test.folder-hud/reload", { method: "POST" });
    await bObs.next((m) => control(m) && m.reloadSeq === seq + 1);
    await api("/api/v1/hud/library/test.sample/start", { method: "POST" });
    await aObs.next((m) => control(m) && m.stopped === false && m.hidden === false);

    aDesktop.ws.close();
    await sleep(200);
    expect((await entry("test.sample"))!.outputs.desktop).toBe(0);
  });

  it("removes a HUD and disconnects its outputs; refuses the built-in HUD", async () => {
    const e = (await entry("test.zip-hud-copy"))!;
    const s = open(`ws://${overlay()}/hud-runtime-ws?hud=${e.id}&variant=live&mode=obs&t=${new URL(e.urls.live!).searchParams.get("t")}`);
    await s.next((m) => m.type === "control");
    expect((await api(`/api/v1/hud/library/${e.id}`, { method: "DELETE" })).status).toBe(200);
    await sleep(300);
    expect(s.closed()).toBe(4404);
    expect(existsSync(join(dataDir, "huds", e.id))).toBe(false);
    expect((await api("/api/v1/hud/library/matchframe-default", { method: "DELETE" })).status).toBe(409);
  });

  it("keeps HUDs and settings across a restart and does not reinstall a removed sample", async () => {
    expect((await api("/api/v1/hud/library/test.sample", { method: "DELETE" })).status).toBe(200);
    for (const s of sockets) s.ws.terminate();
    await ctx.servers.close();
    await ctx.engine.shutdown();
    ctx = await boot(dataDir, [samples], ports);
    const lib = await library();
    expect(lib.huds.find((h) => h.id === "test.sample")).toBeUndefined();
    const kept = lib.huds.find((h) => h.id === "test.folder-hud")!;
    expect(kept.settings).toMatchObject({ accent: "#ff3300", custom: "kept" });
    expect(lib.huds.find((h) => h.id === "test.zip-hud")?.settings).toMatchObject({ names: "full" });
  });

  it("updates a bundled HUD whose files changed without a new version, keeping its settings", async () => {
    // 0.10.0 → 0.10.1 changed Vector and Lineup but kept their version: installed copies never updated.
    const folder = writeFolder(join(samples, "sample-two"), manifest("test.sample-two", { name: "Second sample" }));
    const restart = async () => {
      for (const s of sockets) s.ws.terminate();
      await ctx.servers.close();
      await ctx.engine.shutdown();
      ctx = await boot(dataDir, [samples], ports);
      // The first request may land on a kept-alive connection to the server that just closed.
      for (let i = 0; i < 5; i++) {
        try {
          await library();
          return;
        } catch {
          await sleep(100);
        }
      }
    };
    await restart();
    const first = (await library()).huds.find((h) => h.id === "test.sample-two")!;
    expect(first.kind).toBe("sample");
    await json(api("/api/v1/hud/library/test.sample-two/settings", { method: "PUT", body: JSON.stringify({ settings: { accent: "#123456" } }) }));
    writeFileSync(join(folder, "index.html"), "<!doctype html><html><body>HUD, new look</body></html>");
    await restart();
    const after = (await library()).huds.find((h) => h.id === "test.sample-two")!;
    expect(readFileSync(join(after.folder!, "index.html"), "utf8")).toContain("new look");
    expect(after.settings).toMatchObject({ accent: "#123456" });
    // Unchanged files on the next start: left as they are.
    await restart();
    expect(readFileSync(join((await library()).huds.find((h) => h.id === "test.sample-two")!.folder!, "index.html"), "utf8")).toContain("new look");
  });
});
