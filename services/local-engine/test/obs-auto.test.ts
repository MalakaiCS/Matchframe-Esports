import { describe, expect, it } from "vitest";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../src/app.ts";
import { ObsAutomation } from "../src/live/obs-auto.ts";

function rig(scenes: { LIVE: string | null; REPLAY: string | null; STUDIO: string | null; BREAK: string | null }) {
  let s: Partial<MatchState> = { mapName: "de_dust2", mapPhase: "live", gamePhase: "live", roundPhase: "live", paused: false };
  const program = { mode: "LIVE", sceneMap: scenes, calls: [] as string[], async request(to: string) { this.calls.push(to); this.mode = to; return { to }; } };
  const transitions = { current: "Fade", names: ["Fade", "Cut", "Stinger"] };
  const settings = new Map<string, unknown>();
  const e = {
    settings: { get: (k: string, d: unknown) => settings.get(k) ?? d, set: (k: string, v: unknown) => settings.set(k, v) },
    session: { state: () => s as MatchState },
    program,
    obs: { state: { connected: true }, transitions: async () => ({ ...transitions }), setTransition: async (n: string) => void (transitions.current = n) },
    audit: { record: () => undefined },
    logger: { warn: () => undefined },
  } as unknown as Engine;
  const auto = new ObsAutomation(e);
  const tick = async (patch?: Partial<MatchState>) => {
    if (patch) s = { ...s, ...patch };
    await (auto as unknown as { tick(): Promise<void> }).tick();
  };
  return { auto, tick, program, transitions };
}

const SCENES = { LIVE: "Game", REPLAY: "Replay", STUDIO: "Desk", BREAK: "Break" };

describe("OBS scene automation", () => {
  it("goes to the break scene for a tactical timeout and back when play resumes", async () => {
    const { tick, program } = rig(SCENES);
    await tick({ gamePhase: "timeout_ct", roundPhase: "freezetime" });
    expect(program.calls).toEqual(["BREAK"]);
    await tick();
    await tick({ gamePhase: "freezetime" });
    expect(program.calls).toEqual(["BREAK", "LIVE"]);
  });

  it("goes to the studio scene at the end of a map, and back live when the next map starts", async () => {
    const { tick, program } = rig(SCENES);
    await tick({ mapPhase: "gameover", gamePhase: "gameover", roundPhase: "over" });
    expect(program.calls).toEqual(["STUDIO"]);
    await tick();
    await tick({ mapName: "de_mirage", mapPhase: "warmup", gamePhase: "warmup", roundPhase: "freezetime" });
    expect(program.calls).toEqual(["STUDIO", "LIVE"]);
  });

  it("never undoes the operator's own program choice, and does nothing without the scene mapped", async () => {
    const r = rig(SCENES);
    r.program.mode = "STUDIO";
    await r.tick({ gamePhase: "timeout_t" });
    await r.tick({ gamePhase: "live" });
    expect(r.program.calls).toEqual([]);
    const none = rig({ ...SCENES, BREAK: null });
    await none.tick({ gamePhase: "paused" });
    expect(none.program.calls).toEqual([]);
  });

});

/**
 * A stand-in OBS for transitions: its Fade has a translated name (found by kind), a Stinger, OBS's
 * one transition duration, and transitions that end when the test says.
 */
