import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, Notification, powerMonitor, protocol, safeStorage, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
// Folders under either spelling of the product name (an upgraded computer keeps the ones it has).
import { brandedFolder } from "../../../services/local-engine/src/brand.ts";
import { OutputTail } from "./crash/report.ts";
import { CrashReports, startNativeCrashReporter } from "./crash/reporter.ts";
import { HotkeyManager } from "./hud/hotkeys.ts";
import { registerHudIpc } from "./hud/ipc.ts";
import { OverlayManager } from "./hud/overlays.ts";
import { OverlayStore } from "./hud/store.ts";
import type { Library } from "./hud/types.ts";
import { hlaeInfo, processRunning, startCs2, type LaunchResult, type PreparedLaunch } from "./game-launch.ts";
import { createHlaeManager, launchWithHlae, type HlaeManager, type ManagedHlae } from "./hlae-manager.ts";
import { engineExecArgv, parsePerformanceMessage } from "./low-spec.ts";
import { DEVICE_ACTION, HIGHLIGHT_KEY_ACTIONS, MAP_INTRO_KEY_ACTIONS, ReplayHotkeys, TEAM_KEY_ACTIONS, type ReplayKeyAction, type ReplayKeys } from "./replay-hotkeys.ts";
import { createRollback, type Rollback } from "./rollback.ts";
import { createTray, type ProgramTray } from "./tray.ts";
import { desktopLocale, parseLanguagePref, section, setDesktopLanguage, t } from "./i18n.ts";
import { isLanguagePref, type LanguagePref } from "../../operator-web/src/i18n/core.ts";
import { createUpdater, type Updater } from "./updater.ts";
import { parseChannel, type UpdateChannel } from "./versions.ts";

/**
 * MatchFrame Esports program (Windows desktop app). The operator console is bundled into the
 * program and shown from its own `app://matchframe` origin; it is never served to browsers. API and
 * asset requests from the console are forwarded to the engine: the one this program supervises
 * (local mode) or the one on the production computer (remote mode, for multi-PC productions). The
 * renderer never gets Node access; a narrow preload bridge exposes a few calls. A restarted engine
 * never issues scene or camera commands (it starts in manual/disarmed mode by design).
 *
 * Desktop HUDs (hud/overlays.ts) are separate transparent windows over the game; they keep running
 * while the manager window is minimised or closed to the tray. Quitting closes them all and waits
 * for the engine (and so the HUD server) to stop.
 */

const isDev = !app.isPackaged;
const PORTS = { gsi: Number(process.env.MATCHFRAME_GSI_PORT ?? 37210), api: Number(process.env.MATCHFRAME_API_PORT ?? 37211), overlay: Number(process.env.MATCHFRAME_OVERLAY_PORT ?? 37212) };
const LOCAL_ENGINE = `http://127.0.0.1:${PORTS.api}`;
const APP_ORIGIN = "app://matchframe";
const EMERGENCY_HOTKEY = process.env.MATCHFRAME_STOP_HOTKEY ?? "CommandOrControl+Shift+F12";
/** Saves where the camera is in CS2 now as one of your cameras (works while CS2 has the focus). */
const SAVE_VIEW_HOTKEY = process.env.MATCHFRAME_SAVE_VIEW_HOTKEY ?? "CommandOrControl+Shift+F11";

/** Engine data folder; the program's own settings (credential key, connection, browser storage) live in its `program` subfolder. */
// An upgraded computer keeps its "Matchframe Esports" folder as it is on disk: the paths stored in the
// engine's database and settings stay exactly the same (brandedFolder).
const dataDir = () => process.env.MATCHFRAME_DATA_DIR ?? brandedFolder(app.getPath("appData"), "MatchFrame Esports");
/** The user's Videos folder: the engine puts highlight reels in "MatchFrame Highlights" there (null when the system has none). */
const videosDir = (): string | null => {
  try {
    return process.env.MATCHFRAME_VIDEOS_DIR || app.getPath("videos");
  } catch {
    return null;
  }
};
app.setPath("userData", join(dataDir(), "program"));
// Native crashes (ADR-077): minidumps on this computer only; crash reports decide whether one is sent.
startNativeCrashReporter(join(app.getPath("userData"), "Crashpad"));

// HUD outputs must keep animating and receiving data while the manager is minimised or covered by
// the game: no background throttling of timers, renderers or occluded windows.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// Must run before the app is ready: a standard, secure scheme with fetch support for the console.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

type Connection = { mode: "local" } | { mode: "remote"; url: string; token: string };

let engine: ChildProcess | null = null;
let engineWanted = false;
let operatorToken: string | null = null;
let connection: Connection = { mode: "local" };
let win: BrowserWindow | null = null;
let restarts = 0;
let quitting = false;
let engineStopped = false;
let overlays: OverlayManager | null = null;
let hotkeys: HotkeyManager | null = null;
let tray: ProgramTray | null = null;
let updater: Updater | null = null;
let rollback: Rollback | null = null;
/** The program's own HLAE (ADR-084): Get HLAE, and newer versions when CS2 updates break the old one. */
const hlae: HlaeManager = createHlaeManager({
  root: join(app.getPath("userData"), "hlae-program"),
  fetch: (url, init) => net.fetch(url, init),
  read: () => {
    const s = readProgramSettings();
    return { hlaePath: s.hlaePath, hlaeManaged: s.hlaeManaged, hlaeAutoUpdate: s.hlaeAutoUpdate };
  },
  write: (patch) => writeProgramSettings(patch),
  cs2Running: () => processRunning("cs2.exe"),
});
let replayKeys: ReplayHotkeys | null = null;
/** The credential key handed to the engine (kept so crash reports can be checked for it). */
let masterKey: string | null = null;
/** Engine processes asked to stop (restart, remote mode, quit): their exit is not a crash. */
const stopRequested = new WeakSet<ChildProcess>();
/** Windows is logging off or shutting down (Electron sends no before-quit then): what stops now is not a crash. */
let sessionEnding = false;
/** Low-spec mode's frame cap for the desktop HUD windows, as the engine last said (ADR-078). */
let hudFrameCap: number | null = null;

