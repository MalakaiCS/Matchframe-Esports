import { existsSync } from "node:fs";
import { APP_VERSION } from "./config.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { GSI_MAX_BODY_BYTES } from "@matchframe/cs2-state";
import type { EventEnvelope, HudOutputMode } from "@matchframe/contracts";
import { HUD_OUTPUT_MODES, RESERVED_HUD_IDS } from "@matchframe/contracts";
import type { Engine } from "./app.ts";
import { can } from "./auth.ts";
import { isLoopback } from "./config.ts";
import { assetDir, registerDomainRoutes } from "./routes/domain.ts";
import { registerCoreRoutes } from "./routes/core.ts";
import { registerHudRoutes } from "./routes/hud.ts";
import { registerHudLibraryRoutes } from "./routes/hud-library.ts";
import { libraryHudId, libraryOutputId } from "./hud/library.ts";
import { WRAPPER_JS, wrapperPage } from "./hud/wrapper.ts";
import { registerLiveRoutes } from "./routes/live.ts";
import { registerDemoRoutes } from "./routes/demos.ts";
import { registerDeviceRoutes, tally } from "./routes/devices.ts";
import { registerReportRoutes } from "./routes/reports.ts";
import { registerIntegrationRoutes } from "./routes/integrations.ts";
import { registerCloudRoutes } from "./routes/cloud.ts";
import { bearer, json, readBody, Router } from "./http/router.ts";
import { overlayCsp, safeResolve, serveFile, serveStatic } from "./http/static.ts";
import type { HubClient } from "./http/ws-hub.ts";
import { WsHub } from "./http/ws-hub.ts";

