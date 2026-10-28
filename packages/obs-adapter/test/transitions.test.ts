import { describe, expect, it } from "vitest";
import type { ObsClientLike } from "../src/obs.ts";
import { ObsManager } from "../src/obs.ts";

/**
 * A stand-in OBS whose transition switch takes effect a moment later, like the real one (a request
 * straight after SetCurrentSceneTransition can still see the old transition).
 */
function lateObs(lag = 3) {
  const transitions: Record<string, Record<string, unknown>> = { Fade: { duration: 300 }, "Matchframe Stinger": {} };
  let current = "Fade";
  let pending: { name: string; reads: number } | null = null;
  const client = {
    on: () => undefined,
    off: () => undefined,
    connect: async () => ({}),
    disconnect: async () => undefined,
    call: async (req: string, data: Record<string, unknown> = {}) => {
      if (req === "SetCurrentSceneTransition") pending = { name: String(data.transitionName), reads: lag };
      if (req === "GetCurrentSceneTransition") {
        if (pending && --pending.reads <= 0) {
          current = pending.name;
          pending = null;
        }
        return { transitionName: current, transitionSettings: { ...transitions[current] } };
      }
      // Settings go to whatever OBS has as current at that moment.
      if (req === "SetCurrentSceneTransitionSettings") Object.assign(transitions[current]!, data.transitionSettings as object);
      return {};
    },
  } as unknown as ObsClientLike;
  const obs = new ObsManager(client);
  obs.state.connected = true;
  return { obs, transitions, current: () => current };
}

describe("OBS transitions", () => {
  it("waits for OBS to really switch before changing a transition's settings, then switches back", async () => {
    const o = lateObs();
    const r = await o.obs.setTransitionSettings("Matchframe Stinger", { path: "C:/mf/stinger.mov", transition_point: 900 });
    expect(r.confirmed).toBe(true);
    expect(o.transitions["Matchframe Stinger"]).toEqual({ path: "C:/mf/stinger.mov", transition_point: 900 });
    // The transition that was current is untouched, and current again.
    expect(o.transitions.Fade).toEqual({ duration: 300 });
    expect(o.current()).toBe("Fade");
  });

  it("keeps the new transition current when asked", async () => {
    const o = lateObs();
    await o.obs.setTransitionSettings("Matchframe Stinger", { path: "x.mov" }, { keepCurrent: true });
    expect(o.current()).toBe("Matchframe Stinger");
  });

  it("confirms a switch only when OBS reports it, and changes nothing if it never does", async () => {
    expect(await lateObs(2).obs.setTransition("Matchframe Stinger")).toBe(true);
    const never = lateObs(1_000_000);
    expect(await never.obs.setTransition("Matchframe Stinger", 100)).toBe(false);
    await expect(never.obs.setTransitionSettings("Matchframe Stinger", { path: "x.mov" })).rejects.toThrow(/didn't switch/);
    expect(never.transitions.Fade).toEqual({ duration: 300 });
  });
});
