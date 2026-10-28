/**
 * Token handling. Inside the Matchframe program the preload bridge supplies the token. During
 * development (Vite) a `?token=` in the URL is read once, kept in sessionStorage (cleared when the
 * window closes) and removed from the address bar, or the token can be pasted.
 */

export const OPERATOR_TOKEN_KEY = "matchframe.operatorToken";
export const CAPTAIN_TOKEN_KEY = "matchframe.captainToken";

export interface HlaeInfo {
  path: string | null;
  ok: boolean;
  problem: string | null;
}

declare global {
  interface Window {
    /** Electron preload bridge (apps/desktop/src/preload.ts); absent in a plain browser. */
    matchframe?: {
      /** Engine address (this computer, or the production computer in remote mode). */
      engineOrigin?: string;
      /** "local" (this computer runs the engine) or "remote" (connected to another computer). */
      connectionMode?: "local" | "remote";
      getOperatorToken?: () => Promise<string | null>;
      openConnection?: () => Promise<void>;
      openDataDir?: () => Promise<string>;
      /** Let other computers on the network reach this computer's engine (restarts it). */
      network?: {
        get(): Promise<{ networkAccess: boolean; local: boolean } | null>;
        set(on: boolean): Promise<{ networkAccess: boolean; local: boolean } | null>;
      };
      onEmergencyStop?: (fn: (s: unknown) => void) => () => void;
      onEngineStatus?: (fn: (s: unknown) => void) => () => void;
      /** "win32", "darwin", "linux". */
      platform?: string;
      /** The window has no system title bar: the console's header is the drag region. */
      customTitleBar?: boolean;
      /** Start CS2 with the launch mode set in the engine (see lib/game.ts). */
      launchCs2?: () => Promise<{ ok: boolean; message: string }>;
      /** HLAE.exe for the HLAE launch mode (chosen with a file dialog on this computer). */
      hlae?: {
        info(): Promise<HlaeInfo | null>;
        choose(): Promise<HlaeInfo | null>;
      };
      /** Automatic updates (see lib/updates.ts). */
      updates?: {
        state(): Promise<unknown>;
        check(): Promise<unknown>;
        download(): Promise<unknown>;
        installNow(): Promise<void>;
        setAutoDownload(on: boolean): Promise<unknown>;
        onChange(fn: (s: unknown) => void): () => void;
      };
    };
  }
}

function storageGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (privacy mode); the token then lives only in memory.
  }
}

let memoryToken: string | null = null;

/** Reads `?token=` from the current URL, stores it under `key` and strips it from the address bar. */
export function captureTokenFromUrl(key: string, loc: Location = window.location, history: History = window.history): string | null {
  const url = new URL(loc.href);
  const token = url.searchParams.get("token");
  if (!token) return null;
  storageSet(key, token);
  url.searchParams.delete("token");
  const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "") + url.hash;
  try {
    history.replaceState(history.state, "", clean);
  } catch {
    // ignore (e.g. sandboxed frames)
  }
  return token;
}

export function getOperatorToken(): string | null {
  return memoryToken ?? storageGet(OPERATOR_TOKEN_KEY);
}

export function setOperatorToken(token: string | null): void {
  memoryToken = token;
  storageSet(OPERATOR_TOKEN_KEY, token);
}

/**
 * Resolves the operator token: URL → Electron preload bridge (authoritative inside the desktop
 * shell) → session storage.
 */
export async function resolveOperatorToken(): Promise<string | null> {
  const fromUrl = captureTokenFromUrl(OPERATOR_TOKEN_KEY);
  if (fromUrl) {
    memoryToken = fromUrl;
    return fromUrl;
  }
  const bridge = typeof window !== "undefined" ? window.matchframe?.getOperatorToken : undefined;
  if (bridge) {
    try {
      const t = await bridge();
      if (t) {
        setOperatorToken(t);
        return t;
      }
    } catch {
      // fall through: the bridge is optional
    }
  }
  const stored = storageGet(OPERATOR_TOKEN_KEY);
  if (stored) {
    memoryToken = stored;
    return stored;
  }
  return null;
}

export function getCaptainToken(): string | null {
  return storageGet(CAPTAIN_TOKEN_KEY);
}

export function resolveCaptainToken(): string | null {
  return captureTokenFromUrl(CAPTAIN_TOKEN_KEY) ?? storageGet(CAPTAIN_TOKEN_KEY);
}
