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

/** A clip of the round's list (automatic replays): its id, its place in the list as shown (1 = the best), or the next one to play. */
const ClipTarget = z.object({ id: z.string().max(80).optional(), rank: z.number().int().min(1).max(30).optional(), next: z.boolean().optional() });

function clipFor(e: Engine, p: z.infer<typeof ClipTarget>): string {
  const ranked = e.autoReplay.getStatus().ranked;
  if (p.id) return p.id;
  if (p.rank !== undefined) {
    const r = ranked[p.rank - 1];
    if (!r) throw new HttpError(404, `the round's list has no clip ${p.rank}`, "no_clip");
    return r.id;
  }
  if (p.next) {
    const r = ranked.find((x) => x.state === "waiting" && !x.excluded);
    if (!r) throw new HttpError(404, "no clip is waiting to play", "no_clip");
    return r.id;
  }
  throw new HttpError(400, "give the clip's id, its rank in the round's list, or next: true", "validation");
}

/** What a highlights action reports: the highlights' state now. */
const highlightsResult = (st: ReturnType<Engine["highlightsAir"]["status"]>) => ({ state: st.state, detail: st.detail, running: st.running, held: st.held, onAir: st.playing, position: st.position });

/** What a replay action reports: the replays' state now. */
const replayResult = (e: Engine, st: ReturnType<Engine["autoReplay"]["getStatus"]>) => ({ state: st.state, detail: st.detail, running: st.running, held: st.held, onAir: st.playing, position: st.position });

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
    id: "replay_skip",
    label: "Replays: skip the clip on air (the next one comes in, or back to live after the last)",
    permission: "replay.control",
    params: NoParams,
    run: (e) => replayResult(e, e.autoReplay.skip()),
  },
  {
    id: "replay_stop",
    label: "Replays: stop and go live (Replay out)",
    permission: "replay.control",
    params: NoParams,
    run: (e) => replayResult(e, e.autoReplay.stop()),
  },
  {
    id: "replay_hold",
    label: "Replays: hold the clip on air, or resume (toggles; held true/false sets it)",
    permission: "replay.control",
    params: z.object({ held: z.boolean().optional() }),
    run: (e, _req, p: { held?: boolean }) => replayResult(e, e.autoReplay.hold(p.held)),
  },
  {
    id: "replay_exclude",
    label: "Replays: exclude a clip of the round (id, rank in the round's list, or next: the next to play; toggles unless excluded is given)",
    permission: "replay.control",
    params: ClipTarget.extend({ excluded: z.boolean().optional() }),
    run: (e, _req, p: z.infer<typeof ClipTarget> & { excluded?: boolean }) => replayResult(e, e.autoReplay.exclude(clipFor(e, p), p.excluded)),
  },
  {
    id: "replay_pin",
    label: "Replays: pin a clip of the round to play first, if it fits (id or rank in the round's list; toggles unless pinned is given)",
    permission: "replay.control",
    params: ClipTarget.extend({ pinned: z.boolean().optional() }),
    run: (e, _req, p: z.infer<typeof ClipTarget> & { pinned?: boolean }) => replayResult(e, e.autoReplay.pin(clipFor(e, p), p.pinned)),
  },
  {
    id: "highlights_play",
    label: "Highlights: play the map's best clips on air now (Highlights on air: what and how many as set there), then back to the scene the program came from",
    permission: "replay.control",
    params: NoParams,
    run: async (e, req) => highlightsResult(await e.highlightsAir.play({ owner: "operator", who: req.principal!.label })),
  },
  {
    id: "highlights_stop",
    label: "Highlights: stop now, back to the scene the program came from (Highlights out). Skip and Hold: replay_skip, replay_hold",
    permission: "replay.control",
    params: NoParams,
    run: (e, req) => highlightsResult(e.highlightsAir.stop(req.principal!.label)),
  },
  {
    id: "highlights_halftime",
    label: "Highlights: Don't show highlights at halftime, on (true) or off (false); toggles when not given",
    permission: "replay.control",
    params: z.object({ on: z.boolean().optional() }),
    run: (e, req, p: { on?: boolean }) => {
      const on = p.on ?? !e.highlightsAir.settings().noHalftime;
      e.highlightsAir.setSettings({ noHalftime: on });
      e.audit.record(req.principal!.label, "highlights.no_halftime", null, { on });
      return { noHalftime: on, halftime: e.highlightsAir.halftime() };
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

/** Automatic replays for button lights: playing (and which clip of how many), held, the round's clips waiting. */
const replayTally = (e: Engine) => e.autoReplay.brief();

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
    replay: replayTally(e),
    /** Highlights on air (ADR-063): playing (which clip, of how many), held, ready to play, halftime now, and Don't show highlights at halftime. */
    highlights: e.highlightsAir.brief(),
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
