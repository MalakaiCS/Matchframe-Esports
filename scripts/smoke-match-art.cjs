// Match graphics in the running program (desktop and packaged smoke tests): a match is created, its
// "Thumbnails & stingers" tab is opened, and the program draws the thumbnails and encodes the two
// stingers itself (WebCodecs in the program's window). Checks the six files the engine then holds:
// PNGs of the right size, and WebM VP8 stingers marked with an alpha channel.

const { AbortSignal } = globalThis;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// AlphaMode (0x53C0), size 1, value 1.
const ALPHA_MODE = Buffer.from([0x53, 0xc0, 0x81, 0x01]);
const SIZES = { "thumb-highlights": [1280, 720], "thumb-replay": [1280, 720], "thumb-live": [1280, 720], "up-next": [1920, 1080] };

/** Rejects after `ms` (a Playwright evaluate has no timeout of its own). */
const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);

async function checkMatchArt({ app, win, base, waitFor, assert, shot }) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[match art +${Math.round((Date.now() - t0) / 1000)} s] ${msg}`);
  // Which of the program's processes are busy (CPU % by process type), when the app is given.
  const cpu = async () => {
    if (!app) return "";
    const metrics = await within(app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage }))), 10000, "process metrics").catch(() => null);
    if (!metrics) return " · cpu ?";
    const by = {};
    for (const m of metrics) by[m.type] = (by[m.type] ?? 0) + m.cpu;
    return ` · cpu ${Object.entries(by).map(([k, v]) => `${k} ${Math.round(v)}%`).join(", ")}`;
  };
  if (app) {
    const gpu = await within(app.evaluate(({ app: a }) => a.getGPUFeatureStatus()), 10000, "GPU status").catch(() => null);
    if (gpu) log(`GPU features: canvas ${gpu["2d_canvas"]}, compositing ${gpu.gpu_compositing}, video encode ${gpu.video_encode}`);
  }
  const token = await within(win.evaluate(() => window.matchframe.getOperatorToken()), 30000, "operator token");
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    return r.json();
  };
  const a = await call("/api/v1/teams", { name: "Northern Lights", shortName: "NL", primaryColor: "#1d3fbf" });
  const b = await call("/api/v1/teams", { name: "Redline", shortName: "RED" });
  const m = await call("/api/v1/matches", { teamAId: a.id, teamBId: b.id, title: "Smoke final", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, mapPool: ["de_mirage"] });
  assert(typeof m.id === "string", `match created (${JSON.stringify(m)})`);
  log(`match ${m.id} created`);
  // The Matches page opens the newest match; its graphics tab makes them when there are none yet.
  // (Deferred a tick: the page navigates away, which would otherwise race the evaluate call returning.)
  await within(win.evaluate(() => void setTimeout(() => (location.href = "app://matchframe/matches"), 0)), 30000, "opening Matches");
  const tab = await waitFor(() => within(win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.includes("Thumbnails"))), 10000, "the tabs"), 60000);
  assert(tab, "the match's Thumbnails & stingers tab is shown");
  await within(win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Thumbnails")).click()), 10000, "opening the tab");
  log("Thumbnails & stingers tab open");
  const started = Date.now();
  let last = "";
  let lastAt = 0;
  const art = await waitFor(async () => {
    const r = await call(`/api/v1/matches/${m.id}/art`);
    if (r.items.length >= 6) return r;
    // What the panel says (progress, or a failed run's reason: stop early with it).
    const panel = await within(win.evaluate(() => ({ failed: document.querySelector(".note.tone-warn")?.textContent ?? null, progress: [...document.querySelectorAll(".small")].map((e) => e.textContent).find((t) => t.startsWith("Making")) ?? null })), 10000, "the panel");
    // Logged when a file is added, and every 15 s otherwise.
    const made = r.items.map((i) => i.kind).join(",") || "none";
    if (made !== last || Date.now() - lastAt > 15000) {
      log(`${made} · ${panel.progress ?? "-"}${await cpu()}`);
      last = made;
      lastAt = Date.now();
    }
    return panel.failed ? { failed: panel.failed } : null;
  }, 300000);
  assert(!art.failed, `the program made the match graphics (${art.failed})`);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const files = {};
  for (const item of art.items) {
    const bytes = Buffer.from(await (await fetch(base + item.url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
    files[item.kind] = bytes.length;
    if (SIZES[item.kind]) {
      assert(bytes.subarray(0, 8).equals(PNG), `${item.kind} is a PNG`);
      const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      assert(w === SIZES[item.kind][0] && h === SIZES[item.kind][1], `${item.kind} is ${SIZES[item.kind].join("×")} (${w}×${h})`);
    } else {
      assert(bytes.subarray(0, 4).equals(EBML), `${item.kind} is a WebM file`);
      const head = bytes.subarray(0, 512);
      assert(head.includes(Buffer.from("V_VP8")) && head.includes(ALPHA_MODE), `${item.kind} is VP8 with an alpha channel`);
      assert(bytes.length > 100000, `${item.kind} has its frames (${bytes.length} bytes)`);
    }
  }
  log(`all six made in ${seconds} s`);
  if (shot) await win.screenshot({ path: shot });
  return { matchId: m.id, seconds, files };
}

module.exports = { checkMatchArt };