function transitionsRig(own = "Überblendung") {
  const list = [
    { name: "Schnitt", kind: "cut_transition", fixed: true },
    { name: "Überblendung", kind: "fade_transition", fixed: false },
    { name: "Swipe", kind: "swipe_transition", fixed: false },
    { name: "Stinger", kind: "obs_stinger_transition", fixed: true },
  ];
  const obs = { current: own, duration: 300, log: [] as string[], ends: [] as ((ok: boolean) => void)[] };
  const t = () => list.find((x) => x.name === obs.current)!;
  const settings = new Map<string, unknown>();
  const state = { connected: true, programScene: "Game" as string | null };
  const e = {
    settings: { get: (k: string, d: unknown) => settings.get(k) ?? d, set: (k: string, v: unknown) => settings.set(k, v) },
    logger: { warn: (msg: string) => obs.log.push(`warn ${msg}`) },
    obs: {
      state,
      transitionKinds: async () => ({ current: obs.current, transitions: list.map((x) => ({ ...x })) }),
      currentTransition: async () => ({ name: obs.current, kind: t().kind, fixed: t().fixed, durationMs: t().fixed ? null : obs.duration, settings: null }),
      setTransition: async (name: string) => {
        obs.current = name;
        obs.log.push(`transition ${name}`);
        return true;
      },
      setTransitionDuration: async (ms: number) => {
        obs.duration = ms;
        obs.log.push(`duration ${ms}`);
      },
      setProgram: async (scene: string) => {
        obs.log.push(`program ${scene} by ${obs.current}${t().fixed ? "" : ` ${obs.duration}`}`);
        state.programScene = scene;
        return { confirmed: true, programScene: scene };
      },
      waitTransitionEnd: () => new Promise<boolean>((r) => obs.ends.push(r)),
    },
  } as unknown as Engine;
  const auto = new ObsAutomation(e);
  /** OBS says the oldest running transition has ended. */
  const end = async () => {
    obs.ends.shift()?.(true);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return { auto, obs, settings, end };
}

describe("OBS transitions of the program", () => {
  it("goes into a replay with Replay in and back with Replay out (the same by default), and puts OBS's own back once each has ended", async () => {
    const { auto, obs, end } = transitionsRig();
    auto.setSettings({ replayIn: "Stinger" });
    expect(await auto.switchProgram("Replay", auto.pickFor({ from: "REPLAY_PREPARED", to: "REPLAY_PLAYING" }))).toBe(true);
    expect(obs.log).toEqual(["transition Stinger", "program Replay by Stinger"]);
    // The Stinger is still running: OBS's own isn't put back over it.
    expect(obs.current).toBe("Stinger");
    await end();
    expect(obs.current).toBe("Überblendung");
    obs.log.length = 0;
    await auto.switchProgram("Game", auto.pickFor({ from: "REPLAY_PLAYING", to: "LIVE" }));
    expect(obs.log).toEqual(["transition Stinger", "program Game by Stinger"]);
    await end();
    expect([obs.current, obs.duration]).toEqual(["Überblendung", 300]);
    // Replay out of its own.
    auto.setSettings({ replayOut: "Swipe" });
    obs.log.length = 0;
    await auto.switchProgram("Replay", auto.pickFor({ from: "REPLAY_PREPARED", to: "REPLAY_PLAYING" }));
    await end();
    await auto.switchProgram("Game", auto.pickFor({ from: "REPLAY_PLAYING", to: "LIVE" }));
    await end();
    expect(obs.log.filter((l) => l.startsWith("program"))).toEqual(["program Replay by Stinger", "program Game by Swipe 300"]);
  });

  it("fades between two replays with OBS's Fade (found by kind) for the fade's length, and puts OBS's duration back", async () => {
    const { auto, obs, end } = transitionsRig();
    obs.current = "Swipe";
    await auto.switchProgram("Replay B", { kind: "fade_transition", durationMs: 500 });
    expect(obs.log).toEqual(["transition Überblendung", "duration 500", "program Replay B by Überblendung 500"]);
    await end();
    expect([obs.current, obs.duration]).toEqual(["Swipe", 300]);
    obs.log.length = 0;
    await auto.switchProgram("Replay", { kind: "cut_transition" });
    expect(obs.log).toEqual(["transition Schnitt", "program Replay by Schnitt"]);
  });

  it("uses the Other scenes transition to and from the break and studio scenes, and OBS's own for anything else", async () => {
    const { auto, obs, end } = transitionsRig();
    auto.setSettings({ otherScenes: "Stinger", replayIn: "Swipe" });
    expect(auto.pickFor({ from: "LIVE", to: "BREAK" })).toEqual({ name: "Stinger" });
    expect(auto.pickFor({ from: "STUDIO", to: "LIVE" })).toEqual({ name: "Stinger" });
    expect(auto.pickFor({ from: "BREAK", to: "STUDIO" })).toEqual({ name: "Stinger" });
    expect(auto.pickFor({ from: "MANUAL", to: "LIVE" })).toBeNull();
    expect(auto.pickFor({ from: "DEGRADED", to: "LIVE" })).toBeNull();
    // Replay out follows Replay in; a replay played by hand and Return live go the same way.
    expect(auto.pickFor({ from: "REPLAY_PLAYING", to: "LIVE" })).toEqual({ name: "Swipe" });
    expect(auto.pickFor({ from: "REPLAY_PLAYING", to: "MANUAL" })).toEqual({ name: "Swipe" });
    auto.setSettings({ replayOut: "" });
    expect(auto.pickFor({ from: "REPLAY_PLAYING", to: "LIVE" })).toBeNull();
    await auto.switchProgram("Break", auto.pickFor({ from: "LIVE", to: "BREAK" }));
    // OBS's own while ours is still set (its end not reported yet) is OBS's own, not ours.
    await auto.switchProgram("Game", null);
    expect(obs.log).toEqual(["transition Stinger", "program Break by Stinger", "transition Überblendung", "program Game by Überblendung 300"]);
    await end();
    await end();
    expect(obs.current).toBe("Überblendung");
    // Already on program: no transition.
    obs.log.length = 0;
    await auto.switchProgram("Game", { name: "Stinger" });
    expect(obs.log).toEqual(["program Game by Überblendung 300"]);
  });

  it("puts back only after the last of quick changes, leaves a transition the operator chose in OBS meanwhile, and learns OBS's duration behind a Stinger", async () => {
    const { auto, obs, end } = transitionsRig();
    await auto.switchProgram("Replay", { name: "Stinger" });
    await auto.switchProgram("Replay B", { kind: "fade_transition", durationMs: 500 });
    // The Stinger's end comes while the fade runs: nothing is put back yet.
    await end();
    expect([obs.current, obs.duration]).toEqual(["Überblendung", 500]);
    await end();
    expect([obs.current, obs.duration]).toEqual(["Überblendung", 300]);
    // The operator picks Swipe in OBS during our Stinger: it stays.
    await auto.switchProgram("Game", { name: "Stinger" });
    obs.current = "Swipe";
    await end();
    expect(obs.current).toBe("Swipe");
    // OBS's own is a Stinger (no duration to read): it is read on the way to the Fade, and put back.
    const s = transitionsRig("Stinger");
    s.obs.duration = 700;
    await s.auto.switchProgram("Replay B", { kind: "fade_transition", durationMs: 400 });
    await s.end();
    expect([s.obs.current, s.obs.duration]).toEqual(["Stinger", 700]);
    expect(s.obs.log).toEqual(["transition Überblendung", "duration 400", "program Replay B by Überblendung 400", "duration 700", "transition Stinger"]);
  });

  it("keeps the replay transition chosen before 0.10.5 as Replay in, and changes the scene with OBS's own when a chosen transition is gone", async () => {
    const { auto, obs, settings, end } = transitionsRig();
    settings.set("obs.auto", { timeouts: true, mapEnd: true, replayTransition: "Stinger" });
    expect(auto.settings()).toMatchObject({ replayIn: "Stinger", replayOut: null, otherScenes: "" });
    auto.setSettings({ replayIn: "Deleted stinger" });
    expect(await auto.switchProgram("Replay", auto.pickFor({ from: "REPLAY_PREPARED", to: "REPLAY_PLAYING" }))).toBe(true);
    await end();
    expect(obs.log).toEqual(["warn OBS: the chosen transition isn't in OBS; using OBS's own", "program Replay by Überblendung 300"]);
  });
});
