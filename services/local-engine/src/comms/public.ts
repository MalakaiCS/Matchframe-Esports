import { z } from "zod";
import type { ObsManager } from "@matchframe/obs-adapter";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { ListenInController, type ListenInView } from "./controller.ts";
import { CommsDucking, type ReplayDuckLike } from "./ducking.ts";
import { CommsOutputs, PUBLIC_NDI_NAME, RECORDING_NDI_NAME, type NdiWorkerLike } from "./outputs.ts";
import { CommsOverlay, OVERLAY_SOURCE } from "./overlay.ts";
import { patchOf, type TeamComms } from "./service.ts";
import { STRIP_SOURCE } from "./strip.ts";

/**
 * Team Comms on air (ADR-066, phase 3): the public listen-in's controller, the outputs (NDI senders,
 * the public silence guard, the operator's preview), caster ducking and the team-only overlay,
 * kept in step: a listen-in that opens turns the casters down and shows the banner; whatever closes
 * it (End Listen-In, Mute All Comms, a fault) hides the banner and puts the casters back.
 *
 * Saved (engine settings, `comms.public`): the NDI output's settings, caster ducking, the banner's
 * placement. Never saved: the listen-in (closed at every start).
 */

export const NdiOutputSettings = z.object({
  enabled: z.boolean().default(true),
  /** How long after its own time each block goes out (room for the engine's jitter). */
  latencyMs: z.number().int().min(20).max(500).default(60),
  /** Let NDI clock the sends (off: paced on the engine's clock, which kept the latency constant where NDI's clock ran slow). */
  clockAudio: z.boolean().default(false),
});
export const DuckSettings = z.object({
  enabled: z.boolean().default(false),
  inputs: z.array(z.string().min(1).max(200)).max(16).default([]),
  amountDb: z.number().min(-40).max(0).default(-10),
  rampMs: z.number().int().min(0).max(3000).default(300),
});
export const OverlaySettings = z.object({
  anchor: z.enum(["top", "bottom"]).default("top"),
  offsetPx: z.number().int().min(0).max(1000).default(140),
});
export const CommsPublicSettings = z.object({
  ndi: NdiOutputSettings.prefault({}),
  duck: DuckSettings.prefault({}),
  overlay: OverlaySettings.prefault({}),
});
export type CommsPublicSettings = z.infer<typeof CommsPublicSettings>;
export const CommsPublicPatch = z.object({ ndi: patchOf(NdiOutputSettings).optional(), duck: patchOf(DuckSettings).optional(), overlay: patchOf(OverlaySettings).optional() });

const SETTINGS_KEY = "comms.public";
/** OBS input kinds that capture everything the computer plays (OBS's Desktop Audio). */
const DESKTOP_KINDS = new Set(["wasapi_output_capture", "pulse_output_capture", "coreaudio_output_capture", "sck_audio_capture"]);
/** DistroAV's NDI source. */
const NDI_KIND = "ndi_source";

export interface RoutingCheck {
  id: string;
  /** true: fine; false: wrong (fix it); null: couldn't tell. */
  ok: boolean | null;
  title: string;
  detail: string;
}

export interface CommsPublicDeps {
  comms: TeamComms;
  settings: SettingsRepo;
  logger: Pick<Logger, "info" | "warn">;
  obs: ObsManager;
  now: () => number;
  overlayPort: () => number;
  liveScene: () => string | null;
  replayDuck: () => ReplayDuckLike | null;
  spawnNdiWorker?: () => NdiWorkerLike;
  /** Wall time of a timeline sample (the engine's timeline is performance.now()). */
  wallOf?: (startSample: number) => number;
}