/** Small program preferences (not engine settings): `<userData>/program-settings.json`. */
interface ProgramSettings {
  autoDownloadUpdates: boolean;
  /** Stable (default) or Beta: GitHub prereleases too (ADR-076). */
  updateChannel: UpdateChannel;
  /** HLAE.exe for the Start CS2 HLAE mode (chosen by the operator, or the program's own HLAE). */
  hlaePath: string | null;
  /** The HLAE the program downloaded (ADR-084), in `<userData>/hlae-program/<version>`. */
  hlaeManaged: ManagedHlae | null;
  /** Look for a newer HLAE when the program starts and before Start CS2 (ADR-084); on unless turned off. */
  hlaeAutoUpdate: boolean;
  /** The engine listens on the network (a replay PC or another operator position connects), not only on this computer. */
  networkAccess: boolean;
  /** Global hotkeys for the replays playing (replay-hotkeys.ts); off unless set. */
  replayHotkeys: Partial<ReplayKeys>;
  /** Send crash reports (ADR-077); off unless the operator turns it on. */
  crashReports: boolean;
  /** The engine's low-spec mode as it last said (ADR-078): the engine starts with a memory cap when on. */
  lowSpec: boolean;
  /** The console's Language setting (ADR-082): "system" or a language; the tray, dialogs and notifications follow it. */
  language: LanguagePref;
}
const programSettingsFile = () => join(app.getPath("userData"), "program-settings.json");
function readProgramSettings(): ProgramSettings {
  try {
    const raw = JSON.parse(readFileSync(programSettingsFile(), "utf8")) as Partial<ProgramSettings>;
    return {
      autoDownloadUpdates: raw.autoDownloadUpdates !== false,
      updateChannel: parseChannel(raw.updateChannel),
      hlaePath: typeof raw.hlaePath === "string" ? raw.hlaePath : null,
      hlaeManaged: parseManagedHlae(raw.hlaeManaged),
      hlaeAutoUpdate: raw.hlaeAutoUpdate !== false,
      networkAccess: raw.networkAccess === true,
      replayHotkeys: raw.replayHotkeys && typeof raw.replayHotkeys === "object" ? raw.replayHotkeys : {},
      crashReports: raw.crashReports === true,
      lowSpec: raw.lowSpec === true,
      language: parseLanguagePref(raw.language),
    };
  } catch {
    return { autoDownloadUpdates: true, updateChannel: "stable", hlaePath: null, hlaeManaged: null, hlaeAutoUpdate: true, networkAccess: false, replayHotkeys: {}, crashReports: false, lowSpec: false, language: "system" };
  }
}
function parseManagedHlae(v: unknown): ManagedHlae | null {
  const m = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  return m && typeof m.version === "string" && typeof m.dir === "string" && typeof m.exe === "string" ? { version: m.version, dir: m.dir, exe: m.exe, installedAt: typeof m.installedAt === "string" ? m.installedAt : "" } : null;
}
function writeProgramSettings(patch: Partial<ProgramSettings>): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(programSettingsFile(), JSON.stringify({ ...readProgramSettings(), ...patch }, null, 2));
}

function resourcesPath(...p: string[]): string {
  return isDev ? join(app.getAppPath(), "..", "..", ...p) : join(process.resourcesPath, ...p);
}

const consoleDir = () => resourcesPath(isDev ? "apps/operator-web/dist" : "operator-web");
const iconFile = () => (isDev ? join(app.getAppPath(), "build", "icon.png") : resourcesPath("icon.png"));
/** HUD packages installed into the library on first start (each folder holds package folders). */
const sampleHudDirs = () => (isDev ? [resourcesPath("assets", "hud-packages"), resourcesPath("apps", "hud-template", "dist"), resourcesPath("apps", "hud-designs", "dist")] : [resourcesPath("sample-huds")]);
const connectDir = () => resourcesPath(isDev ? "apps/desktop/connect" : "connect");

/** Master key for encrypting stored credentials, protected by the OS credential store. */
function secretKey(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "credential-key.bin");
  if (existsSync(file)) return safeStorage.decryptString(readFileSync(file));
  const key = randomBytes(32).toString("hex");
  writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  return key;
}

/**
 * Release builds ship `cloud.json` ({ url, publicKeys }) so the website address and the licence
 * signing keys are pinned and cannot be swapped for another server. Environment variables win.
 */
function cloudReleaseConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = resourcesPath(isDev ? "config/cloud.json" : "cloud.json");
  if (!existsSync(file)) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; publicKeys?: unknown };
    const out: NodeJS.ProcessEnv = {};
    if (typeof cfg.url === "string" && !env.MATCHFRAME_CLOUD_URL) out.MATCHFRAME_CLOUD_URL = cfg.url;
    if (cfg.publicKeys && typeof cfg.publicKeys === "object" && !env.MATCHFRAME_CLOUD_PUBLIC_KEYS) out.MATCHFRAME_CLOUD_PUBLIC_KEYS = JSON.stringify(cfg.publicKeys);
    return out;
  } catch (e) {
    dialog.showErrorBox("MatchFrame", t("dialog.cloudConfig", { error: e instanceof Error ? e.message : String(e) }));
    return {};
  }
}

/** The website this build is pinned to (crash reports sent without the engine, e.g. in remote mode). */
function pinnedCloudUrl(): string | null {
  const env = process.env.MATCHFRAME_CLOUD_URL?.trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(resourcesPath(isDev ? "config/cloud.json" : "cloud.json"), "utf8")) as { url?: unknown };
    return typeof cfg.url === "string" && cfg.url ? cfg.url : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ crash reports (ADR-077)

const crashReports = new CrashReports(
  {
    enabled: () => readProgramSettings().crashReports,
    saveEnabled: (on) => writeProgramSettings({ crashReports: on }),
    engineReady: () => connection.mode === "local" && !!engine && !!operatorToken,
    supportFile: () => engineRequest<Record<string, unknown>>("GET", "/api/v1/diagnostics/bundle"),
    credentials: () => askEngine<{ url: string | null; token: string | null; secrets: string[] }>("cloud-credentials"),
    fixedUrl: pinnedCloudUrl,
    ownSecrets: () => [operatorToken, connection.mode === "remote" ? connection.token : null, masterKey],
    window: () => (win && !win.isDestroyed() ? win : null),
    connectionMode: () => connection.mode,
    quitting: () => quitting || sessionEnding,
    log: (msg) => console.log(msg),
    fetch: ((url: string, init?: RequestInit) => net.fetch(url, init)) as typeof fetch,
  },
  { queue: join(app.getPath("userData"), "crash-reports"), dumps: app.getPath("crashDumps") },
);
process.on("uncaughtException", (e) => crashReports.recordMainException(e));

// ------------------------------------------------------------------ connection (local / remote)

const connectionFile = () => join(app.getPath("userData"), "connection.json");

/** The remote access token is stored encrypted with the OS credential store when available. */
function loadConnection(): Connection {
  if (process.env.MATCHFRAME_REMOTE_URL && process.env.MATCHFRAME_REMOTE_TOKEN) return { mode: "remote", url: normalizeUrl(process.env.MATCHFRAME_REMOTE_URL), token: process.env.MATCHFRAME_REMOTE_TOKEN };
  try {
    const raw = JSON.parse(readFileSync(connectionFile(), "utf8")) as { mode?: string; url?: string; token?: string; tokenEnc?: string };
    if (raw.mode === "remote" && raw.url) {
      const token = raw.tokenEnc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.tokenEnc, "base64")) : raw.token;
      if (token) return { mode: "remote", url: normalizeUrl(raw.url), token };
    }
  } catch {
    // Missing or unreadable: this computer runs the production.
  }
  return { mode: "local" };
}

