import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, safeStorage, shell } from "electron";

/**
 * Matchframe Esports desktop shell. The renderer never gets Node access: it loads the operator UI
 * served by the local engine over loopback, with a narrow preload bridge. The engine runs as a
 * supervised child process; a restart never issues scene or camera commands (the engine starts
 * in manual/disarmed mode by design).
 */

const isDev = !app.isPackaged;
const PORTS = { gsi: Number(process.env.MATCHFRAME_GSI_PORT ?? 37210), api: Number(process.env.MATCHFRAME_API_PORT ?? 37211), overlay: Number(process.env.MATCHFRAME_OVERLAY_PORT ?? 37212) };
const ENGINE_ORIGIN = `http://127.0.0.1:${PORTS.api}`;
const EMERGENCY_HOTKEY = process.env.MATCHFRAME_STOP_HOTKEY ?? "CommandOrControl+Shift+F12";

let engine: ChildProcess | null = null;
let operatorToken: string | null = null;
let win: BrowserWindow | null = null;
let restarts = 0;
let quitting = false;

function resourcesPath(...p: string[]): string {
  return isDev ? join(app.getAppPath(), "..", "..", ...p) : join(process.resourcesPath, ...p);
}

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

function startEngine(): void {
  const enginePath = isDev ? resourcesPath("services", "local-engine", "src", "main.ts") : resourcesPath("engine", "engine.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    MATCHFRAME_ENGINE_MAIN: "1",
    MATCHFRAME_DATA_DIR: process.env.MATCHFRAME_DATA_DIR ?? join(app.getPath("appData"), "Matchframe Esports"),
    MATCHFRAME_OPERATOR_UI_DIR: resourcesPath(isDev ? "apps/operator-web/dist" : "operator-web"),
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
  const execArgv = isDev ? ["--import", "tsx"] : [];
  engine = fork(enginePath, [], { env, execPath: process.execPath, execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  engine.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  engine.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  engine.on("message", (m: { type?: string; operatorToken?: string }) => {
    if (m?.type === "ready") {
      operatorToken = m.operatorToken ?? null;
      restarts = 0;
      if (win) void win.loadURL(`${ENGINE_ORIGIN}/`);
      else createWindow();
    }
  });
  engine.on("exit", (code) => {
    engine = null;
    if (quitting) return;
    restarts++;
    const delay = Math.min(15000, 500 * 2 ** Math.min(restarts, 5));
    console.error(`engine exited (code ${code}); restarting in ${delay} ms (automation stays disarmed)`);
    win?.webContents.send("mf:engine-status", { state: "restarting", code, delayMs: delay });
    if (restarts > 8) {
      void dialog.showMessageBox({ type: "error", message: "The Matchframe engine keeps stopping.", detail: "Open Settings → Diagnostics after restart, or check the logs in the data folder." });
    }
    setTimeout(startEngine, delay);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#11141b",
    title: "Matchframe Esports",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // Only the local engine origin may be shown in the app window.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ENGINE_ORIGIN)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`${ENGINE_ORIGIN}/`);
  win.on("closed", () => (win = null));
}

async function emergencyStop(): Promise<void> {
  if (!operatorToken) return;
  try {
    await fetch(`${ENGINE_ORIGIN}/api/v1/observer/emergency-stop`, { method: "POST", headers: { authorization: `Bearer ${operatorToken}` } });
    win?.webContents.send("mf:emergency-stop", { at: Date.now() });
  } catch (e) {
    console.error("emergency stop request failed", e);
  }
}

ipcMain.handle("mf:token", (event) => {
  // Hand the operator token only to the engine-served operator UI.
  const url = event.senderFrame?.url ?? "";
  return url.startsWith(ENGINE_ORIGIN) ? operatorToken : null;
});
ipcMain.handle("mf:info", () => ({ version: app.getVersion(), dataDir: join(app.getPath("appData"), "Matchframe Esports"), emergencyHotkey: EMERGENCY_HOTKEY, ports: PORTS, packaged: app.isPackaged }));
ipcMain.handle("mf:open-data-dir", () => shell.openPath(join(app.getPath("appData"), "Matchframe Esports")));
ipcMain.handle("mf:restart-engine", () => {
  engine?.send({ type: "shutdown" });
  return true;
});

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
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "File", submenu: [{ label: "Open data folder", click: () => void shell.openPath(join(app.getPath("appData"), "Matchframe Esports")) }, { type: "separator" }, { role: "quit" }] },
        { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, ...(isDev ? [{ role: "toggleDevTools" as const }] : [])] },
        { label: "Automation", submenu: [{ label: `Emergency stop (${EMERGENCY_HOTKEY})`, click: () => void emergencyStop() }] },
      ]),
    );
    if (!globalShortcut.register(EMERGENCY_HOTKEY, () => void emergencyStop())) console.error(`could not register emergency-stop hotkey ${EMERGENCY_HOTKEY}`);
    startEngine();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    globalShortcut.unregisterAll();
    engine?.send({ type: "shutdown" });
  });
}
