import { z } from "zod";
import { DirectorMode, ObserverMode } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import type { Permission } from "../auth.ts";
import { can } from "../auth.ts";
import { HttpError } from "../http/router.ts";
import type { Req, Router } from "../http/router.ts";

/**
 * Control-surface API for hotkeys, Stream Deck, Bitfocus Companion and similar devices.
 * One stable endpoint per named action, each with its own permission, all routed through the
 * same control arbiter / program arbiter as the operator UI (no device-only shortcuts).
 */
interface DeviceAction {
  id: string;
  label: string;
  permission: Permission;
  params: z.ZodTypeAny;
  run: (e: Engine, req: Req, params: never) => Promise<unknown> | unknown;
}

const NoParams = z.object({}).strict();

const ACTIONS: DeviceAction[] = [
  {
    id: "emergency_stop",
    label: "Emergency stop (all automation)",
    permission: "camera.control",
    params: NoParams,
    run: async (e) => {
      await e.session.emergencyStop();
      return { ownership: e.session.arbiter.state() };
    },
  },
  {
    id: "takeover",
    label: "Take manual control",
    permission: "camera.control",
    params: NoParams,
    run: (e, req) => {
      e.session.takeover(req.principal!.label);
      return { ownership: e.session.arbiter.state() };
    },
  },
  {
    id: "resume",
    label: "Resume automation (countdown)",
    permission: "director.control",
    params: z.object({ countdownMs: z.number().int().min(0).max(30000).default(3000) }),
    run: (e, _req, p: { countdownMs: number }) => {
      e.session.resume(p.countdownMs);
      return { ownership: e.session.arbiter.state(), resumeInMs: e.session.arbiter.resumePendingInMs() };
    },
  },
  {
    id: "cancel_resume",
    label: "Cancel pending resume",
    permission: "director.control",
    params: NoParams,
    run: (e) => {
      e.session.cancelResume();
      return { ownership: e.session.arbiter.state() };
    },
  },
  {
    id: "hold",
    label: "Hold current shot",
    permission: "director.control",
    params: z.object({ durationMs: z.number().int().positive().max(600000).nullable().default(10000) }),
    run: (e, _req, p: { durationMs: number | null }) => {
      e.session.hold(p.durationMs);
      return { hold: e.session.director.controls.hold };
    },
  },
  {
    id: "release_hold",
    label: "Release hold",
    permission: "director.control",
    params: NoParams,
    run: (e) => {
      e.session.releaseHold();
      return { hold: null };
    },
  },
  {
    id: "follow_action",
    label: "Follow action now",
    permission: "director.control",
    params: NoParams,
    run: (e) => {
      e.session.followAction();
      return { decision: e.session.output()?.decision ?? null };
    },
  },
  {
    id: "observer_mode",
    label: "Set Observer mode (off, observer, observer_cinematics, full_action)",
    permission: "director.control",
    params: z.object({ mode: ObserverMode }),
    run: (e, _req, p: { mode: z.infer<typeof ObserverMode> }) => {
      e.session.setObserverMode(p.mode);
      return { observerMode: e.session.observerMode };
    },
  },
  {
    id: "director_mode",
    label: "Set director mode",
    permission: "director.control",
    params: z.object({ mode: DirectorMode }),
    run: (e, _req, p: { mode: z.infer<typeof DirectorMode> }) => {
      e.session.setMode(p.mode);
      return { mode: e.session.director.currentMode };
    },
  },
  {
    id: "select_slot",
    label: "Select player by number key (1–9, 0)",
    permission: "camera.control",
    params: z.object({ slot: z.number().int().min(0).max(12) }),
    run: async (e, req, p: { slot: number }) => {
      const player = e.session.state()?.players.find((x) => x.observerKey === p.slot && !x.coach);
      if (!player) throw new HttpError(404, `no player on number key ${p.slot}`, "no_player");
      return e.session.manualSelectPlayer(player.steamId, req.principal!.label, "device");
    },
  },
  {
    id: "cinematics_round",
    label: "Disable/enable cinematics for this round",
    permission: "director.control",
    params: z.object({ disabled: z.boolean() }),
    run: (e, _req, p: { disabled: boolean }) => {
      e.session.disableCinematics("round", p.disabled);
      return { cinematicsDisabled: e.session.director.controls.cinematicsDisabled };
    },
  },
  {
    id: "bookmark_replay",
    label: "Bookmark replay moment",
    permission: "replay.control",
    params: z.object({ label: z.string().max(80).default("Device bookmark") }),
    run: (e, _req, p: { label: string }) => {
      const st = e.session.state();
      const round = e.playRound();
      const item = e.replays.bookmark(p.label, "manual", round);
      void e.replays.capture(item.id, {
        preRollMs: 8000,
        postRollMs: 2000,
        sourceIds: null,
        matchTimeMs: st?.time.matchTimeMs ?? null,
        timeUncertaintyMs: st?.time.timeUncertaintyMs ?? null,
        epoch: st?.epoch ?? null,
        roundNumber: round,
      });
      return item;
    },
  },
  {
    id: "return_live",
    label: "Return program to LIVE",
    permission: "program.control",
    params: NoParams,
    run: async (e, req) => {
      const playing = e.program.activeReplay;
      const t = await e.program.request("LIVE", "operator", req.principal!.label);
      if (playing) e.replays.markPlayed(playing);
      return t;
    },
  },
  {
    id: "program_mode",
    label: "Cue program mode (STUDIO / BREAK / MANUAL)",
    permission: "program.control",
    params: z.object({ mode: z.enum(["STUDIO", "BREAK", "MANUAL"]) }),
    run: (e, req, p: { mode: "STUDIO" | "BREAK" | "MANUAL" }) => e.program.request(p.mode, "operator", req.principal!.label),
  },
];

