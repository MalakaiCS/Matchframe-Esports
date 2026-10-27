import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, protocol, safeStorage, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

/**
 * Matchframe Esports program (Windows desktop app). The operator console is bundled into the
 * program and shown from its own `app://matchframe` origin; it is never served to browsers. API and
 * asset requests from the console are forwarded to the engine: the one this program supervises
 * (local mode) or the one on the production computer (remote mode, for multi-PC productions). The
 * renderer never gets Node access; a narrow preload bridge exposes a few calls. A restarted engine
 * never issues scene or camera commands (it starts in manual/disarmed mode by design).
 */

const isDev = !app.isPackaged;
const PORTS = { gsi: Number(process.env.MATCHFRAME_GSI_PORT ?? 37210), api: Number(process.env.MATCHFRAME_API_PORT ?? 37211), overlay: Number(process.env.MATCHFRAME_OVERLAY_PORT ?? 37212) };
const LOCAL_ENGINE = `http://127.0.0.1:${PORTS.api}`;
const APP_ORIGIN = "app://matchframe";
const EMERGENCY_HOTKEY = process.env.MATCHFRAME_STOP_HOTKEY ?? "CommandOrControl+Shift+F12";

/** Engine data folder; the program's own settings (credential key, connection, browser storage) live in its `program` subfolder. */
const dataDir = () => process.env.MATCHFRAME_DATA_DIR ?? join(app.getPath("appData"), "Matchframe Esports");
app.setPath("userData", join(dataDir(), "program"));

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

function resourcesPath(...p: string[]): string {
  return isDev ? join(app.getAppPath(), "..", "..", ...p) : join(process.resourcesPath, ...p);
}

