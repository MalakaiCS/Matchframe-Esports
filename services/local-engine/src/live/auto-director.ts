import { z } from "zod";
import type { CameraRecord, MatchState, ObserverMode, PlayerState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";

/** What the Auto Director films, set from its card (stored in settings `autoDirector`). */
export const AutoDirectorSettings = z.object({
  /** Cinematic cameras: establishing shots and camera paths in freeze time, the bomb, big fights. */
  cinematic: z.boolean().default(true),
  /** Nade cameras (Full Action Observer, top plan). Includes the cinematic cameras. */
  nadeCams: z.boolean().default(false),
  /** After you pick a player yourself (in CS2 or here), the Auto Director takes over again after this long; 0 = only when you press Start. */
  returnAfterSec: z.number().int().min(0).max(120).default(8),
});
export type AutoDirectorSettings = z.infer<typeof AutoDirectorSettings>;

export type AutoCheckId = "console" | "data" | "account" | "pov" | "cameras" | "director";
export interface AutoCheck {
  id: AutoCheckId;
  label: string;
  status: "ok" | "wait" | "warn" | "fail" | "skip";
  detail: string;
}
export type AutoPhase = "off" | "starting" | "waiting" | "running" | "paused" | "error";

export interface AutoDirectorStatus {
  on: boolean;
  phase: AutoPhase;
  headline: string;
  settings: AutoDirectorSettings;
  observerMode: ObserverMode;
  checks: AutoCheck[];
  resumesInMs: number | null;
  startedAt: string | null;
}

const LABELS: Record<AutoCheckId, string> = {
  console: "CS2 console",
  data: "Game data",
  account: "Account",
  pov: "Player switching",
  cameras: "Cinematic cameras",
  director: "Auto Director",
};
const ORDER: AutoCheckId[] = ["console", "data", "account", "pov", "cameras", "director"];
const MODE_LABEL: Record<ObserverMode, string> = { off: "Off", observer: "Observer", observer_cinematics: "Observer & Cinematics", full_action: "Full Action Observer" };

/** Holders of a takeover the Auto Director made or that cleared up by themselves (not a person). */
const SELF_HOLDERS = new Set(["auto-director", "session-restart", "stale-telemetry-guard"]);
const RETRY_MS = 10_000;
const TICK_MS = 500;
/** Names `spec_player "<name>"` can't carry (same rule as the console adapter). */
const UNSAFE_NAME = /["';\\\n\r]/;

const usable = (support: string | undefined) => support === "supported" || support === "partial";

/**
 * One-button automatic direction. Start checks everything in order and fixes what it can by itself:
 * camera control over the CS2 console (chosen automatically when Matchframe started CS2), live game
 * data, the account gate, a real player switch (confirmed when the game data shows the player) and a
 * real camera (confirmed when getpos answers with the camera's position). Then it arms the director in
 * the richest Observer mode that works, and keeps it running: it takes the camera back a few seconds
 * after you pick a player yourself, and after the data recovers from a gap. Emergency stop, or
 * switching the Observer off, stops it.
 */
export class AutoDirector {
  private on = false;
  private phase: AutoPhase = "off";
  private readonly checks = new Map<AutoCheckId, AutoCheck>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private testing = false;
  private armedOnce = false;
  private povTriedAt = -Infinity;
  private camTried = false;
  private camWorks = false;
  private consolePrepared = false;
  private noNadeCams = false;
  /** Take over pressed: hold until the camera is handed back (Resume automation or Start). */
  private manualHold = false;
  private lastManualAt = -Infinity;
  private resumeAt: number | null = null;
  private startedAt: string | null = null;
  private haltReason: string | null = null;

  constructor(private readonly e: Engine) {
    e.session.on("arbiter", (ev: { kind: string; detail: Record<string, unknown> }) => {
      if (this.testing) return;
      if ((ev.kind === "command" && ev.detail.owner !== "director") || ev.kind === "external_change") this.lastManualAt = e.now();
    });
  }

  settings(): AutoDirectorSettings {
    const r = AutoDirectorSettings.safeParse(this.e.settings.get("autoDirector", {}));
    return r.success ? r.data : AutoDirectorSettings.parse({});
  }

  setSettings(patch: Partial<AutoDirectorSettings>): AutoDirectorSettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = AutoDirectorSettings.parse({ ...this.settings(), ...given });
    this.e.settings.set("autoDirector", next);
    if (this.on) void this.step();
    return next;
  }

  async start(patch?: Partial<AutoDirectorSettings>): Promise<AutoDirectorStatus> {
    if (patch) this.setSettings(patch);
    const s = this.e.session;
    if (s.arbiter.state().emergencyStopped) s.clearEmergencyStop();
    // A fresh start: holds and pins from earlier would keep the director on one shot.
    s.releaseHold();
    s.pin(null);
    s.setOneSide(null);
    this.on = true;
    this.phase = "starting";
    this.armedOnce = false;
    this.povTriedAt = -Infinity;
    this.camTried = false;
    this.camWorks = false;
    this.consolePrepared = false;
    this.noNadeCams = false;
    this.manualHold = false;
    this.resumeAt = null;
    this.haltReason = null;
    this.startedAt = new Date().toISOString();
    this.checks.clear();
    this.timer ??= setInterval(() => void this.step(), TICK_MS);
    await this.step();
    return this.status();
  }

  /** Stops automatic direction; the camera stays where it is. */
  stop(reason: string | null = null): AutoDirectorStatus {
    const s = this.e.session;
    const wasOn = this.on;
    this.on = false;
    this.phase = reason ? "error" : "off";
    this.haltReason = reason;
    this.resumeAt = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (wasOn) {
      if (s.observerMode !== "off") s.setObserverMode("off");
      if (s.arbiter.automationAllowed) s.takeover("auto-director");
    }
    return this.status();
  }

  /** Take over was pressed: the Auto Director keeps the camera off until it is handed back. */
  holdManual(): void {
    if (this.on) this.manualHold = true;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): AutoDirectorStatus {
    const checks = ORDER.map((id) => this.checks.get(id)).filter((c): c is AutoCheck => !!c);
    const waiting = checks.find((c) => c.status === "wait" || c.status === "fail");
    const now = this.e.now();
    const headline =
      this.phase === "off"
        ? "The Auto Director is off."
        : this.phase === "error"
          ? (this.haltReason ?? "The Auto Director stopped.")
          : this.phase === "running"
            ? `Directing the match: ${MODE_LABEL[this.e.session.observerMode]}.`
            : this.phase === "paused"
              ? this.resumeAt !== null
                ? `You have the camera: back to automatic in ${Math.max(1, Math.ceil((this.resumeAt - now) / 1000))} s.`
                : this.manualHold
                  ? "You took over. Press Resume automation or Start to hand the camera back."
                  : "You have the camera. Press Start to hand it back."
              : (waiting?.detail ?? "Starting…");
    return {
      on: this.on,
      phase: this.phase,
      headline,
      settings: this.settings(),
      observerMode: this.e.session.observerMode,
      checks,
      resumesInMs: this.phase === "paused" && this.resumeAt !== null ? Math.max(0, this.resumeAt - now) : null,
      startedAt: this.startedAt,
    };
  }

  // ------------------------------------------------------------------------------------------

  private set(id: AutoCheckId, status: AutoCheck["status"], detail: string): void {
    this.checks.set(id, { id, label: LABELS[id], status, detail });
  }

  private async step(): Promise<void> {
    if (!this.on || this.busy) return;
    this.busy = true;
    try {
      await this.advance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.e.logger.warn("auto director step failed", { error: msg });
      this.set("director", "fail", msg);
      this.stop(msg);
    } finally {
      this.busy = false;
    }
  }

  private async advance(): Promise<void> {
    const s = this.e.session;
    if (this.armedOnce) {
      if (s.arbiter.state().emergencyStopped) {
        this.stop("Emergency stop: the Auto Director stopped. Press Start to run it again.");
        return;
      }
      if (s.observerMode === "off") {
        // Switched off from Live Control, or the hours ran out at a map change.
        this.stop(s.arbiter.state().holder === "auto-director-allowance" ? "Automatic direction stopped at the map change: no auto-director hours left (see Account & Hours)." : null);
        return;
      }
    }
    const sim = this.e.simulationRunning;
    if (!(await this.checkConsole(sim))) return this.waiting();
    const state = s.state();
    if (!state || !this.checkData(state, sim)) return this.waiting();

    const st = this.settings();
    let mode: Exclude<ObserverMode, "off"> = st.nadeCams ? "full_action" : st.cinematic ? "observer_cinematics" : "observer";
    if (mode === "full_action" && this.noNadeCams) mode = "observer_cinematics";
    // The account is checked before the first arm only: a match that is running is never cut off.
    if (!this.armedOnce) {
      let gate = s.gateFor(mode);
      if (!gate.ok && mode === "full_action" && gate.code === "plan_excludes") {
        mode = "observer_cinematics";
        this.noNadeCams = true;
        gate = s.gateFor(mode);
        if (gate.ok) this.set("account", "warn", "Nade cameras come with the top plan, so the Auto Director films with cinematic cameras and POVs.");
      } else if (gate.ok) this.set("account", "ok", sim ? "Simulation: no hours used." : "Signed in, with auto-director hours.");
      if (!gate.ok) {
        this.set("account", "fail", gate.reason);
        this.stop(gate.reason);
        return;
      }
    }

    if (!(await this.checkPov(state, sim))) return this.waiting();
    const camerasOk = mode !== "observer" && (await this.checkCameras(state));
    if (mode === "observer") this.set("cameras", "skip", "Off: the Auto Director switches between players only.");
    if (!camerasOk) mode = "observer";
    this.drive(mode, st);
  }

  private waiting(): void {
    if (this.phase !== "running" && this.phase !== "paused") this.phase = "waiting";
  }

  /** Camera control: the console of the CS2 that Matchframe started, chosen automatically. */
  private async checkConsole(sim: boolean): Promise<boolean> {
    const e = this.e;
    if (sim) {
      this.set("console", "ok", "Simulation: the camera moves in the simulated game.");
      return true;
    }
    const adapter = e.observerSettings();
    if (adapter.kind === "keyboard") {
      this.set("console", "ok", "Keyboard control: number keys in the CS2 window (no free cameras).");
      return true;
    }
    const gc = e.gameConsole;
    const profile = gc.profile();
    if (profile.mode === "standard") {
      // The console comes from the -tools -netconport launch options.
      gc.setProfile({ ...profile, mode: "tools" });
      this.set("console", "wait", "CS2 needs its console for the Auto Director. Close CS2 and press Start CS2: Matchframe now starts it in Tools mode.");
      return false;
    }
    const conn = gc.connection;
    if (!conn || conn.status !== "connected") {
      this.set("console", "wait", `Waiting for the CS2 console on port ${profile.netconPort}. Start CS2 with Start CS2 (Tools mode).`);
      return false;
    }
    if (adapter.kind !== "netcon" || adapter.port !== conn.port || !["127.0.0.1", "localhost"].includes(adapter.host)) {
      e.settings.set("observer.adapter", { ...adapter, kind: "netcon", host: "127.0.0.1", port: conn.port });
      await e.applyObserverAdapter();
      e.audit.record("auto-director", "observer.adapter_selected", "netcon", { port: conn.port });
    }
    if (!this.consolePrepared) {
      this.consolePrepared = true;
      // The game's own auto director would fight Matchframe's cuts (and read as you taking over).
      await conn.write("spec_autodirector 0").catch(() => undefined);
    }
    this.set("console", "ok", `Connected on port ${conn.port}.`);
    return true;
  }

  private checkData(state: MatchState, sim: boolean): boolean {
    if (state.sequence === 0) {
      this.set("data", "wait", "Waiting for game data from CS2. Spectate a match, watch GOTV or play a demo.");
      return false;
    }
    if (state.sources[0]?.stale) {
      this.set("data", "wait", "Game data stopped arriving. Is CS2 still running and spectating?");
      return false;
    }
    if (!state.mapName) {
      this.set("data", "wait", "Waiting for CS2 to load a map.");
      return false;
    }
    this.set("data", "ok", `${sim ? "Simulated" : "Live"} on ${state.mapName}, ${state.players.length} players.`);
    return true;
  }

  /** Player switching: confirmed once on this CS2 build, by switching to a player and seeing it in the game data. */
  private async checkPov(state: MatchState, sim: boolean): Promise<boolean> {
    const s = this.e.session;
    if (usable(s.capabilities().playerSelectionControl.support)) {
      this.set("pov", "ok", sim ? "Simulated." : "Works on this CS2 build.");
      return true;
    }
    if (this.e.now() - this.povTriedAt < RETRY_MS) return false;
    this.povTriedAt = this.e.now();
    const target = this.testTarget(state);
    if (!target) {
      this.set("pov", "wait", "Waiting for a player to switch to (alive, with a name CS2 can select).");
      return false;
    }
    this.set("pov", "wait", `Testing: switching CS2 to ${target.name}…`);
    this.testing = true;
    try {
      await s.manualSelectPlayer(target.steamId, "auto-director");
      const ok = await this.waitFor(() => s.state()?.observer.observedSteamId === target.steamId, 3500);
      if (ok) {
        this.e.recordControlEvidence("playerSelectionControl", "supported", `the Auto Director switched to ${target.name} and the game data showed it`);
        await s.refreshControlCapabilities();
        this.set("pov", "ok", `Works on this CS2 build (switched to ${target.name}).`);
        return true;
      }
    } finally {
      this.testing = false;
    }
    this.set("pov", "wait", `CS2 didn't switch to ${target.name}. Make sure CS2 is spectating (GOTV, a demo or a spectator slot), not playing. Trying again in 10 s.`);
    return false;
  }

  /** Cinematic cameras: confirmed once, by showing a camera and asking the game where the camera is (getpos). */
  private async checkCameras(state: MatchState): Promise<boolean> {
    const s = this.e.session;
    const cams = this.camerasFor(state.mapName);
    if (!cams.length) {
      this.set("cameras", "warn", `No cameras for ${state.mapName}: the Auto Director follows players. Add cameras in Maps & Cameras.`);
      return false;
    }
    if (usable(s.capabilities().staticCameraControl.support)) {
      this.set("cameras", "ok", `${cams.length} cameras and ${this.e.maps.get(state.mapName ?? "")?.pathsFor().length ?? 0} camera paths on ${state.mapName}.`);
      return true;
    }
    if (this.e.observerSettings().kind === "keyboard" && !this.e.simulationRunning) {
      this.set("cameras", "skip", "Keyboard control can't place a free camera: the Auto Director follows players.");
      return false;
    }
    if (this.camTried) return this.camWorks;
    this.camTried = true;
    const cam = cams.find((c) => c.actionClasses.includes("establishing")) ?? cams[0]!;
    const back = state.observer.observedSteamId;
    this.set("cameras", "wait", `Testing: showing the camera ${cam.displayName}…`);
    this.testing = true;
    try {
      let ok = await this.showCamera(cam);
      if (!ok) {
        // Demo playback after the 2026-10-15 CS2 update ignores spec_goto's position unless the demo free camera is off.
        await this.e.gameConsole.connection?.write("cl_demo_freecam 0").catch(() => undefined);
        ok = await this.showCamera(cam);
      }
      if (back) {
        // Back on the player (this also lets the console adapter learn the in-eye numbering).
        await s.manualSelectPlayer(back, "auto-director").catch(() => undefined);
        await this.waitFor(() => s.state()?.observer.observedSteamId === back, 3500);
      }
      this.camWorks = ok;
    } finally {
      this.testing = false;
    }
    if (this.camWorks) {
      this.set("cameras", "ok", `Works on this CS2 build. ${cams.length} cameras on ${state.mapName}.`);
      return true;
    }
    this.set("cameras", "warn", "CS2 didn't report the camera's position (getpos), so cinematic cameras stay off and the Auto Director follows players. Check that CS2 runs with -tools (Start CS2, Tools mode), then press Start again.");
    return false;
  }

  private async showCamera(cam: CameraRecord): Promise<boolean> {
    const s = this.e.session;
    const r = await s.manualCamera(cam.id, "auto-director", 2500);
    if (r.status !== "confirmed" || r.precision !== "observed_exact") return false;
    await s.refreshControlCapabilities();
    return usable(s.capabilities().staticCameraControl.support);
  }

  /** Arms the director, keeps the mode in line with what works, and takes the camera back after you. */
  private drive(mode: Exclude<ObserverMode, "off">, st: AutoDirectorSettings): void {
    const s = this.e.session;
    const label = MODE_LABEL[mode];
    if (!this.armedOnce) {
      s.armAutomatic(mode);
      this.armedOnce = true;
      this.phase = "running";
      this.e.audit.record("auto-director", "director.auto_start", mode, { checks: [...this.checks.values()] });
      this.set("director", "ok", `${label}: Matchframe moves the camera.`);
      return;
    }
    if (s.observerMode !== mode) {
      try {
        s.setObserverMode(mode);
      } catch {
        // Not allowed now (e.g. the plan changed): keep the mode that is running.
      }
    }
    if (s.arbiter.automationAllowed) {
      this.phase = "running";
      this.resumeAt = null;
      this.manualHold = false;
      this.set("director", "ok", `${label}: Matchframe moves the camera.`);
      return;
    }
    if (s.arbiter.resumePendingInMs() !== null) return;
    const own = s.arbiter.state();
    const now = this.e.now();
    const since = Math.max(this.lastManualAt, own.acquiredAtMonotonicMs);
    const backAt = st.returnAfterSec > 0 && !this.manualHold ? since + st.returnAfterSec * 1000 : null;
    if (!this.manualHold && (SELF_HOLDERS.has(own.holder ?? "") || (backAt !== null && now >= backAt))) {
      // Admitted at Start: taking the camera back is not a new arm.
      s.arbiter.resumeAutomation(0);
      this.phase = "running";
      this.resumeAt = null;
      this.set("director", "ok", `${label}: Matchframe moves the camera.`);
      return;
    }
    this.phase = "paused";
    this.resumeAt = backAt;
    this.set("director", "wait", backAt !== null ? "You picked the camera: the Auto Director takes it back shortly." : this.manualHold ? "You took over. Press Resume automation or Start to hand the camera back." : "You picked the camera. Press Start to hand it back.");
  }

  /** An alive player who isn't spectated now and whose name CS2 can select. */
  private testTarget(state: MatchState): PlayerState | null {
    const keyboard = this.e.observerSettings().kind === "keyboard";
    const ok = (p: PlayerState) =>
      (p.health ?? 0) > 0 &&
      p.steamId !== state.observer.observedSteamId &&
      (keyboard ? p.observerSlot !== null : !!this.e.playerNameFor(p.steamId) && !UNSAFE_NAME.test(p.name));
    return [...state.players].sort((a, b) => (a.observerSlot ?? 99) - (b.observerSlot ?? 99)).find(ok) ?? null;
  }

  private camerasFor(mapName: string | null): CameraRecord[] {
    const rt = mapName ? this.e.maps.get(mapName) : undefined;
    return rt ? rt.pack.cameras.filter((c) => rt.cameraUsable(c)) : [];
  }

  private async waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const end = this.e.now() + ms;
    while (!pred()) {
      if (this.e.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }
}
