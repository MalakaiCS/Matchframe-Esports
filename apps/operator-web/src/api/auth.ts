/**
 * Token handling. The operator URL carries `?token=`; it is read once, kept in sessionStorage
 * (cleared when the window closes) and removed from the address bar so it is not left in history,
 * screenshots or screen shares. The Electron shell may instead expose a preload bridge.
 */

export const OPERATOR_TOKEN_KEY = "matchframe.operatorToken";
export const CAPTAIN_TOKEN_KEY = "matchframe.captainToken";

declare global {
  interface Window {
    matchframe?: { getOperatorToken?: () => Promise<string> };
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

/** Resolves the operator token: URL → session storage → Electron preload bridge. */
export async function resolveOperatorToken(): Promise<string | null> {
  const fromUrl = captureTokenFromUrl(OPERATOR_TOKEN_KEY);
  if (fromUrl) {
    memoryToken = fromUrl;
    return fromUrl;
  }
  const stored = storageGet(OPERATOR_TOKEN_KEY);
  if (stored) {
    memoryToken = stored;
    return stored;
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
  return null;
}

export function getCaptainToken(): string | null {
  return storageGet(CAPTAIN_TOKEN_KEY);
}

export function resolveCaptainToken(): string | null {
  return captureTokenFromUrl(CAPTAIN_TOKEN_KEY) ?? storageGet(CAPTAIN_TOKEN_KEY);
}
