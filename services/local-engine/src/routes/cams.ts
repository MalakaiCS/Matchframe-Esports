import { z } from "zod";
import type { Engine } from "../app.ts";
import type { Router } from "../http/router.ts";
import { HttpError } from "../http/router.ts";

const SteamParam = (id: string | undefined) => {
  if (!id || !/^\d{17}$/.test(id)) throw new HttpError(400, "not a SteamID64", "invalid");
  return id;
};

/** Player cams (ADR-048): switch on, the link for players, the delay, and each player's cam. */
export function registerCamRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/cams", { permission: "state.read" }, () => e.cams.status());
  r.put(
    "/api/v1/cams/settings",
    {
      permission: "settings.manage",
      body: z.object({
        enabled: z.boolean().optional(),
        delayMs: z.number().int().min(0).max(300_000).optional(),
        quality: z.enum(["low", "standard", "high"]).optional(),
        autoApprove: z.boolean().optional(),
      }),
    },
    (req) => {
      const st = e.cams.setSettings(req.body);
      e.audit.record(req.principal!.label, "cams.settings", null, req.body);
      return st;
    },
  );
  r.post("/api/v1/cams/new-link", { permission: "settings.manage" }, (req) => {
    const st = e.cams.newLink();
    e.audit.record(req.principal!.label, "cams.new_link", null);
    return st;
  });
  r.post("/api/v1/cams/players/:steamId/approve", { permission: "hud.publish" }, (req) => {
    e.cams.approve(SteamParam(req.params.steamId));
    return e.cams.status();
  });
  r.put("/api/v1/cams/players/:steamId/hidden", { permission: "hud.publish", body: z.object({ hidden: z.boolean() }) }, (req) => {
    e.cams.setHidden(SteamParam(req.params.steamId), req.body.hidden);
    return e.cams.status();
  });
  r.post("/api/v1/cams/players/:steamId/kick", { permission: "hud.publish" }, (req) => {
    e.cams.kick(SteamParam(req.params.steamId));
    e.audit.record(req.principal!.label, "cams.kick", req.params.steamId ?? null);
    return e.cams.status();
  });
}
