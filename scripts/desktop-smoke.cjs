// Desktop smoke test: launches the Matchframe program (Electron, dev mode) with Playwright.
//  1. Local mode: supervised engine healthy; console shown from app://matchframe (not from the
//     engine's HTTP address); API forwarding and the live WebSocket work; hardened window settings;
//     the engine's HTTP address serves no console to browsers, only the captain page.
//  2. Remote mode: the program connects to an engine on "another computer" (a second engine on
//     other ports) with a role token, without starting its own engine.
// Needs a display (on Linux: xvfb-run -a node scripts/desktop-smoke.cjs [screenshot-prefix]).
const { _electron } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const repo = join(__dirname, "..");
const out = process.argv[2] ?? null;
const exe = require(require.resolve("electron", { paths: [join(repo, "apps/desktop")] }));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};
const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
};

async function launch(env) {
  const app = await _electron.launch({ executablePath: exe, args: ["--no-sandbox", join(repo, "apps/desktop")], cwd: repo, env: { ...process.env, MATCHFRAME_LOG_STDOUT: "0", ...env }, timeout: 60000 });
  const win = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return { app, win, errors };
}

(async () => {
  // ---------------------------------------------------------------- 1. local mode
  const local = await launch({ MATCHFRAME_DATA_DIR: mkdtempSync(join(tmpdir(), "mf-electron-")), MATCHFRAME_GSI_PORT: "39410", MATCHFRAME_API_PORT: "39411", MATCHFRAME_OVERLAY_PORT: "39412" });
  await waitFor(() => local.win.evaluate(() => document.querySelectorAll("nav a").length > 5), 90000);
  await waitFor(() => local.win.evaluate(() => document.body.innerText.includes("CONNECTED")));
  const info = await local.win.evaluate(async () => ({
    url: location.href,
    title: document.title,
    engineOrigin: window.matchframe?.engineOrigin,
    mode: window.matchframe?.connectionMode,
    nav: [...document.querySelectorAll("nav a")].slice(0, 6).map((a) => a.textContent.trim()),
    me: await fetch("/api/v1/me", { headers: { authorization: `Bearer ${await window.matchframe.getOperatorToken()}` } }).then((r) => r.json()),
  }));
  assert(info.url.startsWith("app://matchframe/"), "console is served from app://matchframe");
  assert(info.me.role === "owner", "API requests are forwarded to the engine");
  assert(info.mode === "local" && info.engineOrigin === "http://127.0.0.1:39411", "bridge reports the local engine");
  const prefs = await local.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences?.() ?? {};
    return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, title: w.getTitle() };
  });
  assert(prefs.contextIsolation && prefs.sandbox && !prefs.nodeIntegration, "hardened window settings");
  const health = await fetch("http://127.0.0.1:39411/api/v1/health").then((r) => r.json());
  const browserRoot = await fetch("http://127.0.0.1:39411/", { headers: { accept: "text/html" } });
  const browserText = await browserRoot.text();
  assert(browserRoot.status === 404 && browserText.includes("runs inside the Matchframe program"), "engine serves no console to browsers");
  const captain = await fetch("http://127.0.0.1:39411/captain", { headers: { accept: "text/html" } });
  assert(captain.status === 200 && (await captain.text()).includes("captain-assets"), "captain page is still served for captain links");
  // Pages outside the program's origin cannot be navigated to.
  await local.win.evaluate(() => (location.href = "http://127.0.0.1:39411/"));
  await local.win.waitForTimeout(500);
  assert((await local.win.evaluate(() => location.href)).startsWith("app://matchframe/"), "navigation to the engine's HTTP address is blocked");
  if (out) await local.win.screenshot({ path: `${out}-local.png` });
  // Connection settings page renders inside the program.
  await local.win.evaluate(() => window.matchframe.openConnection());
  await waitFor(() => local.win.evaluate(() => location.pathname === "/connect" && !!document.getElementById("form")));
  if (out) await local.win.screenshot({ path: `${out}-connect.png` });
  const localErrors = local.errors.slice();
  await local.app.close();

  // ---------------------------------------------------------------- 2. remote mode
  // "Production computer": a headless engine on other ports, with a role token for this position.
  const prodData = mkdtempSync(join(tmpdir(), "mf-prod-"));
  const prod = spawn(process.execPath, ["--import", "tsx", join(repo, "services/local-engine/src/main.ts")], {
    cwd: repo,
    env: { ...process.env, MATCHFRAME_DATA_DIR: prodData, MATCHFRAME_GSI_PORT: "39420", MATCHFRAME_API_PORT: "39421", MATCHFRAME_OVERLAY_PORT: "39422", MATCHFRAME_LOG_STDOUT: "0" },
    stdio: "ignore",
  });
  let remoteResult;
  try {
    await waitFor(() => fetch("http://127.0.0.1:39421/api/v1/health").then((r) => r.ok), 60000);
    const owner = readFileSync(join(prodData, "operator-token.txt"), "utf8").trim();
    const issued = await fetch("http://127.0.0.1:39421/api/v1/tokens", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ role: "observer", label: "Observer position" }) }).then((r) => r.json());
    assert(typeof issued.token === "string", "role token issued on the production computer");
    const remote = await launch({ MATCHFRAME_DATA_DIR: mkdtempSync(join(tmpdir(), "mf-electron-remote-")), MATCHFRAME_GSI_PORT: "39430", MATCHFRAME_API_PORT: "39431", MATCHFRAME_OVERLAY_PORT: "39432", MATCHFRAME_REMOTE_URL: "http://127.0.0.1:39421", MATCHFRAME_REMOTE_TOKEN: issued.token });
    await waitFor(() => remote.win.evaluate(() => document.querySelectorAll("nav a").length > 5), 60000);
    await waitFor(() => remote.win.evaluate(() => document.body.innerText.includes("CONNECTED")));
    const r = await remote.win.evaluate(async () => ({ mode: window.matchframe?.connectionMode, engineOrigin: window.matchframe?.engineOrigin, me: await fetch("/api/v1/me", { headers: { authorization: `Bearer ${await window.matchframe.getOperatorToken()}` } }).then((x) => x.json()) }));
    const title = await remote.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    const ownEngine = await fetch("http://127.0.0.1:39431/api/v1/health").then(() => true, () => false);
    assert(r.mode === "remote" && r.engineOrigin === "http://127.0.0.1:39421", "bridge reports the remote engine");
    assert(r.me.role === "observer", "requests go to the production computer with the role token");
    assert(!ownEngine, "no local engine is started in remote mode");
    if (out) await remote.win.screenshot({ path: `${out}-remote.png` });
    remoteResult = { mode: r.mode, role: r.me.role, title, ownEngineStarted: ownEngine, errors: remote.errors };
    await remote.app.close();
  } finally {
    prod.kill("SIGTERM");
  }

  console.log(JSON.stringify({ local: { info, prefs, health: { ok: health.ok, version: health.version }, browserRoot: browserRoot.status, captain: captain.status, errors: localErrors }, remote: remoteResult }, null, 1));
})().catch((e) => {
  console.error("SMOKE FAILED", e);
  process.exit(1);
});
