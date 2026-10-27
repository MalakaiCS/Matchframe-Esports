import { z } from "zod";
import { mapResult, MatchFrameBridge } from "@matchframe/matchframe-bridge";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

const BridgeConfig = z.object({ enabled: z.boolean().default(false), url: z.string().url().nullable().default(null), autoPushResults: z.boolean().default(false) });

let bridge: MatchFrameBridge | null = null;

function getBridge(e: Engine): MatchFrameBridge | null {
  const cfg = BridgeConfig.parse(e.settings.get("matchframe.bridge", {}));
  if (!cfg.enabled || !cfg.url) return null;
  if (!bridge) {
    const token = e.secrets.getSecret("matchframe.bridgeToken");
    bridge = new MatchFrameBridge(cfg.url, token ? { token } : {});
  }
  return bridge;
}

/** Best-effort result push; never throws and never blocks the caller. */
export function pushResultIfEnabled(e: Engine, matchId: string): void {
  const cfg = BridgeConfig.parse(e.settings.get("matchframe.bridge", {}));
  const b = getBridge(e);
  if (!b || !cfg.autoPushResults) return;
  const m = e.matches.get(matchId)?.data;
  if (!m) return;
  void (async () => {
    if (!b.capabilities) await b.discover();
    const ok = await b.pushResult(mapResult(m, e.mapInstances.forMatch(m.id), new Map(e.teams.list().map((t) => [t.id, t.data]))));
    if (!ok) e.logger.warn("MatchFrame bridge push failed (local broadcast unaffected)", { error: b.lastError });
  })();
}

export function registerIntegrationRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/integrations/matchframe", { permission: "metadata.read" }, () => {
    const cfg = BridgeConfig.parse(e.settings.get("matchframe.bridge", {}));
    const b = getBridge(e);
    return {
      config: cfg,
      status: !cfg.enabled ? "disabled" : !b ? "not configured" : b.capabilities ? "connected" : "blocked",
      capabilities: b?.capabilities ?? null,
      lastError: b?.lastError ?? null,
      note: "The existing MatchFrame service API was not available to this project; the bridge speaks the documented Matchframe bridge contract (docs/integrations/matchframe-bridge.md), which a thin adapter on the MatchFrame side must implement.",
    };
  });
  r.put("/api/v1/integrations/matchframe", { permission: "settings.manage", body: BridgeConfig.extend({ token: z.string().optional() }) }, (req) => {
    const { token, ...cfg } = req.body;
    e.settings.set("matchframe.bridge", cfg);
    if (token !== undefined) e.secrets.setSecret("matchframe.bridgeToken", token || null);
    bridge = null;
    e.audit.record(req.principal!.label, "integration.matchframe.config", null, cfg);
    return { config: cfg };
  });
  r.post("/api/v1/integrations/matchframe/discover", { permission: "settings.manage" }, async () => {
    const b = getBridge(e);
    if (!b) throw new HttpError(409, "bridge disabled or URL not set", "not_configured");
    return { capabilities: await b.discover(), lastError: b.lastError };
  });
  r.post("/api/v1/integrations/matchframe/push-result", { permission: "metadata.write", body: z.object({ matchId: z.string() }) }, async (req) => {
    const b = getBridge(e);
    if (!b) throw new HttpError(409, "bridge disabled or URL not set", "not_configured");
    if (!b.capabilities) await b.discover();
    const m = e.matches.require(req.body.matchId).data;
    const ok = await b.pushResult(mapResult(m, e.mapInstances.forMatch(m.id), new Map(e.teams.list().map((t) => [t.id, t.data]))));
    e.audit.record(req.principal!.label, "integration.matchframe.push", m.id, { ok, error: b.lastError });
    return { ok, lastError: b.lastError };
  });
}