export class CommsPublic {
  readonly controller: ListenInController;
  readonly outputs: CommsOutputs;
  readonly ducking: CommsDucking;
  readonly overlay: CommsOverlay;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasOpen = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly d: CommsPublicDeps) {
    this.outputs = new CommsOutputs({ comms: d.comms, logger: d.logger, settings: () => this.settings().ndi, spawnWorker: d.spawnNdiWorker, wallOf: d.wallOf, onFault: (reason) => this.controller?.fault(reason) });
    this.controller = new ListenInController({ comms: d.comms, logger: d.logger, outputProblem: () => this.outputs.problem(), outputFailed: () => this.outputs.failed });
    this.ducking = new CommsDucking({ obs: d.obs, settings: d.settings, logger: d.logger, replay: d.replayDuck, config: () => this.settings().duck, now: d.now });
    this.overlay = new CommsOverlay({ settings: d.settings, obs: d.obs, overlayPort: d.overlayPort, liveScene: d.liveScene, placement: () => this.settings().overlay });
    this.offs.push(this.controller.onChange((v) => this.onChange(v)));
  }

  settings(): CommsPublicSettings {
    const r = CommsPublicSettings.safeParse(this.d.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : CommsPublicSettings.parse({});
  }

  setSettings(patch: z.infer<typeof CommsPublicPatch>): CommsPublicSettings {
    const prev = this.settings();
    const strip = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
    const next = CommsPublicSettings.parse({ ndi: { ...prev.ndi, ...strip(patch.ndi) }, duck: { ...prev.duck, ...strip(patch.duck) }, overlay: { ...prev.overlay, ...strip(patch.overlay) } });
    this.d.settings.set(SETTINGS_KEY, next);
    if (next.ndi.latencyMs !== prev.ndi.latencyMs || next.ndi.clockAudio !== prev.ndi.clockAudio) this.outputs.restart();
    else this.outputs.sync();
    this.overlay.set(this.controller.onAir);
    return next;
  }

  start(): void {
    this.ducking.start();
    this.outputs.sync();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref?.();
  }

  /** Team Comms switched on or off, settings changed: the NDI process follows. */
  sync(): void {
    this.outputs.sync();
  }

  private tick(): void {
    this.outputs.sync();
    this.ducking.retry();
  }

  private onChange(v: ListenInView): void {
    this.overlay.set(this.controller.onAir);
    const open = this.controller.open;
    if (open && !this.wasOpen) void this.ducking.duck();
    else if (!open && this.wasOpen) void this.ducking.release(v.state === "fault" ? "the listen-in closed by a fault" : v.muted ? "Mute All Comms" : "End Listen-In");
    this.wasOpen = open;
  }

  /** As the engine stops: casters put back while OBS is still there. */
  async beforeShutdown(): Promise<void> {
    if (!this.ducking.lowered) return;
    await Promise.race([this.ducking.release("the engine is stopping"), new Promise((r) => setTimeout(r, 2000))]);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
    this.controller.dispose();
    this.outputs.stop();
    this.ducking.dispose();
    this.overlay.close();
  }

  status() {
    return {
      listenIn: this.controller.view(),
      settings: this.settings(),
      outputs: this.outputs.status(),
      ducking: this.ducking.status(),
      overlay: this.overlay.status(),
    };
  }

  /** For the support file: the overlay's address without its token. */
  diagnostics() {
    const st = this.status();
    return { ...st, overlay: { ...st.overlay, url: st.overlay.url.replace(/t=[^&]+/, "t=[redacted]") } };
  }

  /** OBS's audio inputs, for picking the casters (MatchFrame's own comms sources are never offered). */
  async obsInputs(): Promise<{ inputs: { name: string; kind: string; db: number; muted: boolean; picked: boolean }[]; error: string | null }> {
    if (!this.d.obs.state.connected) return { inputs: [], error: "OBS isn't connected (Settings → Devices)." };
    try {
      const picked = new Set(this.settings().duck.inputs);
      const list = await this.d.obs.audioInputs();
      return { error: null, inputs: list.filter((i) => i.kind !== NDI_KIND || !/matchframe comms/i.test(i.name)).map((i) => ({ name: i.name, kind: i.kind, db: Math.round(i.db * 10) / 10, muted: i.muted, picked: picked.has(i.name) })) };
    } catch (err) {
      return { inputs: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The OBS side of the routing, checked from OBS's own lists (docs/operations/team-comms.md has the
   * listening tests these can't replace): Desktop Audio off, the public comms source in the live
   * scene and not monitored to the desktop, the recording comms source kept off the live scene, no
   * capture of TeamSpeak itself, the caster inputs present.
   */
  async obsCheck(): Promise<{ connected: boolean; checks: RoutingCheck[] }> {
    const obs = this.d.obs;
    if (!obs.state.connected) return { connected: false, checks: [{ id: "obs", ok: false, title: "OBS connected", detail: "Connect OBS first (Settings → Devices)." }] };
    const checks: RoutingCheck[] = [];
    await obs.refresh().catch(() => undefined);
    const inputs = obs.state.inputs;
    const live = this.d.liveScene();
    const liveItems = live ? await obs.sceneItems(live).catch(() => null) : null;
    const inLive = (name: string) => !!liveItems?.some((i) => i.sourceName === name);
    // Desktop Audio.
    const desktop = inputs.filter((i) => DESKTOP_KINDS.has(i.kind));
    const desktopOn: string[] = [];
    for (const i of desktop) {
      const v = await obs.inputVolume(i.name).catch(() => null);
      if (v && !v.muted && v.mul > 0) desktopOn.push(i.name);
    }
    checks.push({ id: "desktop-audio", ok: desktopOn.length === 0, title: "Desktop Audio off", detail: desktopOn.length ? `Capturing everything this computer plays: ${desktopOn.join(", ")}. That can put TeamSpeak's sound, the operator's preview or a second copy of the comms on air. Settings → Audio → Global Audio Devices → Desktop Audio: Disabled (game audio as its own Application Audio Capture of CS2).` : "No desktop capture is on." });
    // NDI sources.
    const ndi: { name: string; source: string; monitor: string | null }[] = [];
    for (const i of inputs.filter((x) => x.kind === NDI_KIND)) {
      const s = await obs.inputSettings(i.name).catch(() => null);
      const source = String(s?.settings.ndi_source_name ?? "");
      const audio = await obs.inputAudio(i.name).catch(() => null);
      ndi.push({ name: i.name, source, monitor: audio?.monitorType ?? null });
    }
    const pub = ndi.filter((n) => n.source.includes(`(${PUBLIC_NDI_NAME})`));
    const rec = ndi.filter((n) => n.source.includes(`(${RECORDING_NDI_NAME})`));
    checks.push({
      id: "public-source",
      ok: !!live && pub.length === 1 && inLive(pub[0]!.name),
      title: `“${PUBLIC_NDI_NAME}” in the live scene`,
      detail: !live
        ? "Map the live scene first (Settings → Setup → OBS scenes)."
        : pub.length === 0
          ? `No DistroAV NDI source receives “${PUBLIC_NDI_NAME}”. In the live scene: Add → NDI™ Source → source “<this computer> (${PUBLIC_NDI_NAME})”, bandwidth Audio only.`
          : pub.length > 1
            ? `${pub.length} NDI sources receive “${PUBLIC_NDI_NAME}” (${pub.map((p) => p.name).join(", ")}): keep one, or the comms are on air twice.`
            : inLive(pub[0]!.name)
              ? `“${pub[0]!.name}” is in “${live}”.`
              : `“${pub[0]!.name}” isn't in “${live}”: add it (Add → Existing).`,
    });
    const monitored = pub.filter((p) => p.monitor && p.monitor !== "OBS_MONITORING_TYPE_NONE");
    if (pub.length) checks.push({ id: "public-monitor", ok: monitored.length === 0, title: "Comms not monitored to the desktop", detail: monitored.length ? `Audio monitoring is on for ${monitored.map((m) => m.name).join(", ")}: OBS plays the comms on its monitoring device, which a desktop capture can take back in (duplication, echo). Advanced Audio Properties → Audio Monitoring: Monitor Off.` : "Monitor Off." });
    const recLive = rec.filter((r) => inLive(r.name));
    checks.push({ id: "recording-off-air", ok: recLive.length === 0, title: `“${RECORDING_NDI_NAME}” kept off the live scene`, detail: recLive.length ? `${recLive.map((r) => r.name).join(", ")} is in the live scene: the recording's comms (its own team and people) would go on air. Remove it from “${live}”; it belongs only in the dedicated recording's scene.` : rec.length ? "Only outside the live scene." : "Not in OBS yet (Team Comms → Dedicated recording → Set up the recording scene)." });
    // The recording's speaker strip identifies who speaks: never on the public output.
    const stripLive = inLive(STRIP_SOURCE);
    checks.push({ id: "strip-off-air", ok: !stripLive, title: `“${STRIP_SOURCE}” kept off the live scene`, detail: stripLive ? `The recording's speaker strip is in “${live}”: it shows who is speaking, which the public broadcast must never show. Remove it from the live scene; it belongs only in the dedicated recording's scene.` : "Not in the live scene." });
    // TeamSpeak captured directly.
    const ts: string[] = [];
    for (const i of inputs) {
      if (/teamspeak|ts3client/i.test(i.name)) ts.push(i.name);
      else if (i.kind === "wasapi_process_output_capture" || i.kind === "pulse_output_capture") {
        const s = await obs.inputSettings(i.name).catch(() => null);
        if (/ts3client|teamspeak/i.test(JSON.stringify(s?.settings ?? {}))) ts.push(i.name);
      }
    }
    checks.push({ id: "no-teamspeak", ok: ts.length === 0, title: "TeamSpeak not captured", detail: ts.length ? `${ts.join(", ")} looks like a capture of TeamSpeak itself: raw, undelayed comms. Remove it; comms reach OBS only through “${PUBLIC_NDI_NAME}”.` : "No source captures TeamSpeak." });
    const duck = this.settings().duck;
    if (duck.enabled) {
      const missing = duck.inputs.filter((n) => !inputs.some((i) => i.name === n));
      checks.push({ id: "casters", ok: duck.inputs.length > 0 && missing.length === 0, title: "Caster inputs for ducking", detail: !duck.inputs.length ? "Caster ducking is on but no caster input is picked." : missing.length ? `Not in OBS: ${missing.join(", ")}.` : duck.inputs.join(", ") });
    }
    return { connected: true, checks };
  }

  /** Overlay: on top of the live scene in OBS. */
  setupOverlay() {
    return this.overlay.setupObs();
  }

  /** The overlay page's source name in OBS. */
  static readonly overlaySource = OVERLAY_SOURCE;
}
