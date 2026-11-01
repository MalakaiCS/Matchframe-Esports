import { z } from "zod";
import type { Engine } from "../app.ts";
import { ListenInError } from "../comms/controller.ts";
import { OverlaySetupError } from "../comms/overlay.ts";
import { CommsPublicPatch } from "../comms/public.ts";
import { CommsSettingsPatch, ParticipantPatch, SlotPatch, type SlotId } from "../comms/service.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

/**
 * Team Comms (ADR-065, ADR-066): the bridge to the TeamSpeak plugin, the team slots, the people heard
 * and what each output includes; the public listen-in (one output-state controller: Listen In by team
 * id, End Listen-In, Mute All Comms), the NDI outputs, caster ducking and the team-only overlay. The
 * operator's preview is a WebSocket (`/api/v1/comms/preview/ws`, servers.ts). The dedicated
 * recording's controls come with it (phase 4).
 */
export function registerCommsRoutes(r: Router, e: Engine): void {
  const view = () => ({ ...e.teamComms.status(), onAir: e.commsPublic.status() });
  r.get("/api/v1/comms", { permission: "state.read" }, () => view());

  r.put("/api/v1/comms/settings", { permission: "program.control", body: CommsSettingsPatch }, async (req) => {
    const s = await e.teamComms.updateSettings(req.body);
    e.commsPublic.sync();
    e.audit.record(req.principal!.label, "comms.settings", null, s);
    return view();
  });

  r.put("/api/v1/comms/slots/:slot", { permission: "settings.manage", body: SlotPatch }, (req) => {
    const slot = req.params.slot!.toUpperCase();
    if (slot !== "A" && slot !== "B") throw new HttpError(404, "team slots are A and B", "no_slot");
    const cfg = e.teamComms.updateSlot(slot as SlotId, req.body);
    e.audit.record(req.principal!.label, "comms.slot", slot, { ...cfg, serverPassword: req.body.serverPassword === undefined ? undefined : "[changed]", channelPassword: req.body.channelPassword === undefined ? undefined : "[changed]" });
    return e.teamComms.status().slots.find((s) => s.id === slot);
  });

  r.put("/api/v1/comms/participants/:key", { permission: "program.control", body: ParticipantPatch }, (req) => {
    const key = decodeURIComponent(req.params.key!);
    if (!e.teamComms.participantRecord(key)) throw new HttpError(404, "no TeamSpeak participant with that key", "no_participant");
    try {
      const rec = e.teamComms.updateParticipant(key, req.body);
      e.audit.record(req.principal!.label, "comms.participant", key, req.body);
      return rec;
    } catch (err) {
      throw new HttpError(400, (err as Error).message, "bad_participant");
    }
  });

  r.post("/api/v1/comms/bridge/rotate-token", { permission: "settings.manage", body: z.object({}).optional() }, (req) => {
    e.teamComms.rotateToken();
    e.audit.record(req.principal!.label, "comms.rotate_token", null);
    return { rotated: true, note: "The TeamSpeak plugin reads the new token from the bridge file and reconnects." };
  });

  // ------------------------------------------------------------------ the public listen-in (one controller)
  const act = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ListenInError) throw new HttpError(err.status, err.message, err.code);
      throw err;
    }
  };

  r.post("/api/v1/comms/listen-in", { permission: "program.control", body: z.object({ teamId: z.string().min(1).max(100) }) }, (req) => {
    const v = act(() => e.commsPublic.controller.listenIn(req.body.teamId, req.principal!.label));
    e.audit.record(req.principal!.label, "comms.listen_in", req.body.teamId, { team: v.team?.name ?? null });
    return v;
  });

  r.post("/api/v1/comms/listen-in/end", { permission: "program.control", body: z.object({}).optional() }, (req) => {
    const v = e.commsPublic.controller.end(req.principal!.label);
    e.audit.record(req.principal!.label, "comms.listen_in_end", null);
    return v;
  });

  r.post("/api/v1/comms/mute-all", { permission: "program.control", body: z.object({}).optional() }, (req) => {
    const v = e.commsPublic.controller.muteAll(req.principal!.label);
    e.audit.record(req.principal!.label, "comms.mute_all", null);
    return v;
  });

  r.put("/api/v1/comms/public", { permission: "program.control", body: CommsPublicPatch }, (req) => {
    const s = e.commsPublic.setSettings(req.body);
    e.audit.record(req.principal!.label, "comms.public", null, s);
    return e.commsPublic.status();
  });

  r.get("/api/v1/comms/obs/inputs", { permission: "state.read" }, () => e.commsPublic.obsInputs());

  r.get("/api/v1/comms/obs/check", { permission: "state.read" }, () => e.commsPublic.obsCheck());

  r.post("/api/v1/comms/overlay/obs", { permission: "settings.manage", body: z.object({}).optional() }, async (req) => {
    try {
      const res = await e.commsPublic.setupOverlay();
      e.audit.record(req.principal!.label, "comms.overlay_obs", res.scene, { source: res.source, created: res.created });
      return res;
    } catch (err) {
      if (err instanceof OverlaySetupError) throw new HttpError(409, err.message, err.code);
      throw err;
    }
  });
}
