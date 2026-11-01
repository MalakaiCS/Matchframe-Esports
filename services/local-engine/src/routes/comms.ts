import { z } from "zod";
import type { Engine } from "../app.ts";
import { CalibrationError, CalibrationSettings } from "../comms/calibrate.ts";
import { ListenInError } from "../comms/controller.ts";
import { OverlaySetupError } from "../comms/overlay.ts";
import { CommsPublicPatch } from "../comms/public.ts";
import { RecordingError, RecordingPatch, SetupRequest } from "../comms/recording.ts";
import { PortraitCrop, StripSettings } from "../comms/strip.ts";
import { CommsSettingsPatch, ParticipantPatch, patchOf, SlotPatch, type SlotId } from "../comms/service.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

/**
 * Team Comms (ADR-065, ADR-066): the bridge to the TeamSpeak plugin, the team slots, the people heard
 * and what each output includes; the public listen-in (one output-state controller: Listen In by team
 * id, End Listen-In, Mute All Comms), the NDI outputs, caster ducking and the team-only overlay. The
 * operator's preview is a WebSocket (`/api/v1/comms/preview/ws`, servers.ts). The dedicated
 * recording (ADR-068): Start/Stop, its team, levels, folder and OBS scene; the speaker strip's
 * settings; the delay calibration against the gameplay.
 */
export function registerCommsRoutes(r: Router, e: Engine): void {
  const view = () => ({ ...e.teamComms.status(), onAir: e.commsPublic.status(), recorder: e.commsRecording.status(), strip: { ...e.speakerStrip.status(), settings: e.stripSettings() }, calibration: e.commsCalibration.status() });
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

  // ------------------------------------------------------------------ the dedicated recording (ADR-068)
  const rec = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RecordingError || err instanceof CalibrationError) throw new HttpError(err.status, err.message, err.code);
      if ((err as { status?: number }).status === 400) throw new HttpError(400, (err as Error).message, "bad_folder");
      throw err;
    }
  };

  r.post("/api/v1/comms/recording/start", { permission: "program.control", body: z.object({}).optional() }, async (req) => {
    const st = await rec(() => e.commsRecording.start(req.principal!.label));
    e.audit.record(req.principal!.label, "comms.recording_start", st.team?.id ?? null, { team: st.team?.name ?? null, folder: st.folder });
    return st;
  });

  r.post("/api/v1/comms/recording/stop", { permission: "program.control", body: z.object({}).optional() }, async (req) => {
    const st = await rec(() => e.commsRecording.stop(req.principal!.label));
    e.audit.record(req.principal!.label, "comms.recording_stop", null, { file: st.last?.path ?? null });
    return st;
  });

  r.post("/api/v1/comms/recording/team", { permission: "program.control", body: z.object({ teamId: z.string().min(1).max(100).nullable() }) }, async (req) => {
    await rec(() => e.commsRecording.setTeam(req.body.teamId));
    e.audit.record(req.principal!.label, "comms.recording_team", req.body.teamId, null);
    return e.commsRecording.status();
  });

  r.put("/api/v1/comms/recording", { permission: "program.control", body: RecordingPatch }, async (req) => {
    const s = await rec(() => e.commsRecording.setSettings(req.body));
    e.audit.record(req.principal!.label, "comms.recording_settings", null, s);
    return e.commsRecording.status();
  });

  r.get("/api/v1/comms/recording/obs/sources", { permission: "state.read" }, () => e.commsRecording.liveSources());

  r.post("/api/v1/comms/recording/obs", { permission: "settings.manage", body: SetupRequest.optional() }, async (req) => {
    const res = await rec(() => e.commsRecording.setupObs(req.body ?? {}));
    e.audit.record(req.principal!.label, "comms.recording_obs", res.scene, { ok: res.ok, failed: res.steps.filter((s) => s.ok === false).map((s) => s.id) });
    return res;
  });

  r.put("/api/v1/comms/strip", { permission: "program.control", body: patchOf(StripSettings.omit({ crops: true })) }, (req) => {
    const prev = e.stripSettings();
    const s = e.setStripSettings({ ...prev, ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) } as typeof prev);
    e.audit.record(req.principal!.label, "comms.strip", null, { ...s, crops: Object.keys(s.crops).length });
    return { ...e.speakerStrip.status(), settings: s };
  });

  r.put("/api/v1/comms/strip/crop", { permission: "program.control", body: z.object({ key: z.string().min(1).max(160), crop: PortraitCrop.nullable() }) }, (req) => {
    const prev = e.stripSettings();
    const crops = { ...prev.crops };
    if (req.body.crop) crops[req.body.key] = req.body.crop;
    else delete crops[req.body.key];
    const s = e.setStripSettings({ ...prev, crops });
    e.audit.record(req.principal!.label, "comms.strip_crop", req.body.key, req.body.crop);
    return { ...e.speakerStrip.status(), settings: s };
  });

  r.post("/api/v1/comms/calibration/arm", { permission: "program.control", body: z.object({ teamId: z.string().min(1).max(100) }) }, (req) => rec(() => e.commsCalibration.arm(req.body.teamId)));
  r.post("/api/v1/comms/calibration/seen", { permission: "program.control", body: z.object({}).optional() }, () => rec(() => e.commsCalibration.seen()));
  r.post("/api/v1/comms/calibration/clear", { permission: "program.control", body: z.object({}).optional() }, () => e.commsCalibration.clear());
  r.put("/api/v1/comms/calibration", { permission: "program.control", body: patchOf(CalibrationSettings) }, (req) => {
    e.commsCalibration.setSettings(req.body);
    return e.commsCalibration.status();
  });
  r.post("/api/v1/comms/calibration/apply", { permission: "program.control", body: z.object({}).optional() }, async (req) => {
    const d = await rec(() => e.commsCalibration.apply());
    e.commsPublic.sync();
    e.audit.record(req.principal!.label, "comms.calibration_apply", null, d);
    return { ...d, calibration: e.commsCalibration.status() };
  });
}
