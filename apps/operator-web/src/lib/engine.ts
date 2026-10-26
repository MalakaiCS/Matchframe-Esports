/**
 * Address of the Matchframe engine this console talks to. Inside the Matchframe program the
 * preload bridge provides it (this computer's engine, or the production computer in remote mode);
 * API requests go through the program's own `app://` origin. During development under the Vite
 * server it is the page's origin (Vite proxies the API).
 */
export function engineOrigin(): string {
  return window.matchframe?.engineOrigin ?? window.location.origin;
}

/** WebSocket URL on the engine for an API path. */
export function engineWsUrl(path: string): string {
  return engineOrigin().replace(/^http/, "ws") + path;
}
