// Smoke test for a PACKAGED Matchframe program (installed .exe on Windows, or an unpacked build):
// starts a local Matchframe website from this repository, starts the program against it, checks
// that it opens straight into the HUD Library with the bundled HUDs installed, signs in with a
// website account's email and password under Settings → Account, checks the bundled engine and the
// console shown from app://matchframe, API forwarding,
// the live connection, that the engine's HTTP address serves no console, that the captain page and
// HUD outputs are served, reports the website the build is pinned to (cloud.json), and saves
// screenshots.
//   node scripts/packaged-smoke.cjs "<path to Matchframe Esports.exe>" [screenshot.png]
// MATCHFRAME_EXPECT_WEBSITE=<url> additionally requires the build's cloud.json to point there.
// Uses `playwright` or `playwright-core` (only the Electron driver is needed, no browsers).
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("playwright-core");
}
const { existsSync, mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { startCloud, signInThroughAccount } = require("./smoke-cloud.cjs");

const exe = process.argv[2];
const shot = process.argv[3] ?? null;
if (!exe) {
  console.error("usage: node scripts/packaged-smoke.cjs <program executable> [screenshot.png]");
  process.exit(2);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};
const waitFor = async (fn, ms) => {
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

const PASSWORD = "correct horse battery";

(async () => {
  const cloud = await startCloud({ repo: join(__dirname, ".."), port: 39540 });
  try {
    await cloud.account("producer@example.com", PASSWORD, "Night League");
    await run(cloud);
  } finally {
    cloud.stop();
  }
})().catch((e) => {
  console.error("PACKAGED SMOKE FAILED", e);
  process.exit(1);
});

async function run(cloud) {
  const ports = { gsi: "39510", api: "39511", overlay: "39512" };
  const app = await pw._electron.launch({
    executablePath: exe,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
    // The local website and its key replace the website pinned into the build (cloud.json) for this test.
    env: { ...process.env, MATCHFRAME_DATA_DIR: mkdtempSync(join(tmpdir(), "mf-packaged-")), MATCHFRAME_GSI_PORT: ports.gsi, MATCHFRAME_API_PORT: ports.api, MATCHFRAME_OVERLAY_PORT: ports.overlay, MATCHFRAME_LOG_STDOUT: "0", MATCHFRAME_CLOUD_URL: cloud.base, MATCHFRAME_CLOUD_PUBLIC_KEYS: JSON.stringify(cloud.keys), MATCHFRAME_SIGN_IN: "" },
    timeout: 120000,
  });
  const win = await app.firstWindow({ timeout: 120000 });
  const errors = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await waitFor(() => win.evaluate(() => !!document.querySelector('[data-testid="hud-library"]')), 120000);
  assert(await win.evaluate(() => document.querySelectorAll("nav a").length >= 10), "the program opens into the HUD Library without signing in");
  const huds = await waitFor(() => win.evaluate(() => [...document.querySelectorAll(".hud-card")].map((c) => c.getAttribute("data-hud"))).then((l) => (l.length >= 3 ? l : null)), 30000);
  assert(huds.includes("matchframe.sample-cs2") && huds.includes("matchframe.pro-cs2"), `bundled HUDs installed (${huds.join(", ")})`);
  await waitFor(() => win.evaluate(() => [...document.querySelectorAll(".hud-card img")].every((i) => i.complete && i.naturalWidth > 0)), 15000);
  if (shot) await win.screenshot({ path: shot.replace(/(\.png)?$/, "-library.png") });
  await signInThroughAccount(win, "producer@example.com", PASSWORD);
  await waitFor(() => win.evaluate(() => !!document.querySelector('[data-link="open"]')), 30000);
  const info = await win.evaluate(async () => ({
    url: location.href,
    nav: [...document.querySelectorAll("nav a")].map((a) => a.textContent.trim()),
    me: await fetch("/api/v1/me", { headers: { authorization: `Bearer ${await window.matchframe.getOperatorToken()}` } }).then((r) => r.json()),
    signIn: (await fetch("/api/v1/cloud/status", { headers: { authorization: `Bearer ${await window.matchframe.getOperatorToken()}` } }).then((r) => r.json())).signIn,
  }));
  const meta = await app.evaluate(({ app: a, BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences?.() ?? {};
    return { packaged: a.isPackaged, version: a.getVersion(), resources: process.resourcesPath, userData: a.getPath("userData"), contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration };
  });
  const base = `http://127.0.0.1:${ports.api}`;
  const health = await fetch(`${base}/api/v1/health`).then((r) => r.json());
  const root = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  const captain = await fetch(`${base}/captain`, { headers: { accept: "text/html" } });
  const outputs = await win.evaluate(async () => fetch("/api/v1/hud/outputs", { headers: { authorization: `Bearer ${await window.matchframe.getOperatorToken()}` } }).then((r) => r.json()));
  const mainUrl = (Array.isArray(outputs) ? outputs : (outputs.outputs ?? [])).find((o) => o.url)?.url ?? null;
  const overlay = mainUrl ? await fetch(mainUrl) : null;

  const pinnedFile = join(meta.resources, "cloud.json");
  const pinned = existsSync(pinnedFile) ? JSON.parse(readFileSync(pinnedFile, "utf8")) : null;
  const website = pinned ? { url: pinned.url, keys: Object.keys(pinned.publicKeys ?? {}) } : null;
  if (process.env.MATCHFRAME_EXPECT_WEBSITE) assert(website?.url === process.env.MATCHFRAME_EXPECT_WEBSITE && website.keys.length > 0, `the build is pinned to ${process.env.MATCHFRAME_EXPECT_WEBSITE} with its licence key (cloud.json: ${JSON.stringify(website)})`);
  assert(meta.packaged, "running the packaged program");
  assert(info.signIn.state === "signed_in" && info.signIn.user.email === "producer@example.com", "signed in with the website account's email and password");
  assert(info.url.startsWith("app://matchframe/"), "console shown from the program's own origin");
  assert(info.me.role === "owner", "API requests forwarded to the bundled engine");
  assert(health.ok === true, "bundled engine healthy");
  assert(root.status === 404, "the engine's HTTP address serves no console");
  assert(captain.status === 200, "captain page served");
  assert(!overlay || overlay.status === 200, "HUD output served for OBS");
  assert(meta.contextIsolation && meta.sandbox && !meta.nodeIntegration, "hardened window");
  if (shot) await win.screenshot({ path: shot });
  console.log(JSON.stringify({ ok: true, platform: process.platform, meta, url: info.url, navItems: info.nav.length, huds, role: info.me.role, signIn: info.signIn, website, health: { ok: health.ok, version: health.version, schemaVersion: health.schemaVersion }, engineRoot: root.status, captain: captain.status, hudOutput: overlay?.status ?? null, errors }, null, 1));
  await app.close();
}