function saveConnection(c: Connection): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const data = c.mode === "local" ? { mode: "local" } : safeStorage.isEncryptionAvailable() ? { mode: "remote", url: c.url, tokenEnc: safeStorage.encryptString(c.token).toString("base64") } : { mode: "remote", url: c.url, token: c.token };
  writeFileSync(connectionFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function normalizeUrl(u: string): string {
  const url = new URL(/^https?:\/\//i.test(u.trim()) ? u.trim() : `http://${u.trim()}`);
  if (!url.port && url.protocol === "http:") url.port = String(PORTS.api);
  return url.origin;
}

const engineOrigin = () => (connection.mode === "remote" ? connection.url : LOCAL_ENGINE);
const accessToken = () => (connection.mode === "remote" ? connection.token : operatorToken);

// ------------------------------------------------------------------ app:// origin (console + API forwarding)

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function consoleCsp(): string {
  // HUD thumbnails and previews come from the HUD server: this computer's, or in remote mode the
  // production computer's (its HUD port is its own setting, hence any port on that host).
  const remote = connection.mode === "remote" ? new URL(connection.url) : null;
  const overlays = `http://127.0.0.1:${PORTS.overlay} http://localhost:${PORTS.overlay}${remote ? ` ${remote.protocol}//${remote.hostname}:*` : ""}`;
  const ws = engineOrigin().replace(/^http/, "ws");
  return `default-src 'self'; img-src 'self' data: blob: ${overlays}; style-src 'self' 'unsafe-inline'; connect-src 'self' ${ws}; frame-src ${overlays}; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

function serveFrom(root: string, pathname: string, spa: boolean): Response {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  const base = resolve(root);
  let file = resolve(base, `.${rel}`);
  if (file !== base && !file.startsWith(base + sep)) return new Response("not found", { status: 404 });
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (spa && !extname(rel)) file = join(base, "index.html");
    else if (existsSync(join(file, "index.html"))) file = join(file, "index.html");
    else return new Response("not found", { status: 404 });
  }
  if (!existsSync(file)) return new Response(`Console files are missing (${root}). Reinstall MatchFrame.`, { status: 500 });
  const html = file.endsWith(".html");
  return new Response(readFileSync(file), {
    headers: { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": html ? "no-store" : "public, max-age=300", ...(html ? { "content-security-policy": consoleCsp() } : {}) },
  });
}

/** Request headers passed on to the engine (Chromium's network stack refuses forwarded Origin/Host and friends). */
const FORWARDED_HEADERS = ["authorization", "content-type", "accept", "x-matchframe-token", "if-none-match", "range"];

async function forwardToEngine(req: Request, url: URL): Promise<Response> {
  // Requests from the main process carry no browser Origin; the engine treats them like any other
  // authenticated non-browser client. Only the program's own pages can reach app://matchframe.
  const headers = new Headers();
  for (const h of FORWARDED_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  try {
    return await net.fetch(engineOrigin() + url.pathname + url.search, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      bypassCustomProtocolHandlers: true,
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit & { bypassCustomProtocolHandlers: boolean });
  } catch (e) {
    const where = connection.mode === "remote" ? `the production computer at ${connection.url}` : "the MatchFrame engine on this computer";
    return Response.json({ error: "engine_unreachable", message: `Cannot reach ${where}: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

function registerAppProtocol(): void {
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    if (url.host !== "matchframe") return new Response("not found", { status: 404 });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon-pack/")) return forwardToEngine(req, url);
    if (url.pathname === "/connect" || url.pathname.startsWith("/connect/")) return serveFrom(connectDir(), url.pathname === "/connect" || url.pathname === "/connect/" ? "/connect.html" : url.pathname.slice("/connect".length), false);
    return serveFrom(consoleDir(), url.pathname, true);
  });
}

const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent, path = "/") => (e.senderFrame?.url ?? "").startsWith(APP_ORIGIN + path);

// ------------------------------------------------------------------ engine supervision (local mode)

