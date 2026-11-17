import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, crashReporter, dialog, Notification } from "electron";
import { t } from "../i18n.ts";
import type { Event, MessageBoxOptions, RenderProcessGoneDetails, WebContents } from "electron";
import type { CrashDetails, CrashProcess } from "@matchframe/cloud-contracts";
import { HUD_WINDOW_TAG } from "../hud/overlays.ts";
import type { HudWindowTag } from "../hud/overlays.ts";
import { CrashQueue, newReportId } from "./queue.ts";
import type { CrashItem } from "./queue.ts";
import { redactSupport } from "./redact.ts";
import { buildReport, engineErrorFrom, MINIDUMP_ATTACH_MAX_BYTES, uploadReport } from "./report.ts";

/**
 * Crash reports (ADR-077), the program's side. Off unless the operator turns on Send crash reports
 * (Settings → General → Program). What counts as a crash: an uncaught exception in this process, a
 * window's renderer gone (the manager or a HUD window), the engine exiting when nobody asked it to,
 * and native crashes, which Electron's crash reporter writes as minidumps on this computer only.
 * Every crash is kept in the local queue (queue.ts); it is sent when crash reports are on, otherwise
 * the next start asks once. Sending uses the computer's website sign-in when it has one (from the
 * engine, over IPC), else goes anonymously.
 */

/** Native crashes: minidumps written on this computer, never uploaded by Electron itself. Call before the app is ready. */
export function startNativeCrashReporter(dumpDir: string): void {
  app.setPath("crashDumps", dumpDir);
  crashReporter.start({ uploadToServer: false });
}

export interface CrashReportsState {
  enabled: boolean;
  queued: number;
  waiting: number;
  recent: { id: string; process: CrashProcess; sentAt: string }[];
  lastError: string | null;
}

export interface CrashReportsDeps {
  /** The Send crash reports setting. */
  enabled(): boolean;
  saveEnabled(on: boolean): void;
  /** This computer runs the production and its engine is up (it can make a support file and say how the computer is signed in). */
  engineReady(): boolean;
  supportFile(): Promise<Record<string, unknown> | null>;
  /** From the engine over IPC: the website's address, this computer's credential (null when signed out) and the secrets it holds. */
  credentials(): Promise<{ url: string | null; token: string | null; secrets: string[] } | null>;
  /** The website address this build is pinned to (cloud.json or MATCHFRAME_CLOUD_URL), for sending without the engine. */
  fixedUrl(): string | null;
  /** Secrets this process holds: the operator token, the remote access token, the credential key. */
  ownSecrets(): (string | null | undefined)[];
  window(): BrowserWindow | null;
  connectionMode(): "local" | "remote";
  quitting(): boolean;
  log(msg: string): void;
  fetch: typeof fetch;
}

/** The engine restarts after its own crash; a report waits this long for it (support file, sign-in) before going without. */
const WAIT_FOR_ENGINE_MS = 3 * 60_000;
const PUMP_EVERY_MS = 60_000;

const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
};

export class CrashReports {
  readonly queue: CrashQueue;
  private readonly session = newReportId();
  private readonly wcStarted = new Map<number, number>();
  private readonly capturing = new Map<string, Promise<CrashItem | null>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private errorBoxOpen = false;

  constructor(
    private readonly d: CrashReportsDeps,
    private readonly dirs: { queue: string; dumps: string },
  ) {
    this.queue = new CrashQueue({ dir: dirs.queue, session: this.session, log: d.log }).load();
    app.on("web-contents-created", (_e, wc) => this.wcStarted.set(wc.id, Date.now()));
    app.on("render-process-gone", this.onRenderGone);
  }

  /** At app ready: minidumps from earlier runs, the next-start question, and sending what waits. */
  start(): void {
    this.scanDumpsAtStart();
    // Crash reports on: anything still waiting goes without asking.
    if (this.d.enabled()) this.queue.setConsent(true);
    this.timer = setInterval(() => void this.pump(), PUMP_EVERY_MS);
    void this.pump();
    const waiting = this.queue.awaitingFromEarlier();
    if (waiting.length) void this.ask(waiting.map((i) => i.localId));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    app.off("render-process-gone", this.onRenderGone);
  }

