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

  it("cuts replays with the chosen transition, then puts the previous one back", async () => {
    const { auto, transitions } = rig(SCENES);
    auto.setSettings({ replayTransition: "Stinger" });
    await auto.useReplayTransition();
    expect(transitions.current).toBe("Stinger");
    await auto.restoreAfterReplay();
    expect(transitions.current).toBe("Fade");
  });
});