function startEngine(): void {
  if (engine) return;
  engineWanted = true;
  const enginePath = isDev ? resourcesPath("services", "local-engine", "src", "main.ts") : resourcesPath("engine", "engine.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    MATCHFRAME_ENGINE_MAIN: "1",
    MATCHFRAME_DATA_DIR: dataDir(),
    MATCHFRAME_CAPTAIN_UI_DIR: resourcesPath(isDev ? "apps/operator-web/dist-captain" : "captain-web"),
    MATCHFRAME_HUD_DIR: resourcesPath(isDev ? "apps/hud-renderer/dist" : "hud-renderer"),
    MATCHFRAME_SAMPLE_HUDS_DIR: sampleHudDirs().join(delimiter),
    MATCHFRAME_MAP_PACK_DIR: resourcesPath(isDev ? "assets/map-packs" : "map-packs"),
    MATCHFRAME_RADAR_DIR: resourcesPath(isDev ? "assets/radars" : "radars"),
    MATCHFRAME_UTILITY_PROFILES: resourcesPath(isDev ? "assets/utility-profiles/measured.json" : "utility-profiles/measured.json"),
    MATCHFRAME_MODELS_DIR: resourcesPath(isDev ? "assets/models" : "models"),
    MATCHFRAME_WORKERS_DIR: resourcesPath("workers"),
    // The Test replays button's two sample clips.
    MATCHFRAME_REPLAY_TEST_DIR: resourcesPath(isDev ? "assets/replay-test" : "replay-test"),
    // Team Comms' TeamSpeak plugin as the program ships it (Install TeamSpeak plugin copies it into TeamSpeak's folder).
    MATCHFRAME_TS3_PLUGIN_DIR: resourcesPath(isDev ? "native/ts3-matchframe-plugin/dist" : "ts3-plugin"),
    MATCHFRAME_GSI_PORT: String(PORTS.gsi),
    MATCHFRAME_API_PORT: String(PORTS.api),
    MATCHFRAME_OVERLAY_PORT: String(PORTS.overlay),
    ...(videosDir() ? { MATCHFRAME_VIDEOS_DIR: videosDir()! } : {}),
  };
  // Network access: every interface (access still needs a token); otherwise this computer only.
  if (readProgramSettings().networkAccess && !process.env.MATCHFRAME_HOST) env.MATCHFRAME_HOST = "0.0.0.0";
  const key = secretKey();
  if (key) env.MATCHFRAME_SECRET_KEY = key;
  masterKey = key ?? null;
  Object.assign(env, cloudReleaseConfig(env));
  // Low-spec mode (ADR-078): the engine starts with a memory cap (the setting as the engine last said).
  const { execArgv, heapCapMb } = engineExecArgv(isDev ? ["--import", "tsx"] : [], readProgramSettings().lowSpec, totalmem());
  if (heapCapMb !== null) env.MATCHFRAME_ENGINE_HEAP_CAP_MB = String(heapCapMb);
  const child = fork(enginePath, [], { env, execPath: process.execPath, execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  engine = child;
  const startedAt = Date.now();
  // Its last lines, for a crash report if it stops unexpectedly.
  const tail = new OutputTail();
  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(d);
    tail.push(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    tail.push(d);
  });
  child.on("message", (m: { type?: string; operatorToken?: string; message?: string }) => {
    if (m?.type === "ready") {
      operatorToken = m.operatorToken ?? null;
      restarts = 0;
      if (connection.mode === "local") showConsole();
      crashReports.engineStarted();
    }
    // The data was saved by a newer version (ADR-076): the engine didn't open it, and starting it
    // again can't help.
    if (m?.type === "fatal") {
      engineWanted = false;
      // A refusal, not a crash: no crash report for this exit.
      stopRequested.add(child);
      void showNewerDataRefusal(m.message ?? "Your data is from a newer version of MatchFrame.");
    }
    // Low-spec mode on or off: the desktop HUD windows' frame rate now, the memory cap from the next engine start.
    const perf = parsePerformanceMessage(m);
    if (perf) {
      if (readProgramSettings().lowSpec !== perf.lowSpec) writeProgramSettings({ lowSpec: perf.lowSpec });
      hudFrameCap = perf.frameCap;
      overlays?.setFrameCap(perf.frameCap);
    }
  });
  child.on("exit", (code, signal) => {
    if (engine === child) engine = null;
    // Unexpected: nobody asked it to stop, and it didn't stop itself cleanly (exit code 0 only follows a shutdown request or signal).
    if (!quitting && !sessionEnding && !stopRequested.has(child) && (code !== 0 || signal !== null)) crashReports.recordEngineExit({ code, signal, uptimeMs: Date.now() - startedAt, output: tail.snapshot() });
    // The HUD server stopped with the engine: desktop HUD windows reconnect when it is back.
    if (quitting || !engineWanted) return;
    restarts++;
    const delay = Math.min(15000, 500 * 2 ** Math.min(restarts, 5));
    console.error(`engine exited (code ${code}); restarting in ${delay} ms (automation stays disarmed)`);
    win?.webContents.send("mf:engine-status", { state: "restarting", code, delayMs: delay });
    if (restarts > 8) {
      void dialog.showMessageBox({ type: "error", message: t("dialog.engineKeepsStopping"), detail: t("dialog.engineKeepsStoppingDetail") });
    }
    setTimeout(() => engineWanted && startEngine(), delay);
  });
}

function stopEngine(): void {
  engineWanted = false;
  operatorToken = null;
  if (engine) stopRequested.add(engine);
  engine?.send({ type: "shutdown" });
}

/** Stops the engine and resolves once it has exited (Go back to a previous version restores data with it stopped). */
function stopEngineAndWait(): Promise<void> {
  const child = engine;
  engineWanted = false;
  operatorToken = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  // Asked to stop (going back to a previous version): not a crash.
  stopRequested.add(child);
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.exitCode === null && child.kill(), 8000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    try {
      child.send({ type: "shutdown" });
    } catch {
      child.kill();
    }
  });
}

let ipcSeq = 0;

/** A question to the engine over the IPC channel (never HTTP); null when it is not running or doesn't answer in time. */
function askEngine<T>(type: string, timeoutMs = 3000): Promise<T | null> {
  const child = engine;
  if (!child || !child.connected || connection.mode !== "local") return Promise.resolve(null);
  const id = ++ipcSeq;
  return new Promise((resolveAnswer) => {
    const done = (v: T | null) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      resolveAnswer(v);
    };
    const onMessage = (m: unknown) => {
      const msg = m as { type?: unknown; id?: unknown } | null;
      if (msg?.type === type && msg.id === id) done(m as T);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    child.on("message", onMessage);
    try {
      child.send({ type, id });
    } catch {
      done(null);
    }
  });
}

const RELEASES_PAGE = "https://github.com/MalakaiCS/Matchframe-Esports/releases";

async function showNewerDataRefusal(message: string): Promise<void> {
  const r = await dialog.showMessageBox({
    type: "error",
    title: t("dialog.newerDataTitle"),
    message: t("dialog.newerDataMessage"),
    detail: message,
    buttons: [t("dialog.openReleases"), t("dialog.quit")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response === 0) await shell.openExternal(RELEASES_PAGE);
  app.quit();
}

// ------------------------------------------------------------------ window

/** Height of the console's header, where the window buttons sit (title bar drawn by the console). */
const TITLE_BAR_HEIGHT = 56;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#161719",
    title: windowTitle(),
    // No system title bar or menu bar: the console's header is the title bar (drag region) and the
    // system window buttons are drawn over its right end in the program's colours.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? {} : { titleBarOverlay: { color: "#161719", symbolColor: "#a8abb2", height: TITLE_BAR_HEIGHT } }),
    autoHideMenuBar: true,
    // Packaged Windows builds take the icon from the .exe (build/icon.ico); development runs need it set.
    ...(isDev ? { icon: join(app.getAppPath(), "build", "icon.png") } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Live data (status bar, HUD previews) keeps updating while the manager is in the background.
      backgroundThrottling: false,
    },
  });
  // Only the program's own pages may be shown in the window; links to websites open in the browser.
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN + "/")) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url) || (isDev && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))) void shell.openExternal(url);
    // Team Comms (ADR-069): a team's TeamSpeak link as MatchFrame makes it (server, port, nickname, channel; no password): TeamSpeak opens it.
    else if (/^ts3server:\/\/[A-Za-z0-9.\-[\]:]+\?port=\d{1,5}&nickname=[^&\s]*&channel=[^&\s]*$/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.setMenuBarVisibility(false);
  w.on("page-title-updated", (e) => e.preventDefault());
  // A console form with unsaved changes holds the window open (beforeunload): ask before closing or reloading.
  w.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(w, {
      type: "question",
      buttons: [t("dialog.keepEditing"), t("dialog.discard")],
      defaultId: 0,
      cancelId: 0,
      title: t("dialog.unsavedTitle"),
      message: t("dialog.unsavedMessage"),
      detail: t("dialog.unsavedDetail"),
    });
    // preventDefault here lets the window close despite the page's beforeunload.
    if (choice === 1) e.preventDefault();
  });
  // Closing the manager while desktop HUDs run keeps them running: the program stays in the tray.
  w.on("close", (e) => {
    if (quitting || !tray || !overlays?.hasOutputs()) return;
    e.preventDefault();
    w.hide();
  });
  w.on("closed", () => (win = null));
  // Windows logging off or shutting down (the manager window gets this even when hidden to the tray).
  w.on("session-end", () => (sessionEnding = true));
  return w;
}

