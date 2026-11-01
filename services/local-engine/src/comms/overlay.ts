import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ObsManager } from "@matchframe/obs-adapter";
import type { SettingsRepo } from "../db/store.ts";
import { WsHub } from "../http/ws-hub.ts";
import type { ListenInTeam } from "./controller.ts";

/**
 * The public broadcast's Team Comms graphic (ADR-066): a TEAM COMMS banner with the team's name and
 * logo while that team's comms are on air, animated in and out, for the live scene in OBS. It is its
 * own overlay page (`/comms/public` on the overlay server, transparent but for the banner), apart from
 * the HUDs and from the recording's speaker strip (phase 4), and it receives **team-level state
 * only**: whether comms are on air, the team's name, short name, logo and colour. Nothing about any
 * person ever reaches it: no name, identity, roster card, avatar or voice activity.
 */

export const OVERLAY_SOURCE = "MatchFrame Team Comms";
export const OVERLAY_LABEL = "TEAM COMMS";
const TOKEN_KEY = "comms.overlayToken";

export interface OverlayPlacement {
  anchor: "top" | "bottom";
  /** Distance from that edge of the 1920×1080 frame (px). */
  offsetPx: number;
}

/** Everything the public overlay page receives. Team-level only, by construction. */
export interface CommsOverlayState {
  type: "comms";
  v: 1;
  onAir: boolean;
  team: { name: string; shortName: string | null; logoUrl: string | null; color: string | null } | null;
  label: typeof OVERLAY_LABEL;
  placement: OverlayPlacement;
}

/** The overlay's state from the team on air (or none): only these team fields, whatever the team record holds. */
export function overlayState(team: ListenInTeam | null, placement: OverlayPlacement): CommsOverlayState {
  return {
    type: "comms",
    v: 1,
    onAir: team !== null,
    team: team ? { name: team.name, shortName: team.shortName, logoUrl: team.logoUrl, color: team.color } : null,
    label: OVERLAY_LABEL,
    placement: { anchor: placement.anchor, offsetPx: placement.offsetPx },
  };
}

export class CommsOverlay {
  private readonly hub: WsHub;
  private state: CommsOverlayState;

  constructor(
    private readonly d: {
      settings: SettingsRepo;
      obs: ObsManager;
      overlayPort: () => number;
      liveScene: () => string | null;
      placement: () => OverlayPlacement;
    },
  ) {
    this.state = overlayState(null, d.placement());
    this.hub = new WsHub({ maxBufferedBytes: 64 * 1024, onConnect: (c) => this.hub.sendTo(c, this.state, { snapshot: true }) });
  }

  token(): string {
    let t = this.d.settings.get<string | null>(TOKEN_KEY, null);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.d.settings.set(TOKEN_KEY, t);
    }
    return t;
  }

  checkToken(given: string | null): boolean {
    return !!given && given === this.token();
  }

  url(): string {
    return `http://127.0.0.1:${this.d.overlayPort()}/comms/public?t=${this.token()}`;
  }

  /** The team on air changed (or the placement): every overlay page gets the new state at once. */
  set(team: ListenInTeam | null): void {
    const next = overlayState(team, this.d.placement());
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const c of this.hub.clients) this.hub.sendTo(c, next, { snapshot: true });
  }

  current(): CommsOverlayState {
    return this.state;
  }

  /** `/comms-ws` on the overlay server (token checked there). Read-only: messages from the page are ignored. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.hub.upgrade(req, socket, head, { kind: "comms" });
  }

  status() {
    return { url: this.url(), source: OVERLAY_SOURCE, liveScene: this.d.liveScene(), obsConnected: this.d.obs.state.connected, pages: this.hub.clients.size, onAir: this.state.onAir, placement: this.state.placement };
  }

  /** Adds (or re-points) the browser source on top of the live scene in OBS. */
  async setupObs(): Promise<{ scene: string; source: string; url: string; created: boolean; onTop: boolean }> {
    const obs = this.d.obs;
    if (!obs.state.connected) throw new OverlaySetupError("connect OBS first (Settings → Devices)", "obs_not_connected");
    const scene = this.d.liveScene();
    if (!scene) throw new OverlaySetupError("map the live scene first (Settings → Setup → OBS scenes)", "no_live_scene");
    const url = this.url();
    const r = await obs.provisionBrowserSource({ sceneName: scene, sourceName: OVERLAY_SOURCE, url, width: 1920, height: 1080 });
    let items = await obs.sceneItems(scene);
    if (!items.some((i) => i.sourceName === OVERLAY_SOURCE) && obs.state.inputs.some((i) => i.name === OVERLAY_SOURCE && i.kind === "browser_source")) {
      // Made for another scene before: the same source here too.
      await obs.createSceneItem(scene, OVERLAY_SOURCE);
      items = await obs.sceneItems(scene);
    }
    const at = items.findIndex((i) => i.sourceName === OVERLAY_SOURCE);
    if (at < 0) throw new OverlaySetupError(`OBS has a source named “${OVERLAY_SOURCE}” that isn't a browser source: rename or remove it and press again`, "source_conflict");
    // OBS lists a scene's sources from the bottom up: on top is the last.
    if (at !== items.length - 1) {
      await obs.setSceneItem(scene, items[at]!.sceneItemId, { index: items.length - 1 });
      items = await obs.sceneItems(scene);
    }
    const onTop = items.findIndex((i) => i.sourceName === OVERLAY_SOURCE) === items.length - 1;
    return { scene, source: OVERLAY_SOURCE, url, created: r.createdInput, onTop };
  }

  close(): void {
    this.hub.closeAll();
  }
}

