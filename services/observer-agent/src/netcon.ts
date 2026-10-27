import { Socket } from "node:net";
import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState } from "@matchframe/contracts";
import type { ControlCapabilities, ObserverControlAdapter } from "@matchframe/director-policy";
import { failedResult, transportResult } from "@matchframe/director-policy";
import { accountIdOf, cap } from "./common.ts";

/**
 * Console command templates for the direct channel. These are CANDIDATE mappings from semantic
 * operations to CS2 console commands. They have NOT been verified on a current CS2 build in this
 * project's test environment; every capability stays "unverified" until the setup checklist
 * confirms it with observed feedback (GSI spectated player) or operator confirmation.
 * Operators can edit them in Settings without recompiling.
 */
export interface NetconTemplates {
  selectPlayer: string;
  modeInEye: string;
  modeChase: string;
  modeRoaming: string;
  staticCamera: string;
  readPose: string;
}

export const DEFAULT_NETCON_TEMPLATES: NetconTemplates = {
  selectPlayer: "spec_player_by_accountid {accountId}",
  modeInEye: "spec_mode 4",
  modeChase: "spec_mode 5",
  modeRoaming: "spec_mode 6",
  staticCamera: "spec_mode 6; spec_goto {x} {y} {z} {pitch} {yaw}",
  readPose: "getpos",
};

export interface NetconOptions {
  host: string;
  port: number;
  templates?: Partial<NetconTemplates>;
  now: () => number;
  connectTimeoutMs?: number;
  /** Capability evidence recorded by the setup checklist (persisted by the engine). */
  verified?: Partial<Record<keyof ControlCapabilities, { build: string | null; at: string; support: "supported" | "partial" }>>;
  onLine?: (line: string) => void;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`template placeholder {${k}} has no value`);
    return String(v);
  });
}

/** Rejects anything that could inject additional console commands through a value. */
function safeValue(v: string | number): string | number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite numeric value");
    return Math.round(v * 100) / 100;
  }
  if (!/^[0-9A-Za-z_.-]+$/.test(v)) throw new Error("unsafe value for console command");
  return v;
}

/**
 * Direct observer channel over the game's TCP console (launch option `-netconport <port>`).
 * This is a documented Valve launch option, not memory reading or injection. It is loopback-only
 * by default because the console accepts arbitrary commands. Writes are transport acknowledgements;
 * confirmation must come from telemetry feedback.
 */
export class NetconObserverAdapter implements ObserverControlAdapter {
  readonly id: string;
  readonly kind = "direct" as const;
  readonly simulated = false;
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly templates: NetconTemplates;
  private buffer = "";
  private lastPose: ObservedCameraState["pose"] = null;
  private lastPoseAt: number | null = null;
  private queue: { line: string; resolve: (ok: boolean, err?: string) => void }[] = [];

  constructor(private readonly opts: NetconOptions) {
    this.id = `netcon:${opts.host}:${opts.port}`;
    this.templates = { ...DEFAULT_NETCON_TEMPLATES, ...(opts.templates ?? {}) };
  }

