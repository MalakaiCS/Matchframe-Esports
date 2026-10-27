import { globalShortcut } from "electron";
import type { OverlayStore } from "./store.ts";
import type { HotkeyConfig, HotkeyState } from "./types.ts";
import { acceleratorArg, acceleratorKey } from "./validate.ts";

/**
 * Global HUD hotkeys: toggle the desktop overlays and the emergency hide of all HUD graphics. They are
 * configurable and saved with the overlay settings; a hotkey another program already holds is
 * reported as not registered (never silently ignored). The program's emergency-stop hotkey is
 * registered separately in main.ts and is never touched here.
 */
export class HotkeyManager {
  private config: HotkeyConfig;
  private registered = { toggle: false, emergencyHide: false };
  private active = false;
  emergencyHidden = false;

  constructor(
    private readonly d: {
      store: OverlayStore;
      /** Accelerators the program uses for something else (the emergency stop). */
      reserved: string[];
      onToggle(): void;
      onEmergencyHide(): void;
      log(msg: string): void;
    },
  ) {
    this.config = d.store.hotkeys();
  }

  state(): HotkeyState {
    return { ...this.config, registered: { ...this.registered }, emergencyHidden: this.emergencyHidden };
  }

  /** Registers both hotkeys (local mode). */
  register(): HotkeyState {
    this.active = true;
    this.registerOne("toggle", () => this.d.onToggle());
    this.registerOne("emergencyHide", () => this.d.onEmergencyHide());
    return this.state();
  }

  unregister(): void {
    this.active = false;
    for (const name of ["toggle", "emergencyHide"] as const) this.unregisterOne(name);
  }

  /** Changes hotkeys (validated by the caller's patch check) and re-registers them. */
  set(patch: Partial<HotkeyConfig>): HotkeyState {
    const next = { ...this.config, ...patch };
    next.toggle = acceleratorArg(next.toggle, "toggle");
    next.emergencyHide = acceleratorArg(next.emergencyHide, "emergency hide");
    if (acceleratorKey(next.toggle) === acceleratorKey(next.emergencyHide)) throw new Error("The toggle and emergency hide hotkeys must be different.");
    for (const r of this.d.reserved) {
      for (const [name, accel] of [["toggle", next.toggle], ["emergency hide", next.emergencyHide]] as const) {
        if (acceleratorKey(accel) === acceleratorKey(r)) throw new Error(`The ${name} hotkey ${accel} is already the program's emergency stop.`);
      }
    }
    const wasActive = this.active;
    if (wasActive) this.unregister();
    this.config = next;
    this.d.store.setHotkeys(next);
    return wasActive ? this.register() : this.state();
  }

  private registerOne(name: "toggle" | "emergencyHide", fn: () => void): void {
    this.unregisterOne(name);
    const accel = this.config[name];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch (e) {
      this.d.log(`hotkey ${accel} is not valid: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok) this.d.log(`could not register the ${name} hotkey ${accel} (another program may use it)`);
    this.registered[name] = ok;
  }

  private unregisterOne(name: "toggle" | "emergencyHide"): void {
    if (!this.registered[name]) return;
    try {
      globalShortcut.unregister(this.config[name]);
    } catch {
      // Already gone.
    }
    this.registered[name] = false;
  }
}