export class OverlaySetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The overlay page: transparent, the banner hidden until the state says on air. Its script is /comms/public.js (the overlay server allows no inline script). */
export function commsOverlayPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MatchFrame Team Comms</title>
<style>
:root { --mf-panel: rgba(14, 17, 24, 0.9); --mf-panel-2: rgba(26, 31, 42, 0.94); --mf-ink: #f4f6fb; --mf-ink-dim: #9aa4b5; --mf-accent: #2f7cf6; --mf-team: var(--mf-accent); --mf-font: "Inter", "Segoe UI", system-ui, sans-serif; }
html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent; font-family: var(--mf-font); color: var(--mf-ink); }
.mf-comms { position: absolute; left: 50%; top: var(--mf-y, 140px); transform: translate(-50%, -18px); opacity: 0; transition: transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 260ms ease; will-change: transform, opacity; }
.mf-comms.bottom { top: auto; bottom: var(--mf-y, 140px); transform: translate(-50%, 18px); }
.mf-comms.on { opacity: 1; transform: translate(-50%, 0); }
.mf-comms-card { display: flex; align-items: stretch; min-width: 420px; height: 76px; background: var(--mf-panel); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%); }
.mf-comms-stripe { width: 8px; background: var(--mf-team); }
.mf-comms-logo { width: 76px; display: flex; align-items: center; justify-content: center; background: var(--mf-panel-2); }
.mf-comms-logo img { max-width: 56px; max-height: 56px; object-fit: contain; }
.mf-comms-logo.none { display: none; }
.mf-comms-text { display: flex; flex-direction: column; justify-content: center; padding: 0 34px 0 20px; }
.mf-comms-label { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 800; letter-spacing: 0.24em; color: var(--mf-team); }
.mf-comms-team { font-size: 30px; font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; line-height: 1.1; white-space: nowrap; }
.mf-comms-eq { display: inline-flex; align-items: flex-end; gap: 3px; height: 14px; }
.mf-comms-eq i { display: block; width: 3px; height: 100%; background: var(--mf-team); transform-origin: bottom; animation: mf-eq 900ms ease-in-out infinite; }
.mf-comms-eq i:nth-child(2) { animation-delay: -300ms; }
.mf-comms-eq i:nth-child(3) { animation-delay: -600ms; }
.mf-comms-eq i:nth-child(4) { animation-delay: -150ms; }
@keyframes mf-eq { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
</style>
</head>
<body>
<div id="mf-comms" class="mf-comms" aria-hidden="true">
  <div class="mf-comms-card">
    <div class="mf-comms-stripe"></div>
    <div class="mf-comms-logo none"><img alt=""></div>
    <div class="mf-comms-text">
      <div class="mf-comms-label"><span class="mf-comms-eq"><i></i><i></i><i></i><i></i></span><span class="mf-comms-what">${OVERLAY_LABEL}</span></div>
      <div class="mf-comms-team"></div>
    </div>
  </div>
</div>
<script src="/comms/public.js"></script>
</body>
</html>
`;
}

/** The overlay page's script: the state from /comms-ws, the banner in and out. Hidden whenever the engine isn't there. */
export const COMMS_OVERLAY_JS = `(function () {
  "use strict";
  var root = document.getElementById("mf-comms");
  var logo = root.querySelector(".mf-comms-logo");
  var img = logo.querySelector("img");
  var team = root.querySelector(".mf-comms-team");
  var what = root.querySelector(".mf-comms-what");
  var token = new URLSearchParams(location.search).get("t") || "";
  var shown = null;
  var swap = null;
  var retry = 500;
  function fill(s) {
    team.textContent = s.team.name;
    what.textContent = s.label;
    if (s.team.color) root.style.setProperty("--mf-team", s.team.color); else root.style.removeProperty("--mf-team");
    if (s.team.logoUrl) { img.src = s.team.logoUrl; logo.classList.remove("none"); } else { img.removeAttribute("src"); logo.classList.add("none"); }
  }
  function apply(s) {
    if (swap) { clearTimeout(swap); swap = null; }
    if (s && s.placement) {
      root.classList.toggle("bottom", s.placement.anchor === "bottom");
      root.style.setProperty("--mf-y", (s.placement.offsetPx | 0) + "px");
    }
    var on = !!(s && s.onAir && s.team);
    var key = on ? s.team.name + "|" + (s.team.logoUrl || "") + "|" + (s.team.color || "") : null;
    if (!on) { root.classList.remove("on"); shown = null; return; }
    if (shown === null) { fill(s); shown = key; void root.offsetWidth; root.classList.add("on"); return; }
    if (shown !== key) {
      root.classList.remove("on");
      swap = setTimeout(function () { swap = null; fill(s); shown = key; root.classList.add("on"); }, 400);
    }
  }
  function connect() {
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/comms-ws?t=" + encodeURIComponent(token));
    ws.onopen = function () { retry = 500; };
    ws.onmessage = function (ev) { try { var s = JSON.parse(ev.data); if (s && s.type === "comms") apply(s); } catch (e) {} };
    ws.onclose = function () { apply(null); setTimeout(connect, retry); retry = Math.min(5000, retry * 2); };
  }
  connect();
})();
`;