  async getCapabilities(): Promise<ControlCapabilities> {
    const v = this.opts.verified ?? {};
    const lim = (what: string) => [`Command template for ${what} is a candidate mapping; verify with the setup checklist on the target CS2 build.`, "Requires the observer client launched with -netconport (loopback only)."];
    const c = (key: keyof ControlCapabilities, what: string) =>
      v[key] ? cap(key, v[key]!.support, [], this.id, { build: v[key]!.build, at: v[key]!.at }) : cap(key, "unverified", lim(what), this.id);
    return {
      playerSelectionControl: c("playerSelectionControl", "player selection"),
      observerModeControl: c("observerModeControl", "observer mode"),
      staticCameraControl: c("staticCameraControl", "static camera"),
      cameraPathControl: cap("cameraPathControl", "unsupported", ["No verified camera path mechanism for this channel."], this.id),
      cameraReadback: c("cameraReadback", "pose readback (getpos)"),
    };
  }

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const s = new Socket();
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("netcon connect timeout"));
      }, this.opts.connectTimeoutMs ?? 1500);
      s.once("connect", () => {
        clearTimeout(timer);
        this.socket = s;
        resolve();
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
      s.on("close", () => {
        this.socket = null;
      });
      s.connect(this.opts.port, this.opts.host);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onData(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.opts.onLine?.(line);
      const m = /setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(line);
      if (m) {
        this.lastPose = { position: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, pitch: Number(m[4]), yaw: Number(m[5]), fov: null };
        this.lastPoseAt = this.opts.now();
      }
    }
  }

  private async send(ctx: CommandContext, command: string): Promise<CommandResult> {
    if (this.opts.now() > ctx.expiresAtMonotonicMs) return failedResult(ctx, "expired", "command expired before transport");
    try {
      await this.connect();
    } catch (e) {
      return failedResult(ctx, "transport_error", `netcon unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const s = this.socket;
    if (!s) return failedResult(ctx, "transport_error", "netcon socket closed");
    return new Promise<CommandResult>((resolve) => {
      const entry = {
        line: command,
        resolve: (ok: boolean, err?: string) => resolve(ok ? transportResult(ctx, true, command, this.opts.now()) : failedResult(ctx, "transport_error", err ?? "write failed")),
      };
      this.queue.push(entry);
      s.write(`${command}\n`, (err) => {
        this.queue = this.queue.filter((q) => q !== entry);
        entry.resolve(!err, err?.message);
      });
    });
  }

  async selectPlayer(steamId: string, observerSlot: number | null, ctx: CommandContext): Promise<CommandResult> {
    let cmd: string;
    try {
      cmd = fill(this.templates.selectPlayer, { accountId: safeValue(accountIdOf(steamId)), steamId: safeValue(steamId), slot: safeValue(observerSlot ?? -1) });
    } catch (e) {
      return failedResult(ctx, "target_invalid", e instanceof Error ? e.message : String(e));
    }
    return this.send(ctx, cmd);
  }

  async setObserverMode(mode: CameraMode, ctx: CommandContext): Promise<CommandResult> {
    const t = mode === "in_eye" ? this.templates.modeInEye : mode === "chase" ? this.templates.modeChase : mode === "roaming" ? this.templates.modeRoaming : null;
    if (!t) return failedResult(ctx, "unsupported", `mode ${mode} has no template`);
    return this.send(ctx, t);
  }

  async activateStaticCamera(camera: CameraRecord, ctx: CommandContext): Promise<CommandResult> {
    let cmd: string;
    try {
      cmd = fill(this.templates.staticCamera, {
        x: safeValue(camera.position.x),
        y: safeValue(camera.position.y),
        z: safeValue(camera.position.z),
        pitch: safeValue(camera.pitch),
        yaw: safeValue(camera.yaw),
      });
    } catch (e) {
      return failedResult(ctx, "target_invalid", e instanceof Error ? e.message : String(e));
    }
    return this.send(ctx, cmd);
  }

  async playCameraPath(_path: CameraPath, ctx: CommandContext): Promise<CommandResult> {
    return failedResult(ctx, "unsupported", "camera paths are not supported on this channel");
  }

  async cancelPath(ctx: CommandContext): Promise<CommandResult> {
    return failedResult(ctx, "unsupported", "camera paths are not supported on this channel");
  }

  /** Requests a pose readback; the answer arrives asynchronously via console output. */
  async requestPose(ctx: CommandContext): Promise<CommandResult> {
    return this.send(ctx, this.templates.readPose);
  }

  async readState(): Promise<ObservedCameraState> {
    return { observedSteamId: null, observedSlot: null, mode: "unknown", pose: this.lastPose, observedAtMonotonicMs: this.lastPoseAt, precision: this.lastPose ? "observed_consistent" : "none" };
  }

  cancelPending(): void {
    // Writes are immediate; nothing is queued beyond the in-flight socket write.
    this.queue = [];
  }

  async stopAutomation(): Promise<void> {
    this.cancelPending();
  }

  async dispose(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
