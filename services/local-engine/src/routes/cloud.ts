import { z } from "zod";
import type { Engine } from "../app.ts";
import type { Router } from "../http/router.ts";

/** Account link, licence and auto-director hours (the website handles signup, billing and plans). */
export function registerCloudRoutes(r: Router, e: Engine): void {
  const simulated = () => e.simulationRunning || e.session.simulated;

  r.get("/api/v1/cloud/status", { permission: "state.read" }, () => e.cloud.status(simulated()));

  r.put("/api/v1/cloud/url", { permission: "settings.manage", body: z.object({ url: z.string().max(300).nullable() }) }, async (req) => {
    await e.cloud.setUrl(req.body.url);
    e.audit.record(req.principal!.label, "cloud.url", req.body.url);
    return e.cloud.status(simulated());
  });

  r.post("/api/v1/cloud/login", { permission: "settings.manage", body: z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(200), orgId: z.string().max(64).optional(), deviceName: z.string().trim().max(80).optional() }) }, async (req) => {
    const out = await e.cloud.login({ email: req.body.email, password: req.body.password, orgId: req.body.orgId, deviceName: req.body.deviceName || undefined });
    if (out.status === "signed_in") e.audit.record(req.principal!.label, "cloud.sign_in", out.user.email, { organisation: out.orgName });
    return { ...out, cloud: e.cloud.status(simulated()) };
  });

  r.post("/api/v1/cloud/link/start", { permission: "settings.manage", body: z.object({ deviceName: z.string().max(80).optional() }) }, async (req) => {
    const out = await e.cloud.startLink(req.body.deviceName);
    e.audit.record(req.principal!.label, "cloud.link_start", null);
    return out;
  });

  r.post("/api/v1/cloud/link/cancel", { permission: "settings.manage" }, (req) => {
    e.cloud.cancelLink();
    e.audit.record(req.principal!.label, "cloud.link_cancel", null);
    return e.cloud.status(simulated());
  });

  r.post("/api/v1/cloud/refresh", { permission: "settings.manage" }, async () => {
    e.meter.flush();
    await e.cloud.refresh();
    return e.cloud.status(simulated());
  });

  r.post("/api/v1/cloud/unlink", { permission: "settings.manage" }, async (req) => {
    e.meter.flush();
    await e.cloud.sync();
    await e.cloud.unlink();
    e.audit.record(req.principal!.label, "cloud.unlink", null);
    return e.cloud.status(simulated());
  });

  r.get("/api/v1/cloud/usage", { permission: "state.read" }, (req) => ({
    records: e.usageLedger.recent(Math.min(500, Number(req.query.get("limit") ?? 100))),
    stats: e.usageLedger.stats(),
  }));
}
