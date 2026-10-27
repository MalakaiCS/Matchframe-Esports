// Checks the transparent desktop HUD of the Matchframe program on the machine it runs on and writes
// a JSON report. Run it against the installed program on Windows (CI does after installing):
//   node scripts/overlay-check.cjs "<path to Matchframe Esports.exe>" report.json
// or against a development build (Linux needs xvfb-run; the screen-pixel and input checks are
// Windows-only and are reported as skipped elsewhere):
//   xvfb-run -a node scripts/overlay-check.cjs node_modules/.bin/electron report.json apps/desktop
//
// What it checks, with test data running and a sample HUD launched as a desktop window:
//  - window settings: transparent, frameless, always on top, not focusable, click-through,
//    sandboxed, no Node, no background throttling, separate session;
//  - real pixels (Windows): over a fake game window, empty HUD areas show the game, HUD panels do
//    not; hiding the HUD shows the game everywhere;
//  - click-through and focus (Windows): clicks reach the game window, which keeps keyboard focus;
//    in edit mode the HUD window catches the mouse instead;
//  - browser-source output: the URL you add to OBS, rendered offscreen and transparent the way OBS
//    renders it (alpha 0 where there is no HUD), counted as an output. OBS itself is not needed;
//  - live settings reach the desktop HUD; it keeps updating while the manager is minimised and
//    after the engine restarts; hide-all hides it;
//  - quit closes every window and leaves no program process or open port.
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("playwright-core");
}
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const [exe, reportFile, appDir] = process.argv.slice(2);
if (!exe || !reportFile) {
  console.error("usage: node scripts/overlay-check.cjs <program executable> <report.json> [app folder, development builds]");
  process.exit(2);
}
const isWin = process.platform === "win32";
const PORTS = { gsi: "39610", api: "39611", overlay: "39612" };
const SAMPLE = "matchframe.sample-cs2";
const PRO = "matchframe.pro-cs2";
const TAG = "matchframe.hud-window";
const checks = [];
const info = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000, step = 250) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(step);
  }
};
function check(name, ok, detail = null, { soft = false } = {}) {
  checks.push({ name, ok: !!ok, soft, detail });
  console.log(`${ok ? "PASS" : soft ? "WARN" : "FAIL"}  ${name}${detail === null ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function skip(name, why) {
  checks.push({ name, ok: null, skipped: why });
  console.log(`SKIP  ${name}  (${why})`);
}
async function step(name, fn, opts) {
  try {
    await fn();
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e), opts);
  }
}

/** HUD design points (1920×1080): its empty centre and its top panel (the sample HUD's scorebug). */
const HUD_POINTS = { empty: [960, 486], panel: [960, 54] };
/**
 * Runs in the main process: alpha at the HUD points of a page. The output page fits the HUD into its
 * viewport without stretching (letterboxed), so the points are mapped through the page's own
 * viewport size (the captured image can be smaller than the viewport when a window is clamped to
 * the screen), and each point is captured on its own.
 */
const ALPHA_AT_HUD_POINTS = `async (wc, pts) => {
  const vp = await wc.executeJavaScript("({ w: innerWidth, h: innerHeight })");
  const s = Math.min(vp.w / 1920, vp.h / 1080);
  const x0 = (vp.w - 1920 * s) / 2, y0 = (vp.h - 1080 * s) / 2;
  const alpha = async ([dx, dy]) => {
    const img = await wc.capturePage({ x: Math.floor(x0 + dx * s), y: Math.floor(y0 + dy * s), width: 1, height: 1 });
    const bmp = img.toBitmap();
    return bmp.length >= 4 ? bmp[3] : null;
  };
  return { viewport: vp, center: await alpha(pts.empty), scorebug: await alpha(pts.panel) };
}`;

/** Windows input and window queries through user32 (PowerShell). */
const USER32 = `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class MfU {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
[void][MfU]::SetProcessDPIAware()
`;
function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", USER32 + script], { encoding: "utf8", timeout: 30000 }).trim();
}
const clickAt = (x, y) => ps(`[void][MfU]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 80; [MfU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [MfU]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);
const foregroundTitle = () => ps(`$h=[MfU]::GetForegroundWindow(); $s=New-Object System.Text.StringBuilder 512; [void][MfU]::GetWindowText($h,$s,512); $s.ToString()`);
// Title of the top-level window under a screen point (which window a pixel belongs to).
const windowAt = (x, y) => ps(`$p=New-Object MfU+POINT; $p.X=${Math.round(x)}; $p.Y=${Math.round(y)}; $h=[MfU]::GetAncestor([MfU]::WindowFromPoint($p),2); $s=New-Object System.Text.StringBuilder 512; [void][MfU]::GetWindowText($h,$s,512); $s.ToString()`);
// Ctrl+Shift+<vk>, sent as global key presses.
const pressHotkey = (vk) => ps(`[MfU]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [MfU]::keybd_event(0x10,0,0,[UIntPtr]::Zero); [MfU]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [MfU]::keybd_event(${vk},0,2,[UIntPtr]::Zero); [MfU]::keybd_event(0x10,0,2,[UIntPtr]::Zero); [MfU]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`);

const data = mkdtempSync(join(tmpdir(), "mf-overlay-"));

(async () => {
  const app = await pw._electron.launch({
    executablePath: resolve(exe),
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), ...(appDir ? [resolve(appDir)] : [])],
    env: { ...process.env, MATCHFRAME_DATA_DIR: data, MATCHFRAME_GSI_PORT: PORTS.gsi, MATCHFRAME_API_PORT: PORTS.api, MATCHFRAME_OVERLAY_PORT: PORTS.overlay, MATCHFRAME_LOG_STDOUT: "0", MATCHFRAME_SIGN_IN: "" },
    timeout: 120000,
  });
  const proc = app.process();
  // The program's output, including the engine's (it forwards the engine's stdout and stderr).
  const output = [];
  const keep = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) output.push(line);
    if (output.length > 300) output.splice(0, output.length - 300);
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  let exited = false;
  proc.on("exit", () => (exited = true));
  const exitCode = new Promise((r) => proc.on("exit", (code) => r(code)));
  try {
    await run(app);
  } catch (e) {
    check("overlay check ran to the end", false, e instanceof Error ? e.stack : String(e));
  }

  // ---------------------------------------------------------------- quit
  await step("quit closes every window and stops the engine and HUD server", async () => {
    if (exited) throw new Error("the program had already exited");
    await app.evaluate(({ app: a }) => a.quit()).catch(() => undefined);
    const code = await Promise.race([exitCode, sleep(20000).then(() => "timeout")]);
    if (code === "timeout") throw new Error("the program did not exit within 20 s");
    await sleep(1500);
    const api = await fetch(`http://127.0.0.1:${PORTS.api}/api/v1/health`).then(() => true, () => false);
    const overlay = await fetch(`http://127.0.0.1:${PORTS.overlay}/health`).then(() => true, () => false);
    let leftover = [];
    if (isWin) {
      const out = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq Matchframe Esports.exe"], { encoding: "utf8" });
      leftover = out.split(/\r?\n/).filter((l) => l.includes("Matchframe Esports.exe"));
    }
    check("quit closes every window and stops the engine and HUD server", !api && !overlay && leftover.length === 0, { exitCode: code, apiStillUp: api, hudServerStillUp: overlay, leftoverProcesses: leftover.length });
  });

  const hard = checks.filter((c) => c.ok === false && !c.soft);
  // On failure, the engine's log and the program's output explain what happened (also printed:
  // the data folder is a temporary one and the report is only an artifact).
  if (hard.length) {
    const log = join(data, "logs", "engine.log");
    info.engineLogTail = existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).slice(-80) : [];
    info.programOutputTail = output.slice(-120);
    console.log("\n---- engine log (last 80 lines) ----\n" + info.engineLogTail.join("\n"));
    console.log("\n---- program output (last 120 lines) ----\n" + info.programOutputTail.join("\n"));
  }
  const report = { ok: hard.length === 0, platform: process.platform, executable: exe, info, checks, at: new Date().toISOString() };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n${checks.filter((c) => c.ok).length} passed, ${hard.length} failed, ${checks.filter((c) => c.ok === false && c.soft).length} warnings, ${checks.filter((c) => c.ok === null).length} skipped. Report: ${reportFile}`);
  process.exit(hard.length ? 1 : 0);
})().catch((e) => {
  console.error("OVERLAY CHECK FAILED", e);
  process.exit(1);
});

async function run(app) {
  const win = await app.firstWindow({ timeout: 120000 });
  const errors = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  await waitFor(() => win.evaluate(() => !!document.querySelector('[data-testid="hud-library"]') && !!window.matchframe?.hud), 120000);
  check("the program opens into the HUD Library without signing in", true);

  const api = (path, init = {}) =>
    win.evaluate(
      async ({ path, init }) => {
        const token = await window.matchframe.getOperatorToken();
        const r = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      { path, init },
    );
  const library = async () => (await api("/api/v1/hud/library")).body;
  const lib = await waitFor(async () => {
    const l = await library();
    return l?.huds?.some((h) => h.id === SAMPLE) ? l : null;
  });
  check("bundled HUDs installed (sample and Pro CS2)", lib.huds.some((h) => h.id === SAMPLE && h.status !== "error") && lib.huds.some((h) => h.id === PRO && h.status !== "error"), lib.huds.map((h) => `${h.id}:${h.status}`));
  const sim = await api("/api/v1/simulation/start", { method: "POST", body: JSON.stringify({ startOffsetSec: 25 }) });
  check("test data started", sim.status === 200, sim.status);

  info.displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })));
  if (info.displays.length < 2) skip("HUD on a second monitor", "this machine has one display");

  // ---------------------------------------------------------------- fake game window
  // A plain magenta window standing in for a game in Fullscreen Windowed mode, counting clicks.
  await app.evaluate(async ({ BrowserWindow, screen }) => {
    const d = screen.getPrimaryDisplay();
    const w = new BrowserWindow({ ...d.bounds, frame: false, backgroundColor: "#ff00ff", title: "MF Fake Game", show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    globalThis.__mfFake = w;
    await w.loadURL("data:text/html," + encodeURIComponent("<!doctype html><title>MF Fake Game</title><body style='margin:0;background:#ff00ff;width:100vw;height:100vh'><script>window.__clicks=0;addEventListener('mousedown',()=>window.__clicks++)</script>"));
    w.show();
    w.focus();
  });
  await sleep(800);

  // ---------------------------------------------------------------- launch the desktop HUD
  const launched = await win.evaluate((id) => window.matchframe.hud.launch(id, { variant: "live" }), SAMPLE);
  check("Launch Transparent HUD opens a desktop HUD window", launched?.open === true, { bounds: launched?.bounds, displayId: launched?.displayId });
  await waitFor(async () => (await win.evaluate(() => window.matchframe.hud.overlays())).find((o) => o.hudId === SAMPLE)?.status === "running", 30000);
  // Keep the game focused, as a player would have it.
  await app.evaluate(() => globalThis.__mfFake.focus());
  await sleep(1500);

  const props = await app.evaluate(({ BrowserWindow, session }, tag) => {
    const w = BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay");
    if (!w) return null;
    const t = w[Symbol.for(tag)];
    const p = w.webContents.getLastWebPreferences?.() ?? {};
    const manager = BrowserWindow.getAllWindows().find((x) => !x[Symbol.for(tag)] && x.getTitle().startsWith("Matchframe Esports"));
    return {
      alwaysOnTop: w.isAlwaysOnTop(),
      focusable: w.isFocusable(),
      visible: w.isVisible(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
      contentBounds: w.getContentBounds(),
      tag: t,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      preload: p.preload ?? null,
      backgroundThrottling: w.webContents.getBackgroundThrottling(),
      ownSession: w.webContents.session === session.fromPartition("mf-hud-outputs") && w.webContents.session !== manager?.webContents.session,
      url: w.webContents.getURL(),
    };
  }, TAG);
  info.overlay = props;
  check(
    "desktop HUD window: transparent, frameless, always on top, not focusable, click-through",
    props && props.tag.transparent && props.tag.backgroundColor === "#00000000" && props.alwaysOnTop && !props.focusable && props.tag.ignoringMouse && !props.focused && props.visible,
    props && { alwaysOnTop: props.alwaysOnTop, focusable: props.focusable, ignoringMouse: props.tag.ignoringMouse, transparent: props.tag.transparent, frameless: JSON.stringify(props.bounds) === JSON.stringify(props.contentBounds) },
  );
  check("desktop HUD window: sandboxed, no Node, no preload, no background throttling, separate session", props && props.sandbox && props.contextIsolation !== false && !props.nodeIntegration && !props.preload && props.backgroundThrottling === false && props.ownSession, props && { sandbox: props.sandbox, nodeIntegration: props.nodeIntegration, preload: props.preload, backgroundThrottling: props.backgroundThrottling, ownSession: props.ownSession });
  check("desktop HUD loads the HUD server's output page in desktop mode", props && props.url.includes(`/hud/${SAMPLE}/live`) && props.url.includes("mode=desktop"), props?.url);

  // HUD frame (same origin as the wrapper page): read what it shows.
  const frameEval = (code) =>
    app.evaluate(
      async ({ BrowserWindow }, { tag, code }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay");
        const f = w?.webContents.mainFrame.frames[0];
        return f ? f.executeJavaScript(code) : null;
      },
      { tag: TAG, code },
    );
  const wrapperEval = (code) =>
    app.evaluate(async ({ BrowserWindow }, { tag, code }) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay")?.webContents.executeJavaScript(code), { tag: TAG, code });
  await step("desktop HUD shows live data", async () => {
    const shown = await waitFor(() => frameEval(`(() => { const h = document.getElementById("hud"); return h && !h.hidden ? document.querySelector(".clock-time").textContent : null; })()`), 20000);
    check("desktop HUD shows live data", !!shown, { clock: shown });
  });

  // capturePage: transparent pixels in the window itself (all platforms).
  await step("desktop HUD renders transparent pixels where there is no HUD", async () => {
    const a = await app.evaluate(async ({ BrowserWindow }, { tag, fn, pts }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay");
      return eval(fn)(w.webContents, pts);
    }, { tag: TAG, fn: ALPHA_AT_HUD_POINTS, pts: HUD_POINTS });
    check("desktop HUD renders transparent pixels where there is no HUD", a.center === 0 && a.scorebug > 0, a);
  });

  // ---------------------------------------------------------------- real pixels and input (Windows)
  const d = info.displays.find((x) => x.primary);
  // Physical screen pixels of a HUD design point, from the overlay window's current bounds.
  let bounds = props.bounds;
  const toScreen = ([dx, dy]) => {
    const s = Math.min(bounds.width / 1920, bounds.height / 1080);
    const x0 = (bounds.width - 1920 * s) / 2;
    const y0 = (bounds.height - 1080 * s) / 2;
    return { x: (bounds.x - d.bounds.x + x0 + dx * s) * d.scaleFactor, y: (bounds.y - d.bounds.y + y0 + dy * s) * d.scaleFactor };
  };
  const refreshBounds = async () => {
    bounds = await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay").getBounds(), TAG);
  };
  // Put the stand-in game back in front of the manager window, with focus.
  const frontGame = () => app.evaluate(() => {
    globalThis.__mfFake.moveTop();
    globalThis.__mfFake.focus();
  });
  const screenPixels = (points) =>
    app.evaluate(
      async ({ desktopCapturer, screen }, points) => {
        const disp = screen.getPrimaryDisplay();
        const size = { width: Math.round(disp.bounds.width * disp.scaleFactor), height: Math.round(disp.bounds.height * disp.scaleFactor) };
        const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
        const img = src.thumbnail;
        const s = img.getSize();
        const bmp = img.toBitmap();
        return points.map(({ x, y }) => {
          const i = (Math.round((y * s.height) / size.height) * s.width + Math.round((x * s.width) / size.width)) * 4;
          return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
        });
      },
      points,
    );
  const isMagenta = (p) => p.r > 225 && p.g < 40 && p.b > 225;
  const empty = toScreen(HUD_POINTS.empty);
  let panel = toScreen(HUD_POINTS.panel);
  if (!isWin) {
    skip("real pixels: the game shows through empty HUD areas, not through panels", "needs the Windows desktop compositor");
    skip("click-through: clicks reach the game window", "Windows input");
    skip("focus: the game keeps keyboard focus", "Windows input");
  } else {
    await step("real pixels: the game shows through empty HUD areas, not through panels", async () => {
      const [e, p] = await screenPixels([empty, panel]);
      check("real pixels: the game shows through empty HUD areas, not through panels", isMagenta(e) && !isMagenta(p), { emptyArea: e, panel: p });
    });
    await step("click-through: clicks reach the game window", async () => {
      const before = await app.evaluate(() => globalThis.__mfFake.webContents.executeJavaScript("window.__clicks"));
      clickAt(empty.x, empty.y);
      clickAt(panel.x, panel.y);
      await sleep(500);
      const after = await app.evaluate(() => globalThis.__mfFake.webContents.executeJavaScript("window.__clicks"));
      check("click-through: clicks reach the game window, over empty areas and over HUD panels", after - before === 2, { clicksReceived: after - before });
    });
    await step("focus: the game keeps keyboard focus", async () => {
      await win.evaluate((id) => window.matchframe.hud.setVisible(id, false), SAMPLE);
      await win.evaluate((id) => window.matchframe.hud.setVisible(id, true), SAMPLE);
      await sleep(500);
      const title = foregroundTitle();
      const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null);
      check("focus: the game keeps keyboard focus while the HUD is shown, hidden and clicked", title === "MF Fake Game", { foreground: title, electronFocused: focused });
    });
  }

  // ---------------------------------------------------------------- edit mode
  await step("edit mode catches the mouse; leaving it restores click-through", async () => {
    await win.evaluate((id) => window.matchframe.hud.setEditing(id, true), SAMPLE);
    await sleep(300);
    const editing = await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay")[Symbol.for(tag)].ignoringMouse, TAG);
    const outline = await wrapperEval("window.__mfOverlay.status().editing");
    let clicks = null;
    if (isWin) {
      const before = await app.evaluate(() => globalThis.__mfFake.webContents.executeJavaScript("window.__clicks"));
      clickAt(empty.x, empty.y);
      await sleep(400);
      clicks = (await app.evaluate(() => globalThis.__mfFake.webContents.executeJavaScript("window.__clicks"))) - before;
    }
    await win.evaluate((id) => window.matchframe.hud.setEditing(id, false), SAMPLE);
    await sleep(300);
    const after = await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay")[Symbol.for(tag)].ignoringMouse, TAG);
    check("edit mode catches the mouse; leaving it restores click-through", editing === false && outline === true && after === true && (clicks === null || clicks === 0), { ignoringMouseWhileEditing: editing, outline, clicksReachingGameWhileEditing: clicks, ignoringMouseAfter: after });
    if (isWin) await frontGame();
  });

  // ---------------------------------------------------------------- scale, position, remembered
  await step("scale and position change without stretching and are remembered", async () => {
    const st = await win.evaluate((id) => window.matchframe.hud.configure(id, { fit: "native" }), SAMPLE);
    const moved = await win.evaluate((id) => window.matchframe.hud.configure(id, { scale: 0.5, bounds: { x: 0, y: 0 } }), SAMPLE);
    await sleep(500);
    const scale = await wrapperEval("window.__mfOverlay.status().scale");
    const ratio = moved.bounds.width / moved.bounds.height;
    check("scale and position change without stretching and are remembered", Math.abs(moved.scale - 0.5) < 0.02 && Math.abs(ratio - 16 / 9) < 0.02 && scale > 0, { native: st.bounds, half: moved.bounds, wrapperScale: scale });
    await win.evaluate((id) => window.matchframe.hud.configure(id, { fit: "display" }), SAMPLE);
  });

  // ---------------------------------------------------------------- live settings
  await step("settings changed in the library reach the desktop HUD without a reload", async () => {
    const put = await api(`/api/v1/hud/library/${SAMPLE}/settings`, { method: "PUT", body: JSON.stringify({ settings: { accentColor: "#12ab34" } }) });
    const accent = await waitFor(async () => {
      const v = await frameEval(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
      return v === "#12ab34" ? v : null;
    }, 10000);
    check("settings changed in the library reach the desktop HUD without a reload", put.status === 200 && accent === "#12ab34", { accent });
  });

  // ---------------------------------------------------------------- independence from the manager
  await step("the desktop HUD keeps updating while the manager is minimised", async () => {
    await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => !x[Symbol.for(tag)] && x.getTitle().startsWith("Matchframe Esports"))?.minimize(), TAG);
    const clockText = () => frameEval(`document.querySelector(".clock-time").textContent`);
    const a = await clockText();
    await sleep(3500);
    const b = await clockText();
    const visible = await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay")?.isVisible(), TAG);
    check("the desktop HUD keeps updating while the manager is minimised", visible && a !== b, { before: a, after: b, visible });
    await app.evaluate(({ BrowserWindow }, tag) => {
      const m = BrowserWindow.getAllWindows().find((x) => !x[Symbol.for(tag)] && x.getTitle().startsWith("Matchframe Esports"));
      m?.restore();
    }, TAG);
    await frontGame();
  });

  // ---------------------------------------------------------------- OBS output
  // OBS is not needed (or installed): the browser-source URL is rendered the way OBS renders it.
  await step("browser-source URL (what OBS shows) renders transparent with only the HUD", async () => {
    const url = (await library()).huds.find((h) => h.id === SAMPLE).urls.live;
    // OBS renders browser sources offscreen with a transparent background, at the source size.
    const r = await app.evaluate(async ({ BrowserWindow }, { url, fn, pts }) => {
      const w = new BrowserWindow({ show: false, width: 1920, height: 1080, useContentSize: true, enableLargerThanScreen: true, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true } });
      globalThis.__mfObs = w;
      await w.loadURL(url);
      const until = Date.now() + 10000;
      while (Date.now() < until && !(await w.webContents.executeJavaScript("window.__mfOverlay?.status().frameLoaded === true"))) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1500));
      return eval(fn)(w.webContents, pts);
    }, { url, fn: ALPHA_AT_HUD_POINTS, pts: HUD_POINTS });
    const counted = await waitFor(async () => ((await library()).huds.find((h) => h.id === SAMPLE).outputs.obs >= 1 ? true : null), 10000).catch(() => false);
    check("browser-source URL (what OBS shows) renders transparent with only the HUD", r.center === 0 && r.scorebug > 0 && counted, { ...r, countedAsBrowserSourceOutput: counted });
  });

  // ---------------------------------------------------------------- outputs are independent
  await step("hiding the desktop HUD leaves the browser-source output alone", async () => {
    if (isWin) {
      await frontGame();
      await refreshBounds();
      panel = toScreen(HUD_POINTS.panel);
    }
    await win.evaluate((id) => window.matchframe.hud.setVisible(id, false), SAMPLE);
    await sleep(500);
    const visible = await app.evaluate(({ BrowserWindow }, tag) => BrowserWindow.getAllWindows().find((x) => x[Symbol.for(tag)]?.kind === "overlay")?.isVisible(), TAG);
    const obsHidden = await app.evaluate(() => globalThis.__mfObs.webContents.executeJavaScript("window.__mfOverlay.status().hidden"));
    check("hiding the desktop HUD leaves the browser-source output alone", visible === false && obsHidden === false, { desktopVisible: visible, browserSourceHidden: obsHidden });
    if (isWin) {
      await sleep(300);
      const [gamePixel] = await screenPixels([panel]);
      check("real pixels: with the desktop HUD hidden the game shows everywhere", isMagenta(gamePixel), { pixel: gamePixel, windowAtPoint: windowAt(panel.x, panel.y) }, { soft: true });
    }
    await win.evaluate((id) => window.matchframe.hud.setVisible(id, true), SAMPLE);
  });

  // ---------------------------------------------------------------- hide all (emergency hide)
  await step("emergency hide hides every HUD graphic, desktop and browser source", async () => {
    // The hotkey is pressed for real on Windows; elsewhere the same engine call is made directly.
    let via = "api";
    let hidden = false;
    if (isWin) {
      pressHotkey(0x78); // Ctrl+Shift+F9
      hidden = await waitFor(async () => ((await library()).hiddenAll ? true : null), 5000).catch(() => false);
      check("emergency hide hotkey (Ctrl+Shift+F9) works while the game has focus", hidden, hidden ? null : "no effect", { soft: true });
      via = hidden ? "hotkey" : "api (the hotkey had no effect)";
    }
    if (!hidden) await api("/api/v1/hud/library/visibility", { method: "POST", body: JSON.stringify({ hidden: true }) });
    const obsHidden = await waitFor(() => app.evaluate(() => globalThis.__mfObs.webContents.executeJavaScript("window.__mfOverlay.status().hidden")), 5000).catch(() => false);
    const deskHidden = await waitFor(() => wrapperEval("window.__mfOverlay.status().hidden"), 5000).catch(() => false);
    check("emergency hide hides every HUD graphic, desktop and browser source", obsHidden && deskHidden, { via, browserSourceHidden: obsHidden, desktopHidden: deskHidden });
    if (isWin && hidden) pressHotkey(0x78);
    else await api("/api/v1/hud/library/visibility", { method: "POST", body: JSON.stringify({ hidden: false }) });
    await win.evaluate(() => window.matchframe.hud.showAll());
    await waitFor(async () => (!(await library()).hiddenAll ? true : null), 5000);
  });

  // ---------------------------------------------------------------- recovery
  await step("outputs recover after the engine restarts", async () => {
    const t0 = Date.now();
    const asked = await win.evaluate(() => window.matchframe.restartEngine());
    await sleep(1500);
    try {
      await waitFor(() => fetch(`http://127.0.0.1:${PORTS.api}/api/v1/health`).then((r) => r.ok), 60000);
    } catch (e) {
      // Who holds the ports, and which program processes exist, when the engine does not come back.
      if (isWin) {
        info.restartDiagnostics = {
          restartAccepted: asked,
          ports: execFileSync("cmd.exe", ["/c", `netstat -ano | findstr ":${PORTS.api} :${PORTS.overlay} :${PORTS.gsi}"`], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).slice(0, 30),
          processes: execFileSync("tasklist.exe", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq Matchframe Esports.exe"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean),
        };
        console.log("restart diagnostics: " + JSON.stringify(info.restartDiagnostics, null, 1));
      }
      throw e;
    }
    info.engineRestartSeconds = Math.round((Date.now() - t0) / 100) / 10;
    await api("/api/v1/simulation/start", { method: "POST", body: JSON.stringify({ startOffsetSec: 25 }) }).catch(() => null);
    const desk = await waitFor(async () => {
      const s = await wrapperEval("window.__mfOverlay.status()");
      return s?.connected && s.frameLoaded ? s : null;
    }, 45000);
    const obs = await waitFor(async () => {
      const s = await app.evaluate(() => globalThis.__mfObs.webContents.executeJavaScript("window.__mfOverlay.status()"));
      return s?.connected ? s : null;
    }, 45000);
    const a = await frameEval(`document.querySelector(".clock-time").textContent`);
    await sleep(2500);
    const b = await frameEval(`document.querySelector(".clock-time").textContent`);
    check("outputs recover after the engine restarts", desk.connected && obs.connected && a !== b, { engineBackAfterSeconds: info.engineRestartSeconds, desktop: desk.connected, browserSource: obs.connected, clock: [a, b] });
  });

  // ---------------------------------------------------------------- stop
  await step("Stop HUD closes the desktop window; the browser source stays connected but shows nothing", async () => {
    await win.evaluate((id) => window.matchframe.hud.close(id), SAMPLE);
    await api(`/api/v1/hud/library/${SAMPLE}/stop`, { method: "POST" });
    const gone = await waitFor(() => app.evaluate(({ BrowserWindow }, tag) => !BrowserWindow.getAllWindows().some((x) => x[Symbol.for(tag)]?.kind === "overlay"), TAG), 5000).catch(() => false);
    const obs = await waitFor(async () => {
      const s = await app.evaluate(() => globalThis.__mfObs.webContents.executeJavaScript("window.__mfOverlay.status()"));
      return s?.stopped ? s : null;
    }, 5000).catch(() => null);
    check("Stop HUD closes the desktop window; the browser source stays connected but shows nothing", gone && obs?.stopped && obs.connected && !obs.frameLoaded, { windowClosed: gone, browserSource: obs });
  });

  await app.evaluate(() => {
    globalThis.__mfObs?.destroy();
    globalThis.__mfFake?.destroy();
  });
  info.consoleErrors = errors;
}