function windowTitle(): string {
  return connection.mode === "remote" ? t("window.remoteTitle", { host: new URL(connection.url).host }) : "MatchFrame Esports";
}

function showConsole(): void {
  win ??= createWindow();
  win.setTitle(windowTitle());
  void win.loadURL(`${APP_ORIGIN}/`);
}

/** Tray, second start and the HUD windows' "show manager": bring the manager window back. */
function showManager(): void {
  if (!win) {
    if (connection.mode === "remote" || operatorToken) showConsole();
    else showConnectionSettings();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showConnectionSettings(): void {
  win ??= createWindow();
  void win.loadURL(`${APP_ORIGIN}/connect`);
}

async function emergencyStop(): Promise<void> {
  const token = accessToken();
  if (!token) return;
  try {
    await net.fetch(`${engineOrigin()}/api/v1/observer/emergency-stop`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    win?.webContents.send("mf:emergency-stop", { at: Date.now() });
  } catch (e) {
    console.error("emergency stop request failed", e);
  }
}

/** A replay hotkey: the engine's control-surface action (the same as a Stream Deck button); a notification only when it can't. */
async function runReplayKey(action: ReplayKeyAction): Promise<void> {
  const token = accessToken();
  if (!token) return;
  let message: string | null = null;
  try {
    const res = await net.fetch(`${engineOrigin()}/api/v1/devices/actions/${DEVICE_ACTION[action]}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
    if (!res.ok) message = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`;
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (message && Notification.isSupported()) new Notification({ title: t(HIGHLIGHT_KEY_ACTIONS.includes(action) ? "notify.highlights" : TEAM_KEY_ACTIONS.includes(action) ? "notify.swapTeams" : MAP_INTRO_KEY_ACTIONS.includes(action) ? "notify.mapIntro" : "notify.replays"), body: message, silent: true }).show();
}

/** The save-view hotkey: the engine reads CS2's camera (getpos) and saves it; a notification says how it went. */
async function saveCs2View(): Promise<void> {
  const token = accessToken();
  if (!token) return;
  let title = t("notify.cameraNotSaved");
  let body: string;
  try {
    const res = await net.fetch(`${engineOrigin()}/api/v1/cameras/capture`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
    const json = (await res.json().catch(() => ({}))) as { displayName?: string; error?: { message?: string } };
    if (res.ok) {
      title = t("notify.cameraSaved");
      body = t("notify.cameraSavedBody", { name: json.displayName ?? t("notify.yourCamera") });
    } else body = json.error?.message ?? `HTTP ${res.status}`;
    win?.webContents.send("mf:camera-saved", { ok: res.ok, title, body });
  } catch (e) {
    body = e instanceof Error ? e.message : String(e);
  }
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}

// ------------------------------------------------------------------ desktop HUDs

/** Operator API call on the local engine from the main process (desktop HUD outputs only). */
async function engineRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (connection.mode !== "local") throw new Error(t("engine.remoteHuds"));
  if (!operatorToken) throw new Error(t("engine.starting"));
  let res: Response;
  try {
    res = await net.fetch(LOCAL_ENGINE + path, {
      method,
      headers: { authorization: `Bearer ${operatorToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(t("engine.unreachable", { error: e instanceof Error ? e.message : String(e) }), { cause: e });
  }
  const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? t("engine.http", { status: res.status }));
  return data as T;
}

const remoteReason = () => t("engine.remoteReason");

/** Desktop HUDs and their hotkeys work only when this computer runs the production. */
function applyConnectionToHuds(): void {
  if (!overlays || !hotkeys) return;
  if (connection.mode === "remote") {
    overlays.setDisabled(remoteReason());
    hotkeys.unregister();
  } else {
    overlays.setDisabled(null);
    hotkeys.register();
  }
  tray?.refresh();
}

let emergencyShown: string[] | null = null;

/**
 * Emergency hide (hotkey): hides every HUD graphic, desktop windows and OBS sources alike; pressing it
 * again shows them. The desktop windows are hidden here first so they disappear even if the engine
 * does not answer.
 */
async function toggleEmergencyHide(): Promise<void> {
  if (!overlays || !hotkeys) return;
  const hide = !hotkeys.emergencyHidden;
  hotkeys.emergencyHidden = hide;
  if (hide) emergencyShown = overlays.hideAll();
  else {
    overlays.showAll(emergencyShown ?? undefined);
    emergencyShown = null;
  }
  try {
    await engineRequest("POST", "/api/v1/hud/library/visibility", { hidden: hide });
  } catch (e) {
    console.error("emergency hide: the HUD server did not answer", e);
  }
}

function setUpDesktopHuds(): void {
  const store = new OverlayStore(join(app.getPath("userData"), "hud-overlays.json"), (e) => console.error("could not save desktop HUD settings", e));
  const om = new OverlayManager({
    library: () => engineRequest<Library>("GET", "/api/v1/hud/library"),
    start: async (hudId) => {
      await engineRequest("POST", `/api/v1/hud/library/${encodeURIComponent(hudId)}/start`);
    },
    store,
    push: (states) => {
      if (win && !win.isDestroyed()) win.webContents.send("mf:hud-overlays", states);
    },
    onChange: () => tray?.refresh(),
    ...(isDev ? { icon: iconFile() } : {}),
    devTools: isDev,
    log: (msg) => console.log(`[hud] ${msg}`),
  });
  overlays = om;
  om.init();
  om.setFrameCap(hudFrameCap);
  const hk = new HotkeyManager({ store, reserved: [EMERGENCY_HOTKEY, SAVE_VIEW_HOTKEY], onToggle: () => om.toggleAll(), onEmergencyHide: () => void toggleEmergencyHide(), log: (msg) => console.error(`[hud] ${msg}`) });
  hotkeys = hk;
  registerHudIpc({
    overlays: om,
    hotkeys: hk,
    allowed: (e) => fromApp(e) && !fromApp(e, "/connect"),
    window: () => win,
    dataDir,
    unavailableReason: () => (connection.mode === "remote" ? remoteReason() : null),
    library: () => engineRequest<Library>("GET", "/api/v1/hud/library"),
    hideAll: () => void om.hideAll(),
    showAll: () => {
      hk.emergencyHidden = false;
      emergencyShown = null;
      om.showAll();
    },
    stopAll: () => om.stopAll(),
  });
  tray = createTray({
    iconPath: iconFile(),
    showManager,
    toggleHud: () => om.toggleAll(),
    stopHud: () => om.stopAll(),
    quit: () => app.quit(),
    state: () => ({ open: om.hasOpenOverlays(), visible: om.anyVisible(), outputs: om.hasOutputs() }),
    log: (msg) => console.error(`[tray] ${msg}`),
  });
  applyConnectionToHuds();
}

// ------------------------------------------------------------------ language (ADR-082)

/** The computer's preferred languages (Windows display language first). */
function systemLanguages(): string[] {
  try {
    const list = app.getPreferredSystemLanguages();
    return list.length ? list : [app.getLocale()];
  } catch {
    return [];
  }
}

/** The application menu (hidden; its items keep their accelerators) in the current language. */
function buildAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: t("menu.file"),
        submenu: [
          { label: t("menu.connection"), click: () => showConnectionSettings() },
          { label: t("menu.openData"), click: () => void shell.openPath(dataDir()) },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: t("menu.view"), submenu: [{ role: "reload" }, { role: "togglefullscreen" }, ...(isDev ? [{ role: "toggleDevTools" as const }] : [])] },
      {
        label: t("menu.automation"),
        submenu: [
          { label: t("menu.emergencyStop", { hotkey: EMERGENCY_HOTKEY }), click: () => void emergencyStop() },
          { label: t("menu.saveView", { hotkey: SAVE_VIEW_HOTKEY }), click: () => void saveCs2View() },
        ],
      },
    ]),
  );
}

/** Applies the saved Language setting to the shell: menu, tray and window title now; dialogs and notifications from now on. */
function applyLanguage(): { language: LanguagePref; locale: string } {
  const language = readProgramSettings().language;
  const locale = setDesktopLanguage(language, systemLanguages());
  buildAppMenu();
  tray?.refresh();
  if (win && !win.isDestroyed()) win.setTitle(windowTitle());
  return { language, locale };
}

// ------------------------------------------------------------------ IPC

ipcMain.on("mf:bootstrap", (event) => {
  event.returnValue = fromApp(event) ? { engineOrigin: engineOrigin(), connectionMode: connection.mode, language: readProgramSettings().language, systemLanguages: systemLanguages() } : null;
});
// Settings → General → Language (ADR-082): kept here, so the tray, dialogs and notifications follow it.
ipcMain.handle("mf:language-set", (event, pref: unknown) => {
  if (!fromApp(event) || fromApp(event, "/connect") || !isLanguagePref(pref)) return null;
  writeProgramSettings({ language: pref });
  return applyLanguage();
});
ipcMain.handle("mf:token", (event) => (fromApp(event) && !fromApp(event, "/connect") ? accessToken() : null));
ipcMain.handle("mf:info", () => ({ version: app.getVersion(), dataDir: dataDir(), emergencyHotkey: EMERGENCY_HOTKEY, saveViewHotkey: SAVE_VIEW_HOTKEY, ports: PORTS, packaged: app.isPackaged, connection: connection.mode === "remote" ? { mode: "remote", url: connection.url } : { mode: "local" } }));
ipcMain.handle("mf:update-state", (event) => (fromApp(event) && updater ? updater.state() : null));
ipcMain.handle("mf:update-check", (event) => (fromApp(event) && updater ? updater.check() : null));
ipcMain.handle("mf:update-download", (event) => (fromApp(event) && updater ? updater.download() : null));
ipcMain.handle("mf:update-install", (event) => {
  if (fromApp(event)) updater?.installNow();
});
ipcMain.handle("mf:update-auto", (event, on: unknown) => (fromApp(event) && updater && typeof on === "boolean" ? updater.setAutoDownload(on) : null));
ipcMain.handle("mf:update-channel", (event, channel: unknown) => (fromApp(event) && updater && (channel === "stable" || channel === "beta") ? updater.setChannel(channel) : null));
// Go back to a previous version (rollback.ts): `{ ok, value | error }`, as the desktop HUD calls.
ipcMain.handle("mf:rollback-list", async (event) => {
  if (!fromApp(event) || fromApp(event, "/connect") || !rollback) return { ok: false, error: "not available" };
  try {
    return { ok: true, value: await rollback.list() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle("mf:rollback-start", async (event, version: unknown, opts: unknown) => {
  if (!fromApp(event) || fromApp(event, "/connect") || !rollback || typeof version !== "string") return { ok: false, error: "not allowed" };
  const toStable = !!opts && typeof opts === "object" && (opts as { toStable?: unknown }).toStable === true;
  return { ok: true, value: await rollback.start(version, { toStable }) };
});
// Crash reports (ADR-077): the setting, what waits, and the ids of reports sent lately.
ipcMain.handle("mf:crash-reports", (event) => (fromApp(event) && !fromApp(event, "/connect") ? crashReports.state() : null));
ipcMain.handle("mf:crash-reports-set", (event, on: unknown) => (fromApp(event) && !fromApp(event, "/connect") && typeof on === "boolean" ? crashReports.setEnabled(on) : null));
// Start CS2: the engine prepares it (GSI config, launch options, console); this process starts
// Steam, or HLAE (a program the operator chose on this computer). Nothing else can be started.
ipcMain.handle("mf:launch-cs2", async (event) => {
  if (!fromApp(event)) return { ok: false, message: "not allowed" };
  if (connection.mode !== "local") return { ok: false, message: t("engine.launchRemote") };
  try {
    const prepared = await engineRequest<PreparedLaunch>("POST", "/api/v1/game/prepare-launch");
    return await launchWithHlaeUpdates(prepared);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
});
/** Start CS2; with the program's HLAE, a newer one first when there is one, and again after a failure (ADR-084). */
function launchWithHlaeUpdates(prepared: PreparedLaunch): Promise<LaunchResult> {
  return launchWithHlae({
    hlaeMode: prepared.plan.mode === "hlae",
    manager: hlae,
    start: () => {
      const s = readProgramSettings();
      return startCs2(prepared, { hlaePath: s.hlaePath, hlaeVersion: hlae.inUse() ? (s.hlaeManaged?.version ?? null) : null, openExternal: (url) => shell.openExternal(url) });
    },
  });
}
function hlaeState() {
  return { ...hlaeInfo(readProgramSettings().hlaePath), status: hlae.status() };
}
ipcMain.handle("mf:hlae-info", (event) => (fromApp(event) ? hlaeState() : null));
// Get HLAE / check for a newer one / keep it up to date (ADR-084): `{ ok, value | error }`.
ipcMain.handle("mf:hlae-get", async (event) => {
  if (!fromApp(event) || fromApp(event, "/connect") || connection.mode !== "local") return { ok: false, error: "not allowed" };
  try {
    await hlae.get();
    return { ok: true, value: hlaeState() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle("mf:hlae-check", async (event) => {
  if (!fromApp(event) || fromApp(event, "/connect") || connection.mode !== "local") return { ok: false, error: "not allowed" };
  const u = await hlae.update({ force: true, manual: true });
  if (!u.updated && u.reason === "error") return { ok: false, error: u.error };
  if (!u.updated && u.reason === "cs2_running") return { ok: false, error: t("hlae.cs2Running") };
  const result = u.updated ? t("hlae.updated", { from: u.from ?? "?", to: u.to }) : u.reason === "latest" ? t("hlae.latest", { version: u.version ?? "?" }) : undefined;
  return { ok: true, value: { ...hlaeState(), result } };
});
ipcMain.handle("mf:hlae-auto", (event, on: unknown) => {
  if (!fromApp(event) || fromApp(event, "/connect") || typeof on !== "boolean") return null;
  hlae.setAutoUpdate(on);
  return hlaeState();
});
// Replay hotkeys (replay-hotkeys.ts): `{ ok, value | error }`, as the desktop HUD calls.
ipcMain.handle("mf:replay-hotkeys", (event) => (fromApp(event) && replayKeys ? { ok: true, value: replayKeys.state() } : { ok: false, error: "not available" }));
ipcMain.handle("mf:replay-hotkeys-set", (event, patch: unknown) => {
  if (!fromApp(event) || fromApp(event, "/connect") || !replayKeys) return { ok: false, error: "not allowed" };
  try {
    return { ok: true, value: replayKeys.set(patch) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
// A folder on this computer (Storage: replays and highlights on another drive).
ipcMain.handle("mf:pick-directory", async (event, title: unknown) => {
  if (!fromApp(event) || fromApp(event, "/connect") || connection.mode !== "local" || !win) return null;
  const r = await dialog.showOpenDialog(win, { title: typeof title === "string" ? title.slice(0, 120) : t("dialog.chooseFolder"), properties: ["openDirectory", "createDirectory"] });
  return (r.canceled ? undefined : r.filePaths[0]) ?? null;
});
ipcMain.handle("mf:hlae-choose", async (event) => {
  if (!fromApp(event) || !win) return null;
  const r = await dialog.showOpenDialog(win, { title: t("dialog.chooseHlae"), properties: ["openFile"], filters: [{ name: "HLAE", extensions: ["exe"] }] });
  if (r.canceled || !r.filePaths[0]) return hlaeState();
  const info = hlaeInfo(r.filePaths[0]);
  if (!info.ok) return { ...info, status: hlae.status() };
  writeProgramSettings({ hlaePath: info.path });
  return hlaeState();
});
// Read by the preload script when the console loads (remote mode disables desktop HUDs).
ipcMain.on("mf:hud-availability", (event) => {
  event.returnValue = fromApp(event) && !fromApp(event, "/connect") ? { available: connection.mode === "local", reason: connection.mode === "remote" ? remoteReason() : null } : { available: false, reason: "not allowed" };
});
ipcMain.handle("mf:open-data-dir", () => shell.openPath(dataDir()));
// The highlight reels' folder: the one the engine says (a folder chosen under Storage), else its default
// rule (the Videos folder's "MatchFrame Highlights", else the data folder's).
ipcMain.handle("mf:open-highlights", (event, folder: unknown) => {
  if (!fromApp(event) || connection.mode !== "local") return null;
  if (typeof folder === "string" && isAbsolute(folder) && existsSync(folder) && statSync(folder).isDirectory()) return shell.openPath(folder);
  const videos = videosDir();
  const dir = videos ? brandedFolder(videos, "MatchFrame Highlights") : join(dataDir(), "exports", "highlights");
  mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
// Team Comms (ADR-069): TeamSpeak 3's plugins folder (made if missing), or the program's own plugin
// files (the .ts3_plugin package TeamSpeak's add-on installer opens), for installing the plugin by hand.
ipcMain.handle("mf:open-ts3-folder", (event, which: unknown) => {
  if (!fromApp(event) || connection.mode !== "local") return null;
  if (which === "package") return shell.openPath(resourcesPath(isDev ? "native/ts3-matchframe-plugin/dist" : "ts3-plugin"));
  const ts3 = process.platform === "win32" ? join(app.getPath("appData"), "TS3Client") : process.platform === "darwin" ? join(app.getPath("home"), "Library", "Application Support", "TeamSpeak 3") : join(app.getPath("home"), ".ts3client");
  const dir = join(ts3, "plugins");
  mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
function restartEngine(): boolean {
  if (connection.mode !== "local" || !engine) return false;
  const child = engine;
  stopRequested.add(child);
  child.send({ type: "shutdown" });
  // The supervisor restarts it on exit; an engine that does not stop is ended.
  const kill = setTimeout(() => child.exitCode === null && child.kill(), 8000);
  child.once("exit", () => clearTimeout(kill));
  return true;
}
ipcMain.handle("mf:restart-engine", () => restartEngine());
ipcMain.handle("mf:network-get", (event) => (fromApp(event) ? { networkAccess: readProgramSettings().networkAccess, local: connection.mode === "local" } : null));
ipcMain.handle("mf:network-set", (event, on: unknown) => {
  if (!fromApp(event) || typeof on !== "boolean" || connection.mode !== "local") return null;
  if (readProgramSettings().networkAccess !== on) {
    writeProgramSettings({ networkAccess: on });
    restartEngine();
  }
  return { networkAccess: on, local: true };
});
ipcMain.handle("mf:open-connection", (event) => {
  if (fromApp(event)) showConnectionSettings();
});

// Connection settings page (app://matchframe/connect) only.
ipcMain.handle("mf:connection-get", (event) => {
  if (!fromApp(event, "/connect")) return null;
  return { mode: connection.mode, url: connection.mode === "remote" ? connection.url : null, hasToken: connection.mode === "remote", apiPort: PORTS.api, version: app.getVersion(), lang: desktopLocale(), strings: section("connect") };
});
ipcMain.handle("mf:connection-test", async (event, args: { url: string; token: string }) => {
  if (!fromApp(event, "/connect")) return { ok: false, message: t("connect.notAllowed") };
  let origin: string;
  try {
    origin = normalizeUrl(args.url);
  } catch {
    return { ok: false, message: t("connect.invalidAddress") };
  }
  const token = args.token?.trim() || (connection.mode === "remote" && connection.url === origin ? connection.token : "");
  if (!token) return { ok: false, message: t("connect.needToken") };
  try {
    const res = await net.fetch(`${origin}/api/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const me = (await res.json().catch(() => ({}))) as { role?: string | null; label?: string };
    if (!res.ok || !me.role) return { ok: false, message: t("connect.tokenRefused") };
    if (me.role === "captain") return { ok: false, message: t("connect.captainToken") };
    return { ok: true, origin, role: me.role, label: me.label ?? null };
  } catch (e) {
    return { ok: false, message: t("connect.unreachable", { origin, error: e instanceof Error ? e.message : String(e), port: new URL(origin).port || PORTS.api }) };
  }
});
ipcMain.handle("mf:connection-save", (event, args: { mode: "local" } | { mode: "remote"; url: string; token: string }) => {
  if (!fromApp(event, "/connect")) return false;
  if (args.mode === "remote") {
    const url = normalizeUrl(args.url);
    const token = args.token?.trim() || (connection.mode === "remote" && connection.url === url ? connection.token : "");
    if (!token) return false;
    connection = { mode: "remote", url, token };
    saveConnection(connection);
    stopEngine();
    applyConnectionToHuds();
    showConsole();
  } else {
    connection = { mode: "local" };
    saveConnection(connection);
    applyConnectionToHuds();
    if (operatorToken && engine) showConsole();
    else startEngine(); // the console is shown when the engine reports ready
  }
  return true;
});
ipcMain.handle("mf:connection-cancel", (event) => {
  if (!fromApp(event, "/connect")) return;
  if (connection.mode === "remote" || operatorToken) showConsole();
});

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showManager());
  app.whenReady().then(() => {
    registerAppProtocol();
    connection = loadConnection();
    crashReports.start();
    applyLanguage();
    if (!globalShortcut.register(EMERGENCY_HOTKEY, () => void emergencyStop())) console.error(`could not register emergency-stop hotkey ${EMERGENCY_HOTKEY}`);
    if (!globalShortcut.register(SAVE_VIEW_HOTKEY, () => void saveCs2View())) console.error(`could not register save-view hotkey ${SAVE_VIEW_HOTKEY}`);
    setUpDesktopHuds();
    replayKeys = new ReplayHotkeys({
      shortcuts: globalShortcut,
      reserved: () => {
        const hud = hotkeys?.state();
        return [
          { accelerator: EMERGENCY_HOTKEY, name: t("hotkeys.emergencyStopName") },
          { accelerator: SAVE_VIEW_HOTKEY, name: t("hotkeys.saveViewName") },
          ...(hud ? [{ accelerator: hud.toggle, name: t("hotkeys.hudToggleName") }, { accelerator: hud.emergencyHide, name: t("hotkeys.hudHideName") }] : []),
        ];
      },
      load: () => readProgramSettings().replayHotkeys,
      save: (keys) => writeProgramSettings({ replayHotkeys: keys }),
      run: (action) => void runReplayKey(action),
      log: (msg) => console.error(msg),
    });
    replayKeys.register();
    powerMonitor.on("shutdown", () => (sessionEnding = true));
    updater = createUpdater({
      autoDownload: readProgramSettings().autoDownloadUpdates,
      saveAutoDownload: (on) => writeProgramSettings({ autoDownloadUpdates: on }),
      channel: readProgramSettings().updateChannel,
      saveChannel: (channel) => writeProgramSettings({ updateChannel: channel }),
      onChange: (st) => {
        if (win && !win.isDestroyed()) win.webContents.send("mf:update", st);
      },
      beforeInstall: () => console.log("installing the downloaded update"),
      log: (msg) => console.log(msg),
    });
    // A newer HLAE in the background once the program is up (ADR-084), so Start CS2 rarely waits for one.
    setTimeout(() => {
      void hlae.update().then((u) => {
        if (u.updated) console.log(`HLAE updated from ${u.from ?? "?"} to ${u.to}`);
        else if (u.reason === "error") console.error(`could not check for a newer HLAE: ${u.error}`);
      });
    }, 20_000);
    rollback = createRollback({
      currentVersion: app.getVersion(),
      dataDir: dataDir(),
      downloadDir: join(app.getPath("temp"), "MatchFrame go back"),
      fetch: (url, init) => net.fetch(url, init),
      // Loaded only when needed: it reads the engine's SQLite database (node:sqlite).
      data: () => import("../../../services/local-engine/src/db/version-backups.ts"),
      confirm: async (c) => {
        const options = { type: "warning" as const, title: c.title, message: c.message, detail: c.detail, buttons: [t("dialog.cancel"), c.ok], defaultId: 0, cancelId: 0, noLink: true };
        return (await (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))).response === 1;
      },
      stopEngine: stopEngineAndWait,
      startEngine: () => {
        if (connection.mode === "local") startEngine();
      },
      install: (file) => {
        // The earlier version must not download the newer one again and install it on its next quit.
        writeProgramSettings({ autoDownloadUpdates: false });
        updater?.skipInstallOnQuit();
        // As an update installs (electron-updater's NSIS flags): silent, the registered folder, user
        // data kept (--updated), and the program started when it's done.
        const installer = spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" });
        installer.once("spawn", () => {
          installer.unref();
          app.quit();
        });
        // The data is already in the earlier version's format; this version would only migrate it again (keeping a copy).
        installer.once("error", (e) => {
          console.error(`[go back] the installer did not start: ${e.message}`);
          dialog.showErrorBox("MatchFrame", t("dialog.installerFailed", { error: e.message, file }));
          if (connection.mode === "local") startEngine();
        });
      },
      progress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send("mf:rollback", p);
      },
      log: (msg) => console.log(`[go back] ${msg}`),
    });
    if (connection.mode === "remote") showConsole();
    else startEngine();
  });
  // HUD windows count too, and the manager only closes (rather than hiding to the tray) when no HUD
  // output is open, so this runs once nothing is left on screen.
  app.on("window-all-closed", () => app.quit());
  // Quit closes every HUD window, then waits (up to 5 s) for the engine and its HUD server to stop.
  app.on("before-quit", (e) => {
    if (!quitting) {
      quitting = true;
      overlays?.dispose();
      updater?.dispose();
      crashReports.dispose();
      hotkeys?.unregister();
      tray?.destroy();
      tray = null;
      globalShortcut.unregisterAll();
    }
    const child = engine;
    if (!child || engineStopped || child.exitCode !== null) return;
    e.preventDefault();
    engineWanted = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      engineStopped = true;
      app.quit();
    };
    const kill = setTimeout(() => {
      console.error("the engine did not stop within 5 s; ending it");
      child.kill();
      finish();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(kill);
      finish();
    });
    try {
      child.send({ type: "shutdown" });
    } catch {
      child.kill();
    }
  });
}
