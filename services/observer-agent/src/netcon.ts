import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState } from "@matchframe/contracts";
import type { ControlCapabilities, ObserverControlAdapter } from "@matchframe/director-policy";
import { failedResult, transportResult } from "@matchframe/director-policy";
import { accountIdOf, cap } from "./common.ts";
import { NetconConnection } from "./netcon-connection.ts";

/**
 * Console command templates for the direct channel. These are CANDIDATE mappings from semantic
 * operations to CS2 console commands. They have NOT been verified on a current CS2 build in this
 * project's test environment; every capability stays "unverified" until the setup checklist
 * confirms it with observed feedback (GSI spectated player) or operator confirmation.
 * Operators can edit them in Settings without recompiling.
 *
 * Player selection uses `spec_player "<name>"`: CS2 has no `spec_player_by_accountid` (CS:GO
 * only), and operators report the name form works. Placeholders: {name} (in-game name, see
 * safeName), {accountId}, {steamId}, {slot} (observer slot / number key).
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
  selectPlayer: 'spec_player "{name}"',
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
  /** The engine's shared console connection (also used for game options); otherwise the adapter opens its own. */
  connection?: NetconConnection;
  /**
   * The player's in-game name from the latest game data for the {name} placeholder; null when it
   * is unknown or another player has the same name (the console could not tell them apart).
   */
  playerName?: (steamId: string) => string | null;
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
 * A player name to put inside quotes in a console command. Refuses anything that could end the
 * quoted string or start another command (quotes, semicolons, backslashes, line breaks and other
 * control characters); such a name can't be selected through the console.
 */
export function safeName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("the player has no name in the game data");
  if (n.length > 128) throw new Error("the player's name is too long to send to the console");
  // eslint-disable-next-line no-control-regex
  if (/[";\\\u0000-\u001f\u007f]/.test(n)) throw new Error(`the player's name (${JSON.stringify(n)}) has characters that can't be sent to the console safely; switch to them in CS2 by hand`);
  return n;
}

/**
 * Direct observer channel over the game's TCP console (launch options `-tools -netconport <port>`;
 * in CS2 the console only opens with `-tools`, which needs the free CS2 Workshop Tools).
 * This is a documented Valve launch option, not memory reading or injection. It is loopback-only
 * by default because the console accepts arbitrary commands. Writes are transport acknowledgements;
 * confirmation must come from telemetry feedback.
 */
export class NetconObserverAdapter implements ObserverControlAdapter {
  readonly id: string;
  readonly kind = "direct" as const;
  readonly simulated = false;
  private readonly conn: NetconConnection;
  private readonly ownsConnection: boolean;
  private readonly offLine: () => void;
  private readonly templates: NetconTemplates;
  private lastPose: ObservedCameraState["pose"] = null;
  private lastPoseAt: number | null = null;

  constructor(private readonly opts: NetconOptions) {
    this.id = `netcon:${opts.host}:${opts.port}`;
    this.templates = { ...DEFAULT_NETCON_TEMPLATES, ...(opts.templates ?? {}) };
    this.ownsConnection = !opts.connection;
    this.conn = opts.connection ?? new NetconConnection({ host: opts.host, port: opts.port, connectTimeoutMs: opts.connectTimeoutMs ?? 1500 });
    this.offLine = this.conn.onLine((line) => this.onLine(line));
  }

  async getCapabilities(): Promise<ControlCapabilities> {
    const v = this.opts.verified ?? {};
    const lim = (what: string) => [`Command template for ${what} is a candidate mapping; verify with the setup checklist on the target CS2 build.`, "Requires the observer client launched with -tools -netconport (CS2 Workshop Tools; loopback only)."];
    const c = (key: keyof ControlCapabilities, what: string, also: string[] = []) =>
      v[key] ? cap(key, v[key]!.support, also, this.id, { build: v[key]!.build, at: v[key]!.at }) : cap(key, "unverified", [...lim(what), ...also], this.id);
    const byName = this.templates.selectPlayer.includes("{name}") ? ["Selects players by in-game name: names with quotes, semicolons or backslashes, and two players with the same name, can't be selected."] : [];
    return {
      playerSelectionControl: c("playerSelectionControl", "player selection", byName),
      observerModeControl: c("observerModeControl", "observer mode"),
      staticCameraControl: c("staticCameraControl", "static camera"),
      cameraPathControl: cap("cameraPathControl", "unsupported", ["No verified camera path mechanism for this channel."], this.id),
      cameraReadback: c("cameraReadback", "pose readback (getpos)"),
    };
  }

  private onLine(line: string): void {
    this.opts.onLine?.(line);
    const m = /setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(line);
    if (m) {
      this.lastPose = { position: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, pitch: Number(m[4]), yaw: Number(m[5]), fov: null };
      this.lastPoseAt = this.opts.now();
    }
  }

  private async send(ctx: CommandContext, command: string): Promise<CommandResult> {
    if (this.opts.now() > ctx.expiresAtMonotonicMs) return failedResult(ctx, "expired", "command expired before transport");
    try {
      await this.conn.ensure();
    } catch (e) {
      return failedResult(ctx, "transport_error", `netcon unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await this.conn.write(command);
      return transportResult(ctx, true, command, this.opts.now());
    } catch (e) {
      return failedResult(ctx, "transport_error", e instanceof Error ? e.message : "write failed");
    }
  }

  async selectPlayer(steamId: string, observerSlot: number | null, ctx: CommandContext): Promise<CommandResult> {
    let cmd: string;
    try {
      const values: Record<string, string | number> = { accountId: safeValue(accountIdOf(steamId)), steamId: safeValue(steamId), slot: safeValue(observerSlot ?? -1) };
      if (this.templates.selectPlayer.includes("{name}")) {
        const name = this.opts.playerName?.(steamId) ?? null;
        if (name === null) throw new Error("the player's name isn't known from the game data, or two players share it");
        values.name = safeName(name);
      }
      cmd = fill(this.templates.selectPlayer, values);
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
  }

  async stopAutomation(): Promise<void> {
    this.cancelPending();
  }

  async dispose(): Promise<void> {
    this.offLine();
    // A shared connection belongs to the engine (game options use it too).
    if (this.ownsConnection) this.conn.stop();
  }
}