  state(): CrashReportsState {
    return { enabled: this.d.enabled(), ...this.queue.summary() };
  }

  setEnabled(on: boolean): CrashReportsState {
    this.d.saveEnabled(on);
    this.queue.setConsent(on);
    if (on) void this.pump();
    return this.state();
  }

  /** The engine (re)started: its support file and sign-in are available again. */
  engineStarted(): void {
    void this.pump();
  }

  // ------------------------------------------------------------------ what counts as a crash

  /** An uncaught exception in this (Electron's main) process. The program keeps running, as Electron's own handler lets it. */
  recordMainException(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.d.log(`[crash] uncaught exception in the main process: ${e.stack ?? e.message}`);
    this.record({ process: "main", reason: "uncaughtException", error: `${e.name}: ${e.message}`, stack: e.stack ?? null, uptimeSeconds: process.uptime(), detail: {} }, { supportFile: true, sendAfterMs: 2000 });
    if (app.isReady() && !this.errorBoxOpen && !this.d.quitting()) {
      // Electron shows this message itself when nothing handles the exception; one at a time.
      this.errorBoxOpen = true;
      void dialog.showMessageBox({ type: "error", title: "MatchFrame", message: t("dialog.mainError"), detail: e.stack ?? e.message }).finally(() => (this.errorBoxOpen = false));
    }
  }

  /** The engine exited without being asked to (local mode). `output`: its last lines. */
  recordEngineExit(e: { code: number | null; signal: string | null; uptimeMs: number; output: string[] }): void {
    const how = e.signal ? `signal ${e.signal}` : `exit code ${e.code}`;
    const last = engineErrorFrom(e.output);
    this.record(
      { process: "engine", reason: how, error: last?.error ?? `The engine stopped unexpectedly (${how}).`, stack: last?.stack ?? null, uptimeSeconds: e.uptimeMs / 1000, detail: { exitCode: e.code, signal: e.signal, engineOutput: e.output.slice(-80) } },
      { supportFile: true, sendAfterMs: 5000 },
    );
  }

  /** A window's renderer gone: the manager window, a desktop HUD or a HUD preview. */
  private readonly onRenderGone = (_e: Event, wc: WebContents, details: RenderProcessGoneDetails) => {
    // Not crashes: a renderer closing normally, or one Chromium let go to save memory.
    if (details.reason === "clean-exit" || details.reason === "memory-eviction") return;
    const now = Date.now();
    const started = this.wcStarted.get(wc.id) ?? now - process.uptime() * 1000;
    this.wcStarted.set(wc.id, now);
    const w = BrowserWindow.fromWebContents(wc);
    const tag = w ? (w as unknown as Record<symbol, HudWindowTag | undefined>)[HUD_WINDOW_TAG] : undefined;
    const manager = !!w && w === this.d.window();
    const which = tag ? (tag.kind === "preview" ? "HUD preview" : "desktop HUD") : manager ? "manager" : "other";
    const item = this.record(
      {
        process: tag ? "hud" : "renderer",
        reason: details.reason,
        // The exit code is in the details: the same crash again reads the same (the queue counts repeats by this line).
        error: `The ${which} window's renderer process ${details.reason === "oom" ? "ran out of memory" : "stopped"} (${details.reason}).`,
        stack: null,
        uptimeSeconds: (now - started) / 1000,
        detail: { window: which, exitCode: details.exitCode, page: pageOf(wc.getURL()), ...(tag ? { hudId: tag.hudId } : {}) },
      },
      { supportFile: true, sendAfterMs: 6000 },
    );
    // A renderer that crashed natively left a minidump too: attach it to this report rather than report it again.
    if (item) setTimeout(() => this.attachFreshDump(item.localId, now), 3000);
  };

