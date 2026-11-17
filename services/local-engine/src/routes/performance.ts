import { z } from "zod";
import type { Engine } from "../app.ts";
import type { Router } from "../http/router.ts";

/**
 * Low-spec mode (one PC, ADR-078): Settings → General → Performance. Off by default; turning it on or
 * off is audited and takes effect at once (the engine's memory cap from the next engine start).
 */
export function registerPerformanceRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/performance", { permission: "state.read" }, () => e.lowSpec.status());

  r.put("/api/v1/performance", { permission: "settings.manage", body: z.object({ lowSpec: z.boolean() }) }, (req) => {
    if (e.lowSpec.set(req.body.lowSpec)) e.audit.record(req.principal!.label, req.body.lowSpec ? "performance.low_spec.on" : "performance.low_spec.off", null, { frameCap: e.lowSpec.frameCap() });
    return e.lowSpec.status();
  });

  /** The one-time suggestion, dismissed: it is not shown again. */
  r.post("/api/v1/performance/suggestion/dismiss", { permission: "settings.manage" }, (req) => {
    e.lowSpec.dismissSuggestion();
    e.audit.record(req.principal!.label, "performance.low_spec.suggestion_dismissed", null);
    return e.lowSpec.status();
  });
}
