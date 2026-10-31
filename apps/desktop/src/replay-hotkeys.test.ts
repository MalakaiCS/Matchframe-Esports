import { describe, expect, it } from "vitest";
import { DEVICE_ACTION, ReplayHotkeys, SUGGESTED_REPLAY_KEYS, type ReplayKeyAction, type ReplayKeys } from "./replay-hotkeys.ts";

/** Electron's globalShortcut, stood in: keys another program holds can't be registered. */
function shortcuts(taken: string[] = []) {
  const held = new Map<string, () => void>();
  return {
    held,
    register: (accel: string, fn: () => void) => {
      if (taken.includes(accel) || held.has(accel)) return false;
      held.set(accel, fn);
      return true;
    },
    unregister: (accel: string) => void held.delete(accel),
    press: (accel: string) => held.get(accel)?.(),
  };
}

function make(opts: { taken?: string[]; saved?: Partial<ReplayKeys> } = {}) {
  const sc = shortcuts(opts.taken);
  const ran: ReplayKeyAction[] = [];
  const saved: ReplayKeys[] = [];
  const hk = new ReplayHotkeys({
    shortcuts: sc,
    reserved: () => [
      { accelerator: "CommandOrControl+Shift+F12", name: "emergency stop" },
      { accelerator: "CommandOrControl+Shift+H", name: "show or hide the desktop HUDs" },
    ],
    load: () => opts.saved ?? {},
    save: (k) => void saved.push(k),
    run: (a) => void ran.push(a),
    log: () => undefined,
  });
  return { hk, sc, ran, saved };
}

describe("Replay hotkeys (desktop, global)", () => {
  it("are off until set; the suggested keys run Skip, Hold and Stop and are saved", () => {
    const { hk, sc, ran, saved } = make();
    expect(hk.register()).toMatchObject({ keys: { skip: null, hold: null, stop: null, highlights: null, highlightsStop: null }, registered: { skip: false, hold: false, stop: false, highlights: false, highlightsStop: false } });
    expect(sc.held.size).toBe(0);
    const st = hk.set({ skip: SUGGESTED_REPLAY_KEYS.skip, hold: SUGGESTED_REPLAY_KEYS.hold, stop: SUGGESTED_REPLAY_KEYS.stop });
    expect(st.registered).toEqual({ skip: true, hold: true, stop: true, highlights: false, highlightsStop: false });
    expect(st.errors).toEqual({ skip: null, hold: null, stop: null, highlights: null, highlightsStop: null });
    expect(saved.at(-1)).toEqual({ skip: "CommandOrControl+Shift+F5", hold: "CommandOrControl+Shift+F6", stop: "CommandOrControl+Shift+F7", highlights: null, highlightsStop: null });
    sc.press("CommandOrControl+Shift+F5");
    sc.press("CommandOrControl+Shift+F6");
    sc.press("CommandOrControl+Shift+F7");
    expect(ran).toEqual(["skip", "hold", "stop"]);
    // One turned off: unregistered, the others stay.
    expect(hk.set({ hold: null }).registered).toEqual({ skip: true, hold: false, stop: true, highlights: false, highlightsStop: false });
    expect([...sc.held.keys()].sort()).toEqual(["CommandOrControl+Shift+F5", "CommandOrControl+Shift+F7"]);
  });

  it("says clearly when another program holds a key, and refuses one of the program's own or the same key twice", () => {
    const { hk, sc } = make({ taken: ["Alt+F5"] });
    hk.register();
    const st = hk.set({ skip: "Alt+F5", stop: "Ctrl+Alt+F7" });
    expect(st.registered).toEqual({ skip: false, hold: false, stop: true, highlights: false, highlightsStop: false });
    expect(st.errors.skip).toBe("Alt+F5 is already taken by another program (or Windows): choose another key for Skip.");
    expect(() => hk.set({ hold: "Ctrl+Shift+F12" })).toThrow("Ctrl+Shift+F12 is already the program's emergency stop hotkey: choose another key for Hold / Resume.");
    expect(() => hk.set({ hold: "control+alt+f7" })).toThrow("Hold / Resume and Stop and go live can't have the same key (Ctrl+Alt+F7).");
    expect(() => hk.set({ hold: "H" })).toThrow(/needs a modifier/);
    expect(() => hk.set({ hold: "Ctrl+Shift+Banana" })).toThrow(/does not end with a key/);
    // Nothing changed by a refused change.
    expect(hk.state().keys).toEqual({ skip: "Alt+F5", hold: null, stop: "Ctrl+Alt+F7", highlights: null, highlightsStop: null });
    expect([...sc.held.keys()]).toEqual(["Ctrl+Alt+F7"]);
  });

  it("registers the saved keys when the program starts, ignores a bad saved file, and lets go of them all", () => {
    const { hk, sc } = make({ saved: { skip: "Ctrl+Alt+S" } });
    expect(hk.register().registered.skip).toBe(true);
    hk.unregister();
    expect(sc.held.size).toBe(0);
    const bad = make({ saved: { skip: "nonsense" } as Partial<ReplayKeys> });
    expect(bad.hk.state().keys).toEqual({ skip: null, hold: null, stop: null, highlights: null, highlightsStop: null });
  });

  it("Play highlights and Stop highlights: off until set, the suggested Ctrl+Shift+F9 and F10 run highlights_play and highlights_stop", () => {
    const { hk, sc, ran } = make();
    hk.register();
    expect(hk.state().keys).toMatchObject({ highlights: null, highlightsStop: null });
    expect(SUGGESTED_REPLAY_KEYS).toMatchObject({ highlights: "CommandOrControl+Shift+F9", highlightsStop: "CommandOrControl+Shift+F10" });
    expect(DEVICE_ACTION).toMatchObject({ highlights: "highlights_play", highlightsStop: "highlights_stop" });
    const st = hk.set(SUGGESTED_REPLAY_KEYS);
    expect(st.registered).toEqual({ skip: true, hold: true, stop: true, highlights: true, highlightsStop: true });
    sc.press("CommandOrControl+Shift+F9");
    sc.press("CommandOrControl+Shift+F5");
    sc.press("CommandOrControl+Shift+F10");
    expect(ran).toEqual(["highlights", "skip", "highlightsStop"]);
    expect(() => hk.set({ highlightsStop: "CommandOrControl+Shift+F9" })).toThrow("Play highlights and Stop highlights can't have the same key (CommandOrControl+Shift+F9).");
    expect(() => hk.set({ highlights: "Ctrl+Shift+F12" })).toThrow("Ctrl+Shift+F12 is already the program's emergency stop hotkey: choose another key for Play highlights.");
  });
});
