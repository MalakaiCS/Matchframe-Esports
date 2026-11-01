import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObsManager } from "@matchframe/obs-adapter";
import type { Logger } from "../logger.ts";
import type { CommsCalibration } from "./calibrate.ts";
import { PUBLIC_NDI_NAME, RECORDING_NDI_NAME } from "./outputs.ts";
import type { CommsPublic } from "./public.ts";
import type { CommsRecording } from "./recording.ts";
import type { TeamComms } from "./service.ts";
import type { CommsTimingTest } from "./timing-test.ts";

/**
 * Team Comms setup (ADR-069): the TeamSpeak 3 plugin offered from the program, and a guided checklist
 * whose every step reads its live state from the checks Matchframe already makes.
 *
 * - **The plugin:** the program ships it in its resources (`ts3-plugin`: the .ts3_plugin package, the
 *   binary and plugin.json, which says `built: false` when the Windows build didn't make it).
 *   *Install TeamSpeak plugin* copies this computer's binary into TeamSpeak 3's own plugins folder
 *   (`%APPDATA%\TS3Client\plugins` on Windows); TeamSpeak holds the file while it runs, so a copy
 *   refused then says to close TeamSpeak first (or to double-click the .ts3_plugin package, which
 *   TeamSpeak's own installer opens).
 * - **The checklist:** TeamSpeak plugin (installed, the same build as the program's, connected, both
 *   team tabs captured), DistroAV (OBS's NDI source kind, and a receiver on each of Matchframe's NDI
 *   outputs), Source Record (its filter kind in OBS), OBS scenes (the live scene's comms source and
 *   banner, the recording scene and its recorder, nothing of the recording on air) and calibration (a
 *   delay measured against the gameplay applied, and the recording's timing test).
 */

export const PLUGIN_PLATFORM: Partial<Record<NodeJS.Platform, string>> = { win32: "win64", linux: "linux_amd64", darwin: "mac" };

interface PluginManifest {
  built: boolean;
  version?: string;
  pluginApi?: number;
  sdkCommit?: string;
  note?: string;
  files?: { file: string; platform?: string; sha256: string }[];
}

export type StepState = "done" | "todo" | "unknown";

export interface SetupItem {
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface SetupStep {
  id: "teamspeak-plugin" | "distroav" | "source-record" | "obs-scenes" | "calibration";
  title: string;
  state: StepState;
  /** The state in a word (never only a colour): Done, To do, Not checked. */
  label: string;
  detail: string;
  items: SetupItem[];
}

export class SetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

export interface CommsSetupDeps {
  comms: TeamComms;
  onAir: CommsPublic;
  recording: CommsRecording;
  calibration: CommsCalibration;
  timingTest: CommsTimingTest;
  obs: ObsManager;
  logger: Pick<Logger, "info" | "warn">;
  liveScene: () => string | null;
  /** Where the program's plugin files are (default: MATCHFRAME_TS3_PLUGIN_DIR, else the repository's build output). */
  pluginDir?: () => string | null;
  /** TeamSpeak 3's own folder (default: MATCHFRAME_TS3_CONFIG_DIR, else TeamSpeak's per-user folder). */
  ts3ConfigDir?: () => string | null;
  platform?: NodeJS.Platform;
}

/** TeamSpeak 3 client's per-user folder (its plugins are in `plugins` there). */
export function defaultTs3ConfigDir(platform: NodeJS.Platform = process.platform): string | null {
  if (process.env.MATCHFRAME_TS3_CONFIG_DIR) return process.env.MATCHFRAME_TS3_CONFIG_DIR;
  if (platform === "win32") return process.env.APPDATA ? join(process.env.APPDATA, "TS3Client") : join(homedir(), "AppData", "Roaming", "TS3Client");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "TeamSpeak 3");
  if (platform === "linux") return join(homedir(), ".ts3client");
  return null;
}