const consoleDir = () => resourcesPath(isDev ? "apps/operator-web/dist" : "operator-web");
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
    dialog.showErrorBox("Matchframe", `cloud.json in the installation is unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

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
  const overlays = `http://127.0.0.1:${PORTS.overlay} http://localhost:${PORTS.overlay}`;
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
  if (!existsSync(file)) return new Response(`Console files are missing (${root}). Reinstall Matchframe.`, { status: 500 });
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
    const where = connection.mode === "remote" ? `the production computer at ${connection.url}` : "the Matchframe engine on this computer";
    return Response.json({ error: "engine_unreachable", message: `Cannot reach ${where}: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

function registerAppProtocol(): void {
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    if (url.host !== "matchframe") return new Response("not found", { status: 404 });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) return forwardToEngine(req, url);
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
    MATCHFRAME_MAP_PACK_DIR: resourcesPath(isDev ? "assets/map-packs" : "map-packs"),
    MATCHFRAME_UTILITY_PROFILES: resourcesPath(isDev ? "assets/utility-profiles/measured.json" : "utility-profiles/measured.json"),
    MATCHFRAME_WORKERS_DIR: resourcesPath("workers"),
    MATCHFRAME_GSI_PORT: String(PORTS.gsi),
    MATCHFRAME_API_PORT: String(PORTS.api),
    MATCHFRAME_OVERLAY_PORT: String(PORTS.overlay),
  };
  const key = secretKey();
  if (key) env.MATCHFRAME_SECRET_KEY = key;
  Object.assign(env, cloudReleaseConfig(env));
  const execArgv = isDev ? ["--import", "tsx"] : [];
  const child = fork(enginePath, [], { env, execPath: process.execPath, execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  engine = child;
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("message", (m: { type?: string; operatorToken?: string }) => {
    if (m?.type === "ready") {
      operatorToken = m.operatorToken ?? null;
      restarts = 0;
      if (connection.mode === "local") showConsole();
    }
  });
  child.on("exit", (code) => {
    if (engine === child) engine = null;
    if (quitting || !engineWanted) return;
    restarts++;
    const delay = Math.min(15000, 500 * 2 ** Math.min(restarts, 5));
    console.error(`engine exited (code ${code}); restarting in ${delay} ms (automation stays disarmed)`);
    win?.webContents.send("mf:engine-status", { state: "restarting", code, delayMs: delay });
    if (restarts > 8) {
      void dialog.showMessageBox({ type: "error", message: "The Matchframe engine keeps stopping.", detail: "Open Settings → Diagnostics after restart, or check the logs in the data folder." });
    }
    setTimeout(() => engineWanted && startEngine(), delay);
  });
}

function stopEngine(): void {
  engineWanted = false;
  operatorToken = null;
  engine?.send({ type: "shutdown" });
}

// ------------------------------------------------------------------ window

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#11141b",
    title: windowTitle(),
    // Packaged Windows builds take the icon from the .exe (build/icon.ico); development runs need it set.
    ...(isDev ? { icon: join(app.getAppPath(), "build", "icon.png") } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // Only the program's own pages may be shown in the window; links to websites open in the browser.
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN + "/")) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url) || (isDev && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.on("page-title-updated", (e) => e.preventDefault());
  w.on("closed", () => (win = null));
  return w;
}

function windowTitle(): string {
  return connection.mode === "remote" ? `Matchframe Esports — connected to ${new URL(connection.url).host}` : "Matchframe Esports";
}

function showConsole(): void {
  win ??= createWindow();
  win.setTitle(windowTitle());
  void win.loadURL(`${APP_ORIGIN}/`);
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

// ------------------------------------------------------------------ IPC

ipcMain.on("mf:bootstrap", (event) => {
  event.returnValue = fromApp(event) ? { engineOrigin: engineOrigin(), connectionMode: connection.mode } : null;
});
ipcMain.handle("mf:token", (event) => (fromApp(event) && !fromApp(event, "/connect") ? accessToken() : null));
ipcMain.handle("mf:info", () => ({ version: app.getVersion(), dataDir: dataDir(), emergencyHotkey: EMERGENCY_HOTKEY, ports: PORTS, packaged: app.isPackaged, connection: connection.mode === "remote" ? { mode: "remote", url: connection.url } : { mode: "local" } }));
ipcMain.handle("mf:open-data-dir", () => shell.openPath(dataDir()));
ipcMain.handle("mf:restart-engine", () => {
  if (connection.mode !== "local") return false;
  engine?.send({ type: "shutdown" });
  return true;
});
ipcMain.handle("mf:open-connection", (event) => {
  if (fromApp(event)) showConnectionSettings();
});

// Connection settings page (app://matchframe/connect) only.
ipcMain.handle("mf:connection-get", (event) => {
  if (!fromApp(event, "/connect")) return null;
  return { mode: connection.mode, url: connection.mode === "remote" ? connection.url : null, hasToken: connection.mode === "remote", apiPort: PORTS.api, version: app.getVersion() };
});
ipcMain.handle("mf:connection-test", async (event, args: { url: string; token: string }) => {
  if (!fromApp(event, "/connect")) return { ok: false, message: "not allowed" };
  let origin: string;
  try {
    origin = normalizeUrl(args.url);
  } catch {
    return { ok: false, message: "That is not a valid address (example: 192.168.1.20 or http://192.168.1.20:37211)." };
  }
  const token = args.token?.trim() || (connection.mode === "remote" && connection.url === origin ? connection.token : "");
  if (!token) return { ok: false, message: "Enter the access token issued on the production computer (Devices & Integrations → Tokens)." };
  try {
    const res = await net.fetch(`${origin}/api/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const me = (await res.json().catch(() => ({}))) as { role?: string | null; label?: string };
    if (!res.ok || !me.role) return { ok: false, message: "The production computer did not accept this token (expired, revoked or for another installation)." };
    if (me.role === "captain") return { ok: false, message: "That is a captain veto token; use an operator role token." };
    return { ok: true, origin, role: me.role, label: me.label ?? null };
  } catch (e) {
    return { ok: false, message: `Cannot reach ${origin}: ${e instanceof Error ? e.message : String(e)}. Check that Matchframe runs there with MATCHFRAME_HOST set to its network address, and the firewall allows port ${new URL(origin).port || PORTS.api}.` };
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
    showConsole();
  } else {
    connection = { mode: "local" };
    saveConnection(connection);
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
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    registerAppProtocol();
    connection = loadConnection();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "File",
          submenu: [
            { label: "Connection settings… (this computer or another Matchframe computer)", click: () => showConnectionSettings() },
            { label: "Open data folder", click: () => void shell.openPath(dataDir()) },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, ...(isDev ? [{ role: "toggleDevTools" as const }] : [])] },
        { label: "Automation", submenu: [{ label: `Emergency stop (${EMERGENCY_HOTKEY})`, click: () => void emergencyStop() }] },
      ]),
    );
    if (!globalShortcut.register(EMERGENCY_HOTKEY, () => void emergencyStop())) console.error(`could not register emergency-stop hotkey ${EMERGENCY_HOTKEY}`);
    if (connection.mode === "remote") showConsole();
    else startEngine();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    globalShortcut.unregisterAll();
    engine?.send({ type: "shutdown" });
  });
}