export interface RunningServers {
  gsi: Server;
  api: Server;
  overlay: Server;
  operatorHub: WsHub;
  overlayHub: WsHub;
  /** Control channel of library output pages (/hud-runtime-ws). */
  runtimeHub: WsHub;
  router: Router;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} on ${host} is already in use. Change the port in Settings (or MATCHFRAME_*_PORT) and update the GSI config.`) : e);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startServers(e: Engine): Promise<RunningServers> {
  const cfg = e.cfg;
  const apiOrigins = new Set([`http://127.0.0.1:${cfg.apiPort}`, `http://localhost:${cfg.apiPort}`, ...cfg.allowedOrigins]);
  const router = new Router({
    secrets: e.secrets,
    originAllowed: (origin) => origin === undefined || apiOrigins.has(origin) || origin.startsWith("app://matchframe") || origin === "file://",
    onError: (err, req) => e.logger.error("request failed", { ...req, error: err instanceof Error ? err.stack : String(err) }),
  });
  registerCoreRoutes(router, e);
  registerDomainRoutes(router, e);
  registerLiveRoutes(router, e);
  registerHudRoutes(router, e);
  registerHudLibraryRoutes(router, e);
  registerDemoRoutes(router, e);
  registerReportRoutes(router, e);
  registerDeviceRoutes(router, e);
  registerIntegrationRoutes(router, e);
  registerCloudRoutes(router, e);
  router.get("/api/v1/openapi.json", { permission: "public" }, () => router.openapi({ title: "Matchframe Esports local API", version: APP_VERSION }));

  // ------------------------------------------------------------------ GSI ingest server
  let gsiRejectedAuth = 0;
  const gsi = createServer(async (req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/gsi")) {
      res.writeHead(req.method === "GET" ? 200 : 405, { "content-type": "text/plain" }).end(req.method === "GET" ? "Matchframe GSI receiver" : "method not allowed");
      return;
    }
    const receivedAt = e.now();
    let text: string;
    try {
      text = (await readBody(req, GSI_MAX_BODY_BYTES)).toString("utf8");
    } catch {
      res.writeHead(413).end();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const token = (payload as { auth?: { token?: unknown } })?.auth?.token;
    if (!e.secrets.checkGsiToken(typeof token === "string" ? token : undefined)) {
      gsiRejectedAuth++;
      if (gsiRejectedAuth % 50 === 1) e.logger.warn("GSI payload rejected: missing or wrong auth token", { count: gsiRejectedAuth });
      res.writeHead(401).end();
      return;
    }
    if (e.simulationRunning) {
      // While the labelled simulation is running, real packets are not mixed into simulated state.
      res.writeHead(200).end();
      return;
    }
    const provider = (payload as { provider?: { steamid?: unknown } })?.provider?.steamid;
    const sourceId = `gsi:${typeof provider === "string" && /^\d+$/.test(provider) ? provider : "unknown"}`;
    const outcome = e.session.ingestGsi(payload, sourceId, receivedAt, text);
    res.writeHead(outcome.reason === "invalid" ? 400 : 200, { "content-type": "text/plain" }).end();
  });

  // ------------------------------------------------------------------ operator hub
  const cloudSummary = (eng: Engine) => {
    const st = eng.cloud.status(eng.simulationRunning || eng.session.simulated, eng.session.observerMode);
    return { linkState: st.linkState, plan: st.entitlement?.plan.name ?? null, licence: st.entitlement?.state ?? null, remainingSeconds: st.entitlement?.localRemainingSeconds ?? null, gate: st.gate, metering: st.usage.metering, enforcement: st.enforcement, fullActionObserver: st.fullActionObserver };
  };
  let opSeq = 0;
  const env = <T>(topic: string, payload: T): EventEnvelope<T> => {
    const s = e.session.state();
    return { schemaVersion: 1, topic, sessionId: e.session.sessionId, epoch: s?.epoch ?? 0, sequence: ++opSeq, sourceId: s?.sources[0]?.sourceId ?? "none", matchTimeMs: s?.time.matchTimeMs ?? null, timeUncertaintyMs: s?.time.timeUncertaintyMs ?? null, payload };
  };
  const operatorSnapshot = () => ({
    state: e.session.state() ? e.session.stateAt(e.now()) : null,
    director: e.session.output()?.decision ?? null,
    opportunities: e.session.output()?.opportunities.slice(0, 8) ?? [],
    candidates: e.session.output()?.candidates.slice(0, 12).map((c) => ({ shotKey: c.shotKey, shotClass: c.shotClass, utility: c.utility, valid: c.valid, invalidReason: c.invalidReason, reasonCodes: c.reasonCodes, components: c.components, targetSteamId: c.targetSteamId, cameraId: c.cameraId })) ?? [],
    mode: e.session.director.currentMode,
    observerMode: e.session.observerMode,
    controls: { ...e.session.director.controls, assistedActions: [...e.session.director.controls.assistedActions] },
    ownership: e.session.arbiter.state(),
    resumeInMs: e.session.arbiter.resumePendingInMs(),
    pending: e.session.arbiter.pending(),
    currentShot: e.session.currentShotKey(),
    capabilities: e.session.capabilities(),
    program: { mode: e.program.mode, owner: e.program.owner, activeReplay: e.program.activeReplay },
    obs: { connected: e.obs.state.connected, programScene: e.obs.state.programScene, previewScene: e.obs.state.previewScene, studioMode: e.obs.state.studioMode, replayBuffer: e.obs.state.replayBuffer, recording: e.obs.state.recording, streaming: e.obs.state.streaming, lastError: e.obs.state.lastError },
    simulated: e.simulationRunning,
    /** Engine monotonic clock at send time (same base as state.time.receivedAtMonotonicMs). */
    engineNowMonotonicMs: e.now(),
    metrics: e.session.metrics(),
    tally: tally(e),
    cloud: cloudSummary(e),
  });
  const operatorHub = new WsHub({
    onConnect: (c) => operatorHub.sendTo(c, env("state.snapshot", operatorSnapshot()), { snapshot: true }),
    onMessage: (c, msg) => {
      if ((msg as { type?: string })?.type === "ping") operatorHub.sendTo(c, { type: "pong", at: Date.now() });
    },
  });
  let lastOperatorPush = 0;
  const pushOperator = (force = false) => {
    const now = Date.now();
    if (!force && now - lastOperatorPush < 200) return;
    lastOperatorPush = now;
    if (operatorHub.clients.size === 0) return;
    const msg = env("state.snapshot", operatorSnapshot());
    for (const c of operatorHub.clients) operatorHub.sendTo(c, msg, { snapshot: true });
  };
  e.session.on("state", () => pushOperator());
  e.session.on("decision", (d) => operatorHub.broadcast("director.decision", env("director.decision", d)));
  e.session.on("arbiter", (a) => {
    operatorHub.broadcast("observer.command", env("observer.command", a));
    pushOperator(true);
  });
  e.session.on("alert", (a) => operatorHub.broadcast("alerts", env("alerts", a)));
  e.session.on("capabilities", (c) => operatorHub.broadcast("capabilities", env("capabilities", c)));
  e.session.on("events", (evs) => operatorHub.broadcast("events", env("events", evs)));
  const operatorTimer = setInterval(() => pushOperator(true), 1000);

  // ------------------------------------------------------------------ API server
  const api = createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname.startsWith("/assets/")) {
        const f = safeResolve(assetDir(e), url.pathname.slice("/assets/".length));
        if (f) return serveFile(res, f);
      }
      // The operator console runs only inside the Matchframe program (apps/desktop). Browsers get
      // the captain veto page (scoped captain links) and nothing else from this server.
      const captainHeaders = { "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
      if ((url.pathname === "/captain" || url.pathname === "/captain/") && cfg.captainUiDir && serveStatic(res, cfg.captainUiDir, "/captain.html", { headers: captainHeaders })) return;
      if (url.pathname.startsWith("/captain-assets/") && serveStatic(res, cfg.captainUiDir, url.pathname, { headers: captainHeaders })) return;
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Matchframe</title><body style="font:16px system-ui;background:#11141b;color:#e6e9ef;padding:48px"><h1 style="font-size:20px">Matchframe engine</h1><p>The Matchframe console runs inside the Matchframe program for Windows. Open the program on this computer, or connect to this computer from the program on another one (File &rarr; Connect to another Matchframe computer).</p><p>This address serves the engine API for the program and control surfaces; HUD outputs for OBS are on port ${cfg.overlayPort}.</p></body>`);
        return;
      }
      json(res, 404, { error: "not_found", message: "not found (the console runs inside the Matchframe program; the API is under /api/v1)" });
    } catch (err) {
      e.logger.error("api server error", { error: String(err) });
      json(res, 500, { error: "internal" });
    }
  });
  api.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== "/api/v1/ws") return socket.destroy();
    const principal = e.secrets.authenticate(bearer(req, url.searchParams));
    if (!principal || !can(principal.role, "state.read")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    const origin = req.headers.origin;
    if (origin && !apiOrigins.has(origin) && !origin.startsWith("app://matchframe") && origin !== "file://") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    operatorHub.upgrade(req, socket, head, { principal: principal.label, role: principal.role });
  });

  // ------------------------------------------------------------------ overlay server
  const overlayOrigin = `http://127.0.0.1:${cfg.overlayPort}`;
  // 'self': the library output page frames its HUD; the console (and its preview panels) frames outputs.
  const csp = overlayCsp(overlayOrigin, ["'self'", `http://127.0.0.1:${cfg.apiPort}`, `http://localhost:${cfg.apiPort}`, "app://matchframe", "file:"]);
  let rejectedOverlayMessages = 0;
  const overlayHub = new WsHub({
    onConnect: (c) => sendHud(c, true),
    onMessage: (c, msg) => {
      const m = msg as { type?: string; sponsorId?: string; zone?: string; shownAt?: string; durationMs?: number };
      // The overlay socket is read-only. The only accepted message is a sponsor display ack.
      if (m?.type === "ack" && typeof m.sponsorId === "string" && typeof m.zone === "string" && e.sponsors.get(m.sponsorId)) {
        e.db.run(
          "INSERT INTO sponsor_deliveries (sponsor_id, output_id, zone, shown_at, hidden_at, duration_ms, acknowledged) VALUES (?, ?, ?, ?, NULL, ?, 1)",
          m.sponsorId,
          String(c.meta.outputId),
          m.zone.slice(0, 40),
          typeof m.shownAt === "string" ? m.shownAt.slice(0, 40) : new Date().toISOString(),
          typeof m.durationMs === "number" ? Math.max(0, Math.min(600000, Math.round(m.durationMs))) : null,
        );
        return;
      }
      rejectedOverlayMessages++;
    },
  });
  let hudSeq = 0;
  const sendHud = (c: HubClient, force = false) => {
    const outputId = String(c.meta.outputId);
    const variant = c.meta.variant ? String(c.meta.variant) : undefined;
    const state = e.hudState(outputId, variant);
    if (!state) return;
    overlayHub.sendTo(c, { topic: "hud.snapshot", sequence: ++hudSeq, sentAt: Date.now(), payload: state }, { snapshot: force });
  };
  let lastHudPush = 0;
  let hudPending: ReturnType<typeof setTimeout> | null = null;
  const pushHud = () => {
    const now = Date.now();
    const wait = 100 - (now - lastHudPush);
    if (wait > 0) {
      if (!hudPending) hudPending = setTimeout(() => ((hudPending = null), pushHud()), wait);
      return;
    }
    lastHudPush = now;
    for (const c of overlayHub.clients) sendHud(c, c.needsSnapshot);
  };
  e.onHudUpdate(() => pushHud());

  // Library output pages (/hud/<id>/<variant>) keep a read-only control socket: the server sends
  // a HudRuntimeControl on connect and whenever stopped, hidden or reloadSeq change.
  const runtimeHub = new WsHub();
  const sendControl = (c: HubClient) => {
    const ctl = e.hudLibrary.control(String(c.meta.hudId));
    if (ctl) runtimeHub.sendTo(c, ctl, { snapshot: true });
  };
  e.hudLibrary.attachRuntime({
    outputs: (hudId) => {
      const counts: Record<HudOutputMode, number> = { obs: 0, desktop: 0, preview: 0 };
      // The manager's own embedded preview (details panel) is not an output.
      for (const c of runtimeHub.clients) if (c.meta.hudId === hudId && !c.meta.embedded) counts[c.meta.mode as HudOutputMode]++;
      return counts;
    },
  });
  const offLibrary = e.hudLibrary.onChange((ev) => {
    if (ev.type === "control") {
      for (const c of runtimeHub.clients) if (ev.hudId === null || c.meta.hudId === ev.hudId) sendControl(c);
    } else if (ev.type === "closed") {
      // Removed HUD or rotated token: its outputs are disconnected (and cannot reconnect with the old token).
      const code = ev.reason === "removed" ? 4404 : 4401;
      for (const c of runtimeHub.clients) if (c.meta.hudId === ev.hudId) c.ws.close(code, ev.reason);
      for (const c of overlayHub.clients) if (c.meta.outputId === libraryOutputId(ev.hudId)) c.ws.close(code, ev.reason);
    }
  });
  const hudTimer = setInterval(() => {
    pushHud();
    // Control messages dropped for a slow client are resent once it drains.
    for (const c of runtimeHub.clients) if (c.needsSnapshot) sendControl(c);
  }, 500);

  const serveOverlay = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    const headers = { "content-security-policy": csp, "referrer-policy": "no-referrer" };
    const m = /^\/overlay\/([a-z0-9-]+)\/([a-z-]+)\/?$/.exec(p);
    if (m) {
      const [, outputId, variant] = m;
      if (!e.outputs.checkToken(outputId!, url.searchParams.get("t"))) return json(res, 401, { error: "unauthorized", message: "invalid or missing output token" });
      const pub = e.outputs.published(outputId!);
      if (!pub) return json(res, 404, { error: "not_found", message: "output not published" });
      const pkg = e.hudPackages.get(pub.data.packageId);
      if (!pkg) return json(res, 404, { error: "not_found", message: "HUD package missing" });
      if (pkg.classification === "builtin") {
        const idx = cfg.hudRendererDir ? join(cfg.hudRendererDir, "index.html") : null;
        if (!idx || !existsSync(idx)) return json(res, 503, { error: "hud_missing", message: "HUD renderer build not found (run pnpm build)" });
        return serveFile(res, idx, headers);
      }
      const entry = pkg.manifest.entryPoints[variant as keyof typeof pkg.manifest.entryPoints] ?? pkg.manifest.entryPoints.live;
      if (!entry) return json(res, 404, { error: "not_found", message: `package has no ${variant} entry` });
      res.writeHead(302, { location: `/huds/${encodeURIComponent(pkg.id)}/${entry}?output=${encodeURIComponent(outputId!)}&variant=${encodeURIComponent(variant!)}&t=${encodeURIComponent(url.searchParams.get("t")!)}` }).end();
      return;
    }
    if (p.startsWith("/huds/")) {
      const [, , id, ...rest] = p.split("/");
      const pkg = id ? e.hudPackages.get(decodeURIComponent(id)) : undefined;
      if (pkg && pkg.classification === "imported") {
        const f = safeResolve(pkg.installDir, rest.join("/"));
        if (f) return serveFile(res, f, headers);
      }
      return json(res, 404, { error: "not_found" });
    }
    if (p === "/hud-runtime/wrapper.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", ...headers });
      res.end(WRAPPER_JS);
      return;
    }
    // Library output page. Reserved ids (assets, sdk, ...) are the built-in renderer's own files below.
    const libPage = /^\/hud\/([^/]+)\/([^/]+)\/?$/.exec(p);
    if (libPage && !(RESERVED_HUD_IDS as readonly string[]).includes(libPage[1]!)) {
      const [, hudId, variant] = libPage as unknown as [string, string, string];
      const rt = e.hudLibrary.runtimeConfig(hudId);
      if (!rt) return json(res, 404, { error: "not_found", message: "unknown HUD" });
      const token = url.searchParams.get("t");
      if (!e.hudLibrary.checkToken(hudId, token)) return json(res, 401, { error: "unauthorized", message: "invalid or missing HUD token" });
      const entry = rt.entryPoints[variant as keyof typeof rt.entryPoints];
      if (!entry) return json(res, 404, { error: "not_found", message: `this HUD has no ${variant} variant` });
      const m = url.searchParams.get("mode") ?? "obs";
      const mode: HudOutputMode = (HUD_OUTPUT_MODES as readonly string[]).includes(m) ? (m as HudOutputMode) : "obs";
      const q = `output=${libraryOutputId(hudId)}&variant=${variant}&t=${encodeURIComponent(token!)}`;
      const frameUrl = rt.builtin ? `/hud/index.html?${q}` : `/huds/${encodeURIComponent(hudId)}/${entry.split("/").map(encodeURIComponent).join("/")}?${q}`;
      const embed = mode === "preview" && url.searchParams.get("embed") === "1" ? "&embed=1" : "";
      const html = wrapperPage({ hudId, name: rt.name, variant, mode, checker: url.searchParams.get("checker") === "1", frameUrl, controlPath: `/hud-runtime-ws?hud=${encodeURIComponent(hudId)}&variant=${variant}&mode=${mode}${embed}&t=${encodeURIComponent(token!)}`, ...rt.designResolution });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
      res.end(html);
      return;
    }
    const radar = /^\/overlay-api\/radar\/([a-z0-9_]+)$/.exec(p);
    if (radar) {
      const rt = e.maps.get(radar[1]!);
      const outline = rt?.schematicOutline();
      if (!outline) return json(res, 404, { error: "not_found", message: "no schematic geometry for this map" });
      return json(res, 200, { mapName: rt!.mapName, ...outline }, { "cache-control": "public, max-age=600" });
    }
    if (p.startsWith("/assets/")) {
      const f = safeResolve(assetDir(e), p.slice("/assets/".length));
      if (f) return serveFile(res, f, headers);
      return json(res, 404, { error: "not_found" });
    }
    if (p.startsWith("/hud/") && serveStatic(res, cfg.hudRendererDir, p.slice("/hud".length), { headers })) return;
    if (p.startsWith("/sdk/") && cfg.hudRendererDir && serveStatic(res, join(cfg.hudRendererDir, "sdk"), p.slice("/sdk".length), { headers })) return;
    if (p === "/" || p === "/health") return json(res, 200, { ok: true, service: "matchframe-overlay" });
    json(res, 404, { error: "not_found" });
  };
  const overlay = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed", message: "overlay server is read-only" });
    try {
      serveOverlay(req, res);
    } catch (err) {
      e.logger.error("overlay server error", { error: String(err) });
      json(res, 500, { error: "internal" });
    }
  });
  overlay.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://local");
    const token = url.searchParams.get("t");
    const unauthorized = () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    };
    if (url.pathname === "/hud-runtime-ws") {
      const hudId = url.searchParams.get("hud") ?? "";
      if (!e.hudLibrary.checkToken(hudId, token)) return unauthorized();
      const m = url.searchParams.get("mode") ?? "obs";
      const mode = (HUD_OUTPUT_MODES as readonly string[]).includes(m) ? m : "obs";
      return runtimeHub.upgrade(req, socket, head, { hudId, variant: url.searchParams.get("variant"), mode, embedded: mode === "preview" && url.searchParams.get("embed") === "1" });
    }
    const outputId = url.searchParams.get("output") ?? "";
    const hudId = libraryHudId(outputId);
    if (url.pathname !== "/overlay-ws" || !(hudId !== null ? e.hudLibrary.checkToken(hudId, token) : e.outputs.checkToken(outputId, token))) return unauthorized();
    overlayHub.upgrade(req, socket, head, { outputId, variant: url.searchParams.get("variant") });
  });

  if (!isLoopback(cfg.host)) e.logger.warn("engine is bound to a non-loopback address; LAN clients need tokens and should use a firewall", { host: cfg.host });
  await listen(gsi, cfg.gsiPort, cfg.host);
  await listen(api, cfg.apiPort, cfg.host);
  await listen(overlay, cfg.overlayPort, cfg.host);
  e.logger.info("engine listening", { host: cfg.host, gsiPort: cfg.gsiPort, apiPort: cfg.apiPort, overlayPort: cfg.overlayPort });

  return {
    gsi,
    api,
    overlay,
    operatorHub,
    overlayHub,
    runtimeHub,
    router,
    async close() {
      clearInterval(operatorTimer);
      clearInterval(hudTimer);
      if (hudPending) clearTimeout(hudPending);
      offLibrary();
      e.hudLibrary.attachRuntime(null);
      operatorHub.closeAll();
      overlayHub.closeAll();
      runtimeHub.closeAll();
      await Promise.all([gsi, api, overlay].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
    get rejectedOverlayMessages() {
      return rejectedOverlayMessages;
    },
  } as RunningServers & { rejectedOverlayMessages: number };
}