/** The program's plugin files: MATCHFRAME_TS3_PLUGIN_DIR (the program sets it), else the plugin's build output in a development checkout. */
export function defaultPluginDir(): string | null {
  if (process.env.MATCHFRAME_TS3_PLUGIN_DIR) return process.env.MATCHFRAME_TS3_PLUGIN_DIR;
  const dev = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "native", "ts3-matchframe-plugin", "dist");
  return existsSync(dev) ? dev : null;
}

const OBS_CHECK_MS = 15_000;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export class CommsSetup {
  private hashCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();
  private lastInstall: { at: string; ok: boolean; detail: string } | null = null;
  /** OBS's routing check is a few dozen requests: the checklist reuses one for OBS_CHECK_MS. */
  private obsCheckCache: { atMs: number; value: Awaited<ReturnType<CommsPublic["obsCheck"]>> | null } | null = null;

  constructor(private readonly d: CommsSetupDeps) {}

  private platform(): NodeJS.Platform {
    return this.d.platform ?? process.platform;
  }

  private pluginDir(): string | null {
    return (this.d.pluginDir ?? defaultPluginDir)();
  }

  private ts3Dir(): string | null {
    return (this.d.ts3ConfigDir ?? (() => defaultTs3ConfigDir(this.platform())))();
  }

  private hashOf(file: string): string | null {
    try {
      const st = statSync(file);
      const c = this.hashCache.get(file);
      if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha;
      const sha = sha256(file);
      this.hashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha });
      return sha;
    } catch {
      return null;
    }
  }

  private manifest(): PluginManifest | null {
    const dir = this.pluginDir();
    if (!dir) return null;
    try {
      return JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as PluginManifest;
    } catch {
      return null;
    }
  }

  /** The plugin as the program has it, as TeamSpeak has it, and as it connects. */
  plugin() {
    const dir = this.pluginDir();
    const m = this.manifest();
    const want = PLUGIN_PLATFORM[this.platform()] ?? null;
    const bin = m?.built ? (m.files ?? []).find((f) => f.platform === want) : undefined;
    const pkg = m?.built ? (m.files ?? []).find((f) => f.file.endsWith(".ts3_plugin")) : undefined;
    const binPath = dir && bin ? join(dir, bin.file) : null;
    const ts3 = this.ts3Dir();
    const pluginsDir = ts3 ? join(ts3, "plugins") : null;
    const installedPath = pluginsDir && bin ? join(pluginsDir, bin.file) : null;
    const installedSha = installedPath && existsSync(installedPath) ? this.hashOf(installedPath) : null;
    const sessions = this.d.comms.status().bridge.plugins;
    const connected = sessions.map((s) => ({ version: s.plugin?.version ?? null, apiVersion: s.plugin?.apiVersion ?? null, platform: s.platform, ts3: s.ts3?.clientLibVersion ?? null }));
    const bundled = {
      built: !!m?.built,
      version: m?.version ?? null,
      pluginApi: m?.pluginApi ?? null,
      binary: binPath && existsSync(binPath) ? binPath : null,
      package: dir && pkg && existsSync(join(dir, pkg.file)) ? join(dir, pkg.file) : null,
      sha256: bin?.sha256 ?? null,
      note: !m ? "The program's TeamSpeak plugin files aren't here (a development build without the plugin built)." : !m.built ? (m.note ?? "This build of Matchframe doesn't include the TeamSpeak plugin.") : !bin ? `This build has no plugin for this computer (${this.platform()}).` : null,
    };
    const installed = {
      teamspeakFolder: ts3,
      teamspeakFound: !!ts3 && existsSync(ts3),
      pluginsDir,
      path: installedSha ? installedPath : null,
      same: !!installedSha && !!bin && installedSha === bin.sha256,
    };
    return { platform: want, bundled, installed, connected, lastInstall: this.lastInstall };
  }

  /**
   * Install TeamSpeak plugin: this computer's binary copied into TeamSpeak 3's plugins folder (made if
   * missing). Refused while TeamSpeak has the plugin open (close TeamSpeak first).
   */
  install(): ReturnType<CommsSetup["plugin"]> {
    const p = this.plugin();
    if (!p.bundled.binary) throw new SetupError(409, "no_plugin", p.bundled.note ?? "This build of Matchframe doesn't include the TeamSpeak plugin.");
    if (!p.installed.pluginsDir) throw new SetupError(409, "no_teamspeak", "Matchframe doesn't know TeamSpeak 3's folder on this computer.");
    const target = join(p.installed.pluginsDir, p.bundled.binary.split(/[\\/]/).pop()!);
    const tmp = `${target}.mf-new`;
    try {
      mkdirSync(p.installed.pluginsDir, { recursive: true });
      copyFileSync(p.bundled.binary, tmp);
      renameSync(tmp, target);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Left for the next try.
      }
      const code = (err as NodeJS.ErrnoException).code;
      const busy = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      const detail = busy
        ? `TeamSpeak 3 has the plugin open (it is running): close TeamSpeak 3, press Install TeamSpeak plugin again, then start TeamSpeak.${p.bundled.package ? ` Or double-click ${p.bundled.package} (TeamSpeak's own installer).` : ""}`
        : `Couldn't copy the plugin to ${p.installed.pluginsDir}: ${(err as Error).message}`;
      this.lastInstall = { at: new Date().toISOString(), ok: false, detail };
      this.d.logger.warn("team comms: TeamSpeak plugin not installed", { code, target });
      throw new SetupError(409, busy ? "teamspeak_running" : "copy_failed", detail);
    }
    this.hashCache.delete(target);
    this.lastInstall = { at: new Date().toISOString(), ok: true, detail: `Copied to ${target}. Start TeamSpeak 3 (or restart it): Tools → Options → Add-ons → Matchframe Team Comms enabled.` };
    this.d.logger.info("team comms: TeamSpeak plugin installed", { target, version: p.bundled.version });
    return this.plugin();
  }

  private step(id: SetupStep["id"], title: string, items: SetupItem[], detail: { done: string; todo: string; unknown: string }): SetupStep {
    const state: StepState = items.every((i) => i.ok === true) ? "done" : items.some((i) => i.ok === false) ? "todo" : "unknown";
    return { id, title, state, label: state === "done" ? "Done" : state === "todo" ? "To do" : "Not checked", detail: detail[state], items };
  }

  /** The guided checklist with each step's live state. */
  async checklist(): Promise<{ steps: SetupStep[]; plugin: ReturnType<CommsSetup["plugin"]>; obsConnected: boolean }> {
    const c = this.d.comms;
    const st = c.status();
    const p = this.plugin();
    const obs = this.d.obs;
    const connected = obs.state.connected;
    const steps: SetupStep[] = [];

    // 1. TeamSpeak plugin.
    const tabs = st.slots.map((s) => ({ s, ok: s.state === "ready" || s.state === "buffering" }));
    steps.push(
      this.step(
        "teamspeak-plugin",
        "TeamSpeak plugin",
        [
          { label: "In this program", ok: p.bundled.binary ? true : false, detail: p.bundled.binary ? `Matchframe Team Comms ${p.bundled.version ?? ""} (plugin API ${p.bundled.pluginApi ?? "?"})` : (p.bundled.note ?? "Not included.") },
          { label: "Installed in TeamSpeak 3", ok: p.installed.path ? (p.bundled.sha256 ? p.installed.same : true) : p.connected.length ? null : false, detail: p.installed.path ? (p.installed.same || !p.bundled.sha256 ? p.installed.path : `${p.installed.path} is another build: Install TeamSpeak plugin replaces it (close TeamSpeak first).`) : p.connected.length ? "Connected (installed by hand, or TeamSpeak's add-on installer)." : !p.installed.teamspeakFound ? `TeamSpeak 3 not found (${p.installed.teamspeakFolder ?? "no folder"}): install TeamSpeak 3 and start it once.` : "Not in TeamSpeak's plugins folder yet: Install TeamSpeak plugin." },
          { label: "Connected to Matchframe", ok: !c.enabled ? null : p.connected.length > 0, detail: !c.enabled ? "Team Comms is off." : p.connected.length ? p.connected.map((x) => `plugin ${x.version ?? "?"} in TeamSpeak ${x.ts3 ?? "?"} (${x.platform ?? "?"})`).join("; ") : "Not connected: start TeamSpeak 3 with the plugin enabled (Tools → Options → Add-ons)." },
          ...tabs.map(({ s, ok }) => ({ label: `Team tab: ${s.team?.name ?? `Team ${s.id}`}`, ok: !c.enabled ? null : ok, detail: s.tab ? `${s.tab.channel?.name ?? "?"} on ${s.tab.server?.name ?? s.tab.server?.host ?? "?"} as ${s.tab.listener?.nickname ?? "?"} (${s.state})` : (s.issue ?? "No TeamSpeak tab in the team's channel yet.") })),
        ],
        { done: "The plugin is connected and captures both team tabs.", todo: "Install the plugin, start TeamSpeak 3 and connect a tab to each team's channel.", unknown: "Switch Team Comms on to check the plugin and the team tabs." },
      ),
    );

    // 2. DistroAV.
    const ndi = this.d.onAir.outputs.status().ndi;
    const kinds = obs.state.inputKinds ?? [];
    const hasNdiKind = connected ? (kinds.length ? kinds.includes("ndi_source") : null) : null;
    steps.push(
      this.step(
        "distroav",
        "DistroAV (NDI in OBS)",
        [
          { label: "DistroAV in OBS", ok: hasNdiKind, detail: !connected ? "OBS isn't connected (Settings → Devices)." : hasNdiKind ? "OBS has the NDI source (DistroAV)." : hasNdiKind === false ? "OBS has no NDI source: install DistroAV 6.x and the NDI 6 Runtime it asks for, then restart OBS." : "OBS didn't list its source kinds." },
          { label: `Matchframe sends “${PUBLIC_NDI_NAME}”`, ok: !c.enabled || !ndi.enabled ? null : ndi.state === "running", detail: ndi.detail },
          { label: `OBS receives “${PUBLIC_NDI_NAME}”`, ok: ndi.state === "running" && ndi.stats ? ndi.stats.connections.public > 0 : null, detail: ndi.stats ? `${ndi.stats.connections.public} receiver(s)` : "Not sending yet." },
          { label: `OBS receives “${RECORDING_NDI_NAME}”`, ok: ndi.state === "running" && ndi.stats ? ndi.stats.connections.recording > 0 : null, detail: ndi.stats ? `${ndi.stats.connections.recording} receiver(s)` : "Not sending yet." },
        ],
        { done: "OBS receives both of Matchframe's comms outputs over NDI.", todo: "Install DistroAV in OBS and add the NDI sources (the OBS scenes step makes the recording's).", unknown: "Connect OBS and switch Team Comms on to check." },
      ),
    );

    // 3. Source Record.
    const sr = connected ? await this.d.recording.sourceRecordAvailable() : null;
    steps.push(
      this.step("source-record", "Source Record (the comms recording)", [{ label: "Source Record in OBS", ok: sr, detail: sr ? "Installed (filter kind source_record_filter)." : sr === false ? "OBS has no Source Record: close OBS, install Source Record 0.4.x for your OBS (obsproject.com/forum/resources/source-record.1285), start OBS." : "OBS isn't connected." }], {
        done: "Source Record is installed in OBS.",
        todo: "Install Source Record in OBS.",
        unknown: "Connect OBS to check.",
      }),
    );

    // 4. OBS scenes.
    const live = this.d.liveScene();
    const fresh = this.obsCheckCache && performance.now() - this.obsCheckCache.atMs < OBS_CHECK_MS;
    if (connected && !fresh) this.obsCheckCache = { atMs: performance.now(), value: await this.d.onAir.obsCheck().catch(() => null) };
    const check = connected ? (this.obsCheckCache?.value ?? null) : null;
    const byId = (id: string) => check?.checks.find((x) => x.id === id) ?? null;
    const rec = this.d.recording.status();
    const overlayIn = connected && live ? await obs.sceneItems(live).then((items) => items.some((i) => i.sourceName === this.d.onAir.overlay.status().source)).catch(() => null) : null;
    const pub = byId("public-source");
    const off = [byId("recording-off-air"), byId("strip-off-air")];
    steps.push(
      this.step(
        "obs-scenes",
        "OBS scenes",
        [
          { label: "Live scene mapped", ok: connected ? !!live : null, detail: live ? `“${live}”` : connected ? "Map the live scene (Settings → Setup → OBS scenes)." : "OBS isn't connected." },
          { label: `“${PUBLIC_NDI_NAME}” in the live scene`, ok: pub?.ok ?? null, detail: pub?.detail ?? "Not checked." },
          { label: "TEAM COMMS banner in the live scene", ok: overlayIn, detail: overlayIn ? "On top of the live scene." : overlayIn === false ? "Public Team Comms graphic → Add to the live scene in OBS." : "Not checked." },
          { label: "Recording scene set up", ok: connected ? rec.obs.sceneExists && rec.obs.filter.recordMode !== null : null, detail: rec.obs.sceneExists ? (rec.obs.filter.recordMode !== null ? `“${rec.obs.scene}” with Source Record's “${rec.obs.filter.name}”.` : `“${rec.obs.scene}” has no Source Record filter: Set up the recording scene in OBS.`) : "Dedicated comms recording → Set up the recording scene in OBS." },
          { label: "Nothing of the recording on air", ok: off.every((x) => x) ? off.every((x) => x!.ok === true) : null, detail: off.filter((x) => x && x.ok === false).map((x) => x!.detail).join(" ") || "The recording comms and the speaker strip are off the live scene." },
        ],
        { done: "The live scene carries the public comms and banner; the recording scene is ready; nothing of the recording is on air.", todo: "Finish the OBS setup (Team Comms → OBS routing check has the details).", unknown: "Connect OBS to check." },
      ),
    );

    // 5. Calibration.
    const cal = this.d.calibration.status();
    const tt = this.d.timingTest.status().result;
    steps.push(
      this.step(
        "calibration",
        "Calibration against the gameplay",
        [
          { label: "Delay measured against the gameplay", ok: cal.applied ? true : false, detail: cal.applied ? `${(cal.applied.delayMs / 1000).toFixed(3)} s from ${cal.applied.marks} mark(s) (spread ${cal.applied.spreadMs} ms), ${cal.applied.at.slice(0, 16).replace("T", " ")}` : "Delay against the gameplay: arm, mark, Seen; then Use this delay." },
          { label: "Timing test in a recording", ok: tt ? (tt.applied ? true : null) : null, detail: tt ? `${tt.applied ? "Applied" : `Found ${tt.pairs} beeps; not applied yet`}: strip offset ${tt.suggestion.stripOffsetMs} ms${tt.suggestion.fineMs !== null ? `, delay ${tt.suggestion.delaySec} s + ${tt.suggestion.fineMs} ms` : ""}.` : "Optional: beeps in a short recording, found by Matchframe in the file." },
        ],
        { done: "The delay was measured against the gameplay and checked in a recording.", todo: "Measure the delay against the gameplay (Delay against the gameplay).", unknown: "The delay is measured; the timing test in a recording is optional." },
      ),
    );
    return { steps, plugin: p, obsConnected: connected };
  }
}
