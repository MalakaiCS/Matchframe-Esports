// Desktop smoke test: launches the Electron shell (dev mode) with Playwright, waits for the
// supervised engine and the operator console, and checks the hardened window settings.
// Needs a display (on Linux: xvfb-run -a node scripts/desktop-smoke.cjs [screenshot.png]).
const { _electron } = require("playwright");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
(async () => {
  const repo = join(__dirname, "..");
  const out = process.argv[2] ?? null;
  const exe = require(require.resolve("electron", { paths: [join(repo, "apps/desktop")] }));
  const app = await _electron.launch({
    executablePath: exe,
    args: ["--no-sandbox", join(repo, "apps/desktop")],
    cwd: repo,
    env: { ...process.env, MATCHFRAME_DATA_DIR: mkdtempSync(join(tmpdir(), "mf-electron-")), MATCHFRAME_GSI_PORT: "39410", MATCHFRAME_API_PORT: "39411", MATCHFRAME_OVERLAY_PORT: "39412", MATCHFRAME_LOG_STDOUT: "0" },
    timeout: 60000,
  });
  const logs = [];
  app.process().stderr?.on("data", (d) => logs.push(String(d)));
  const win = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForTimeout(4000);
  const info = await win.evaluate(() => ({ url: location.href, title: document.title, hasBridge: typeof window.matchframe, nav: [...document.querySelectorAll("nav a")].slice(0, 6).map((a) => a.textContent.trim()), body: document.body.innerText.slice(0, 200) }));
  const prefs = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences?.() ?? {}; return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration }; });
  // Health of the supervised engine.
  const health = await fetch("http://127.0.0.1:39411/api/v1/health").then((r) => r.json());
  if (out) await win.screenshot({ path: out });
  console.log(JSON.stringify({ info, prefs, health: { ok: health.ok, version: health.version }, errors }, null, 1));
  await app.close();
})().catch((e) => { console.error("SMOKE FAILED", e); process.exit(1); });
