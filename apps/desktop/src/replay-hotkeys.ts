import { acceleratorArg, acceleratorKey } from "./hud/validate.ts";

/**
 * Global hotkeys for the replays playing (ADR-062): Skip the clip on air, Hold or Resume it, Stop and
 * go live, from any program (CS2 or OBS in front). Off until the operator sets them (in the console:
 * Replays & Production → Automatic replays → Hotkeys), as a global hotkey takes its keys from every
 * program; the suggested ones (Ctrl+Shift+F5, F6, F7) aren't used by CS2 or OBS by default. A key
 * another program (or Windows) holds isn't registered and says so; the program's own hotkeys are
 * refused. Pressed, a hotkey runs the engine's control-surface action (replay_skip, replay_hold,
 * replay_stop), the same as a Stream Deck button.
 *
 * Highlights on air (ADR-063): Play highlights and Stop highlights (highlights_play, highlights_stop;
 * suggested Ctrl+Shift+F9 and F10), also off until set. Skip and Hold are the replays' keys.
 */

export const REPLAY_KEY_ACTIONS = ["skip", "hold", "stop", "highlights", "highlightsStop"] as const;
export type ReplayKeyAction = (typeof REPLAY_KEY_ACTIONS)[number];
export type ReplayKeys = Record<ReplayKeyAction, string | null>;

export const SUGGESTED_REPLAY_KEYS: Record<ReplayKeyAction, string> = { skip: "CommandOrControl+Shift+F5", hold: "CommandOrControl+Shift+F6", stop: "CommandOrControl+Shift+F7", highlights: "CommandOrControl+Shift+F9", highlightsStop: "CommandOrControl+Shift+F10" };
const NAMES: Record<ReplayKeyAction, string> = { skip: "Skip", hold: "Hold / Resume", stop: "Stop and go live", highlights: "Play highlights", highlightsStop: "Stop highlights" };
/** The engine's control-surface action each hotkey runs. */
export const DEVICE_ACTION: Record<ReplayKeyAction, string> = { skip: "replay_skip", hold: "replay_hold", stop: "replay_stop", highlights: "highlights_play", highlightsStop: "highlights_stop" };
/** The highlights' hotkeys (their notifications say Highlights). */
export const HIGHLIGHT_KEY_ACTIONS: readonly ReplayKeyAction[] = ["highlights", "highlightsStop"];

export interface ReplayKeysState {
  keys: ReplayKeys;
  /** Registered with the system now. */
  registered: Record<ReplayKeyAction, boolean>;
  /** Why one isn't (another program holds it, …). */
  errors: Record<ReplayKeyAction, string | null>;
  suggested: Record<ReplayKeyAction, string>;
}

/** The part of Electron's globalShortcut used. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

const none = <T>(v: T): Record<ReplayKeyAction, T> => ({ skip: v, hold: v, stop: v, highlights: v, highlightsStop: v });

/** For comparing two keys: CommandOrControl is Ctrl on Windows and Linux, Cmd on a Mac. */
const keyOf = (accel: string, platform: string = process.platform) => acceleratorKey(accel.replace(/\b(CommandOrControl|CmdOrCtrl)\b/gi, platform === "darwin" ? "Command" : "Control"));

/** A saved or requested set of keys, checked (null: off). */
export function replayKeysArg(v: unknown): Partial<ReplayKeys> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The replay hotkeys must be an object.");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(REPLAY_KEY_ACTIONS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`Unexpected replay hotkey: ${extra.join(", ")}.`);
  const out: Partial<ReplayKeys> = {};
  for (const a of REPLAY_KEY_ACTIONS) if (o[a] !== undefined) out[a] = o[a] === null || o[a] === "" ? null : acceleratorArg(o[a], NAMES[a]);
  return out;
}

export class ReplayHotkeys {
  private keys: ReplayKeys;
  private registered = none(false);
  private errors = none<string | null>(null);
  private active = false;

  constructor(
    private readonly d: {
      shortcuts: ShortcutRegistry;
      /** The program's other hotkeys (emergency stop, save the CS2 view, the desktop HUDs'), with what they do. */
      reserved: () => { accelerator: string; name: string }[];
      load(): Partial<ReplayKeys>;
      save(keys: ReplayKeys): void;
      run(action: ReplayKeyAction): void;
      log(msg: string): void;
    },
  ) {
    let saved: Partial<ReplayKeys> = {};
    try {
      saved = replayKeysArg(d.load() ?? {});
    } catch (e) {
      d.log(`replay hotkeys: saved keys ignored (${e instanceof Error ? e.message : String(e)})`);
    }
    this.keys = { ...none<string | null>(null), ...saved };
  }

  state(): ReplayKeysState {
    return { keys: { ...this.keys }, registered: { ...this.registered }, errors: { ...this.errors }, suggested: { ...SUGGESTED_REPLAY_KEYS } };
  }

  /** Registers the keys set (when the program starts). */
  register(): ReplayKeysState {
    this.active = true;
    for (const a of REPLAY_KEY_ACTIONS) this.registerOne(a);
    return this.state();
  }

  unregister(): void {
    this.active = false;
    for (const a of REPLAY_KEY_ACTIONS) this.unregisterOne(a);
  }

  /**
   * Changes keys (null: off) and registers them. Refuses two the same, or one of the program's own;
   * one another program holds is saved but reported as not registered (errors).
   */
  set(patch: unknown): ReplayKeysState {
    const next = { ...this.keys, ...replayKeysArg(patch) };
    const seen = new Map<string, ReplayKeyAction>();
    for (const a of REPLAY_KEY_ACTIONS) {
      const k = next[a];
      if (!k) continue;
      const key = keyOf(k);
      const twin = seen.get(key);
      if (twin) throw new Error(`${NAMES[twin]} and ${NAMES[a]} can't have the same key (${k}).`);
      seen.set(key, a);
      const own = this.d.reserved().find((r) => keyOf(r.accelerator) === key);
      if (own) throw new Error(`${k} is already the program's ${own.name} hotkey: choose another key for ${NAMES[a]}.`);
    }
    const wasActive = this.active;
    if (wasActive) this.unregister();
    this.keys = next;
    this.errors = none(null);
    this.d.save(next);
    return wasActive ? this.register() : this.state();
  }

  private registerOne(a: ReplayKeyAction): void {
    this.unregisterOne(a);
    this.errors[a] = null;
    const k = this.keys[a];
    if (!k) return;
    let ok = false;
    try {
      ok = this.d.shortcuts.register(k, () => this.d.run(a));
    } catch (e) {
      this.errors[a] = `${k} isn't a key Windows can use as a hotkey (${e instanceof Error ? e.message : String(e)}).`;
    }
    if (!ok && !this.errors[a]) this.errors[a] = `${k} is already taken by another program (or Windows): choose another key for ${NAMES[a]}.`;
    if (!ok) this.d.log(`replay hotkeys: ${this.errors[a]}`);
    this.registered[a] = ok;
  }

  private unregisterOne(a: ReplayKeyAction): void {
    const k = this.keys[a];
    if (!this.registered[a] || !k) return;
    try {
      this.d.shortcuts.unregister(k);
    } catch {
      // Already gone.
    }
    this.registered[a] = false;
  }
}