  private record(
    c: Pick<CrashDetails, "process" | "reason" | "error" | "stack" | "uptimeSeconds" | "detail"> & { occurredAt?: string },
    opts: { supportFile: boolean; sendAfterMs?: number; earlierRun?: boolean; minidump?: CrashItem["minidump"] },
  ): CrashItem | null {
    if (this.d.quitting()) return null;
    try {
      const raw: CrashDetails = {
        reportId: newReportId(),
        occurredAt: c.occurredAt ?? new Date().toISOString(),
        appVersion: app.getVersion(),
        os: { platform: process.platform, release: release(), arch: process.arch },
        process: c.process,
        reason: c.reason,
        error: c.error,
        stack: c.stack,
        uptimeSeconds: c.uptimeSeconds,
        programUptimeSeconds: opts.earlierRun ? null : process.uptime(),
        detail: { connection: this.d.connectionMode(), ...c.detail },
      };
      // Secrets known now never reach the disk; sending redacts again with what is known then.
      const crash = { ...(redactSupport(raw, { secrets: this.d.ownSecrets(), home: homedir() }) as CrashDetails), reportId: raw.reportId };
      const wantsSupportFile = opts.supportFile && this.d.connectionMode() === "local";
      const item = this.queue.record({ crash, wantsSupportFile, minidump: opts.minidump ?? null }, this.d.enabled(), { earlierRun: opts.earlierRun, sendAfterMs: opts.sendAfterMs });
      if (!item) return null;
      this.d.log(`[crash] ${item.crash.process} crash recorded (${item.crash.reason}); ${item.status === "queued" ? "sending it" : "crash reports are off: the next start asks"}`);
      // The support file as things were at the crash, when the engine can still make one.
      if (item.wantsSupportFile && this.d.engineReady()) void this.captureSupportFile(item.localId);
      if (item.status === "queued") setTimeout(() => void this.pump(), (opts.sendAfterMs ?? 0) + 100);
      return item;
    } catch (e) {
      this.d.log(`[crash] could not record a crash: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private captureSupportFile(localId: string): Promise<CrashItem | null> {
    const running = this.capturing.get(localId);
    if (running) return running;
    const p = (async () => {
      const sf = await this.d.supportFile().catch(() => null);
      if (!sf) return this.queue.get(localId) ?? null;
      const safe = redactSupport(sf, { secrets: this.d.ownSecrets(), home: homedir() }) as Record<string, unknown>;
      return this.queue.update(localId, { supportFile: safe, supportFileAt: new Date().toISOString(), wantsSupportFile: false });
    })().finally(() => this.capturing.delete(localId));
    this.capturing.set(localId, p);
    return p;
  }

  // ------------------------------------------------------------------ minidumps

  /** Minidumps in Electron's crash folder (Crashpad keeps them under reports/, completed/ or pending/). */
  private dumps(): { name: string; path: string; size: number; mtimeMs: number }[] {
    const out: { name: string; path: string; size: number; mtimeMs: number }[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".dmp")) {
          try {
            const st = statSync(p);
            out.push({ name: e.name, path: p, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // gone meanwhile
          }
        }
      }
    };
    walk(this.dirs.dumps, 0);
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  /** A native crash of an earlier run (the program closed) left a minidump nobody has looked at. */
  private scanDumpsAtStart(): void {
    const all = this.dumps();
    // The first start with crash reports: older minidumps are not reported.
    if (this.queue.firstRun) return this.queue.markDumpsSeen(all.map((x) => x.name));
    const fresh = all.filter((x) => !this.queue.isDumpSeen(x.name));
    this.queue.markDumpsSeen(fresh.map((x) => x.name));
    for (const x of fresh.slice(-5)) {
      this.record(
        { process: "native", reason: "minidump", error: "MatchFrame closed unexpectedly (a native crash; Electron's crash reporter wrote a minidump).", stack: null, uptimeSeconds: null, occurredAt: new Date(x.mtimeMs).toISOString(), detail: {} },
        { supportFile: true, earlierRun: true, minidump: { path: x.path, name: x.name, size: x.size } },
      );
    }
  }

  private attachFreshDump(localId: string, crashAt: number): void {
    const fresh = this.dumps().filter((x) => !this.queue.isDumpSeen(x.name) && x.mtimeMs >= crashAt - 10_000);
    const newest = fresh.at(-1);
    if (!newest) return;
    this.queue.markDumpsSeen(fresh.map((x) => x.name));
    this.queue.update(localId, { minidump: { path: newest.path, name: newest.name, size: newest.size } });
  }

  // ------------------------------------------------------------------ asking and sending

  /** A shown, ready manager window within `ms`, or null. */
  private async windowSoon(ms: number): Promise<BrowserWindow | null> {
    for (let t = 0; t < ms; t += 500) {
      const w = this.d.window();
      if (w && !w.isDestroyed() && w.isVisible()) return w;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** The next-start question, asked once for every crash that happened while crash reports were off. */
  private async ask(localIds: string[]): Promise<void> {
    const w = await this.windowSoon(20_000);
    const opts: MessageBoxOptions = {
      type: "question",
      title: "MatchFrame",
      message: t("crash.prompt"),
      detail: `${localIds.length > 1 ? `${t("crash.noted", { count: localIds.length })} ` : ""}${t("crash.detail")}`,
      buttons: [t("crash.send"), t("crash.dontSend"), t("crash.alwaysSend")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    if (response === 2) this.setEnabled(true);
    this.queue.resolve(localIds, response === 1 ? "discard" : "send");
    this.d.log(`[crash] next-start question: ${["send", "don't send", "always send"][response] ?? "don't send"}`);
    void this.pump();
  }

  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const item of this.queue.due()) {
        if (this.d.quitting()) break;
        await this.send(item);
      }
    } catch (e) {
      this.d.log(`[crash] sending failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.pumping = false;
    }
  }

  private async send(item: CrashItem): Promise<void> {
    let it = item;
    const young = Date.now() - Date.parse(it.createdAt) < WAIT_FOR_ENGINE_MS;
    if (this.d.connectionMode() === "local" && !this.d.engineReady() && young) {
      // The engine is (re)starting: wait for it, for the support file and this computer's sign-in.
      this.queue.update(it.localId, { nextAttemptAt: new Date(Date.now() + 15_000).toISOString() });
      setTimeout(() => void this.pump(), 15_100);
      return;
    }
    if (it.wantsSupportFile) it = (this.d.engineReady() ? await this.captureSupportFile(it.localId) : this.queue.update(it.localId, { wantsSupportFile: false })) ?? it;
    if (!this.queue.get(it.localId)) return;
    const creds = this.d.connectionMode() === "local" ? await this.d.credentials() : null;
    const url = creds?.url ?? this.d.fixedUrl();
    if (!url) return this.queue.markFailed(it.localId, "this program has no website address to send crash reports to", true);
    let dump: Buffer | null = null;
    if (it.minidump && it.minidump.size <= MINIDUMP_ATTACH_MAX_BYTES) {
      try {
        dump = readFileSync(it.minidump.path);
      } catch {
        dump = null;
      }
    }
    const built = buildReport(it, { secrets: [...this.d.ownSecrets(), ...(creds?.secrets ?? []), creds?.token], home: homedir(), minidump: dump });
    const result = await uploadReport(built.body, { url, token: creds?.token ?? null, appVersion: app.getVersion(), fetch: this.d.fetch });
    if (result.kind === "sent") {
      this.queue.markSent(it.localId, result.id);
      this.d.log(`[crash] crash report sent (ID ${result.id})${built.trimmed.length ? `; left out to fit 10 MB: ${built.trimmed.join(", ")}` : ""}`);
      this.announce(result.id, it.crash.process);
    } else {
      this.queue.markFailed(it.localId, result.error, result.kind === "retry");
      this.d.log(`[crash] crash report not sent (${result.kind === "retry" ? "trying again later" : "dropped"}): ${result.error}`);
    }
  }

  /** "Crash report sent (ID …)": in the console when it is on screen, else as a Windows notification. */
  private announce(id: string, proc: CrashProcess): void {
    const w = this.d.window();
    if (w && !w.isDestroyed() && w.isVisible() && !w.webContents.isCrashed()) w.webContents.send("mf:crash-report-sent", { id, process: proc });
    else if (Notification.isSupported()) new Notification({ title: t("crash.sentTitle"), body: t("crash.sentBody", { id }), silent: true }).show();
  }
}
