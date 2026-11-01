import { z } from "zod";
import type { Engine } from "../app.ts";
import { CommsSettingsPatch, ParticipantPatch, SlotPatch, type SlotId } from "../comms/service.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

/**
 * Team Comms (ADR-065): the bridge to the TeamSpeak plugin, the team slots, the people heard and
 * what each output includes. The public listen-in and the dedicated recording's controls come with
 * their outputs (later phases).
 */
export function registerCommsRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/comms", { permission: "state.read" }, () => e.teamComms.status());

  r.put("/api/v1/comms/settings", { permission: "program.control", body: CommsSettingsPatch }, async (req) => {
    const s = await e.teamComms.updateSettings(req.body);
    e.audit.record(req.principal!.label, "comms.settings", null, s);
    return e.teamComms.status();
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
}
