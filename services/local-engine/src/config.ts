import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface EngineConfig {
  /** Bind host. Loopback by default; LAN exposure is an explicit operator choice. */
  host: string;
  gsiPort: number;
  apiPort: number;
  overlayPort: number;
  dataDir: string;
  /** Static operator UI build directory (served by the API server), if present. */
  operatorUiDir: string | null;
  /** Static HUD renderer build directory (served by the overlay server). */
  hudRendererDir: string | null;
  /** Directory holding map packs shipped with the app. */
  mapPackDir: string | null;
  /** Python interpreter for workers (demo parsing, training). */
  pythonPath: string | null;
  workersDir: string | null;
  /** Allowed browser origins for operator mutations (CSRF protection). */
  allowedOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export function defaultDataDir(): string {
  if (process.env.MATCHFRAME_DATA_DIR) return process.env.MATCHFRAME_DATA_DIR;
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Matchframe Esports");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Matchframe Esports");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "matchframe-esports");
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

export function loadConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const cfg: EngineConfig = {
    host: process.env.MATCHFRAME_HOST ?? "127.0.0.1",
    gsiPort: intEnv("MATCHFRAME_GSI_PORT", 37210),
    apiPort: intEnv("MATCHFRAME_API_PORT", 37211),
    overlayPort: intEnv("MATCHFRAME_OVERLAY_PORT", 37212),
    dataDir: defaultDataDir(),
    operatorUiDir: process.env.MATCHFRAME_OPERATOR_UI_DIR ?? null,
    hudRendererDir: process.env.MATCHFRAME_HUD_DIR ?? null,
    mapPackDir: process.env.MATCHFRAME_MAP_PACK_DIR ?? null,
    pythonPath: process.env.MATCHFRAME_PYTHON ?? null,
    workersDir: process.env.MATCHFRAME_WORKERS_DIR ?? null,
    allowedOrigins: (process.env.MATCHFRAME_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: (process.env.MATCHFRAME_LOG_LEVEL as EngineConfig["logLevel"]) ?? "info",
    ...overrides,
  };
  const ports = [cfg.gsiPort, cfg.apiPort, cfg.overlayPort];
  if (new Set(ports).size !== ports.length) throw new Error(`GSI, API and overlay ports must differ (got ${ports.join(", ")})`);
  return cfg;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
