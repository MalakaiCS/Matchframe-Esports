import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

export const APP_VERSION = "0.10.5";

export interface EngineConfig {
  /** Bind host. Loopback by default; LAN exposure is an explicit operator choice. */
  host: string;
  gsiPort: number;
  apiPort: number;
  overlayPort: number;
  dataDir: string;
  /** Captain veto page build (apps/operator-web/dist-captain), served at /captain for scoped captain links. The operator console itself is never served to browsers. */
  captainUiDir: string | null;
  /** Static HUD renderer build directory (served by the overlay server). */
  hudRendererDir: string | null;
  /** Bundled sample HUD folders, installed into the HUD Library once. Each folder is a package (has manifest.json) or holds package folders. */
  sampleHudsDirs: string[];
  /** Directory holding map packs shipped with the app. */
  mapPackDir: string | null;
  /** Built-in radar images with their calibration (assets/radars: radars.json and the images). */
  radarDir: string | null;
  /** Measured utility profiles (workers `measure-utility` output); defaults are used when absent. */
  utilityProfilesFile: string | null;
  /** Built-in models shipped with the app (assets/models: `pov_2s-builtin/`). */
  builtinModelsDir: string | null;
  /** The user's Videos folder (set by the desktop program): highlight reels go in "Matchframe Highlights" there; else in the data folder. */
  videosDir?: string | null;
  /** Python interpreter for workers (demo parsing, training). */
  pythonPath: string | null;
  workersDir: string | null;
  /** Allowed browser origins for operator mutations (CSRF protection). */
  allowedOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  /** Fixed Matchframe website/API address (release builds); when null the operator sets it on the Account screen. */
  cloudUrl: string | null;
  /** Ed25519 public keys {kid: PEM} pinned into the build. When null, keys are fetched from the website on first link. */
  cloudPublicKeys: Record<string, string> | null;
  /** "off" lets automatic direction arm without an account (development and offline lab builds only). */
  cloudEnforcement: "required" | "off";
  /** "required": sign-in state is reported (signed in or not; the Auto Director's arming gate needs it). "off" (MATCHFRAME_SIGN_IN=off, development) reports "not_required". The program never blocks on it (ADR-021). */
  cloudSignIn: "required" | "off";
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
    captainUiDir: process.env.MATCHFRAME_CAPTAIN_UI_DIR ?? null,
    hudRendererDir: process.env.MATCHFRAME_HUD_DIR ?? null,
    sampleHudsDirs: pathList(process.env.MATCHFRAME_SAMPLE_HUDS_DIR),
    mapPackDir: process.env.MATCHFRAME_MAP_PACK_DIR ?? null,
    radarDir: process.env.MATCHFRAME_RADAR_DIR ?? null,
    utilityProfilesFile: process.env.MATCHFRAME_UTILITY_PROFILES ?? null,
    builtinModelsDir: process.env.MATCHFRAME_MODELS_DIR ?? null,
    pythonPath: process.env.MATCHFRAME_PYTHON ?? null,
    videosDir: process.env.MATCHFRAME_VIDEOS_DIR || null,
    workersDir: process.env.MATCHFRAME_WORKERS_DIR ?? null,
    allowedOrigins: (process.env.MATCHFRAME_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: (process.env.MATCHFRAME_LOG_LEVEL as EngineConfig["logLevel"]) ?? "info",
    cloudUrl: process.env.MATCHFRAME_CLOUD_URL ?? null,
    cloudPublicKeys: loadPinnedKeys(),
    cloudEnforcement: process.env.MATCHFRAME_CLOUD_ENFORCEMENT === "off" ? "off" : "required",
    cloudSignIn: process.env.MATCHFRAME_SIGN_IN === "off" ? "off" : "required",
    ...overrides,
  };
  const ports = [cfg.gsiPort, cfg.apiPort, cfg.overlayPort];
  if (new Set(ports).size !== ports.length) throw new Error(`GSI, API and overlay ports must differ (got ${ports.join(", ")})`);
  return cfg;
}

/** A list of folders separated by the platform path delimiter (";" on Windows, ":" elsewhere). */
export function pathList(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean);
}

/** MATCHFRAME_CLOUD_PUBLIC_KEYS (JSON) or MATCHFRAME_CLOUD_KEYS_FILE (path to the same JSON). */
function loadPinnedKeys(): Record<string, string> | null {
  const raw = process.env.MATCHFRAME_CLOUD_PUBLIC_KEYS ?? (process.env.MATCHFRAME_CLOUD_KEYS_FILE && existsSync(process.env.MATCHFRAME_CLOUD_KEYS_FILE) ? readFileSync(process.env.MATCHFRAME_CLOUD_KEYS_FILE, "utf8") : null);
  if (!raw) return null;
  const keys = JSON.parse(raw) as unknown;
  if (!keys || typeof keys !== "object" || Object.values(keys).some((v) => typeof v !== "string" || !v.includes("PUBLIC KEY"))) throw new Error("pinned cloud keys must be a JSON object of {kid: PEM public key}");
  return keys as Record<string, string>;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