/** Compact, poll-friendly state for button tally lights. */
export function tally(e: Engine) {
  const s = e.session.state();
  const own = e.session.arbiter.state();
  const observed = s?.observer.observedSteamId ?? null;
  return {
    simulated: e.simulationRunning,
    telemetry: !s ? "none" : s.sources.some((src) => src.connected && !src.stale) ? "live" : "stale",
    program: { mode: e.program.mode, activeReplay: e.program.activeReplay },
    obs: { connected: e.obs.state.connected, programScene: e.obs.state.programScene, previewScene: e.obs.state.previewScene, streaming: e.obs.state.streaming, recording: e.obs.state.recording },
    director: { mode: e.session.director.currentMode, hold: e.session.director.controls.hold !== null, cinematic: e.session.director.shotPlanner.activeCinematic?.shotKey ?? null },
    control: { owner: own.owner, holder: own.holder, automationActive: e.session.arbiter.automationAllowed, manualSticky: own.manualSticky, emergencyStopped: own.emergencyStopped, resumeInMs: e.session.arbiter.resumePendingInMs() },
    pov: observed,
    slots: (s?.players ?? [])
      .filter((p) => p.observerKey !== null && !p.coach)
      .sort((a, b) => (a.observerSlot ?? 0) - (b.observerSlot ?? 0))
      .map((p) => ({ slot: p.observerKey, steamId: p.steamId, name: p.name, side: p.side, alive: p.lifeState === "alive", onAir: p.steamId === observed })),
  };
}

export function registerDeviceRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/devices/actions", { permission: "state.read" }, (req) =>
    ACTIONS.map((a) => ({
      id: a.id,
      label: a.label,
      permission: a.permission,
      allowed: can(req.principal!.role, a.permission),
      params: z.toJSONSchema(a.params, { io: "input", unrepresentable: "any" }),
      request: `POST /api/v1/devices/actions/${a.id}`,
    })),
  );

  r.post("/api/v1/devices/actions/:action", { permission: "state.read" }, async (req) => {
    const action = ACTIONS.find((a) => a.id === req.params.action);
    if (!action) throw new HttpError(404, `unknown device action ${req.params.action}`, "unknown_action");
    if (!can(req.principal!.role, action.permission)) throw new HttpError(403, `role ${req.principal!.role} lacks ${action.permission}`, "forbidden");
    const parsed = action.params.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, "request validation failed", "validation", parsed.error.issues);
    e.audit.record(req.principal!.label, `device.${action.id}`, null, parsed.data);
    const result = await action.run(e, req, parsed.data as never);
    return { action: action.id, result, tally: tally(e) };
  });

  r.get("/api/v1/devices/tally", { permission: "state.read" }, () => tally(e));
}
