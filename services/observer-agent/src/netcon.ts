import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState, Vec3 } from "@matchframe/contracts";
import type { CameraMotion, ControlCapabilities, ObserverControlAdapter, PlayerView, PoseStream } from "@matchframe/director-policy";
import { failedResult, transportResult } from "@matchframe/director-policy";
import { accountIdOf, cap } from "./common.ts";
import { HLAE_KEY_STEP_MS, hlaeKeys, type HlaeCameraLink, type HlaeKey } from "./hlae-camera.ts";
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
 *
 * Cameras: `{free camera}; spec_goto x y z pitch yaw`; `getpos` answers `setpos x y z;setang pitch
 * yaw roll`, which confirms the pose. CS2 builds have used both the CS:GO spec_mode numbers
 * (in-eye 4, chase 5, free 6) and the CS2 ones (in-eye 2, chase 3, free 4); the three are always one
 * numbering. Until a camera is confirmed in a session, a camera getpos doesn't confirm is tried with
 * the other numbering's free camera, then with setpos/setang, and the first that works is kept.
 * Paths stream interpolated frames of the same command.
 */
export interface NetconTemplates {
  selectPlayer: string;
  modeInEye: string;
  modeChase: string;
  modeRoaming: string;
  /** {roaming} is the free-camera mode command (modeRoaming). */
  staticCamera: string;
  /** One frame of a camera path (already in the free camera). */
  pathFrame: string;
  readPose: string;
}

export const DEFAULT_NETCON_TEMPLATES: NetconTemplates = {
  selectPlayer: 'spec_player "{name}"',
  modeInEye: "spec_mode 4",
  modeChase: "spec_mode 5",
  modeRoaming: "spec_mode 6",
  staticCamera: "{roaming}; spec_goto {x} {y} {z} {pitch} {yaw}",
  pathFrame: "spec_goto {x} {y} {z} {pitch} {yaw}",
  readPose: "getpos",
};

/** The CS2 ObserverMode_t numbering, tried when the CS:GO numbers don't move the camera. */
export const CS2_ENUM_MODES = { modeInEye: "spec_mode 2", modeChase: "spec_mode 3", modeRoaming: "spec_mode 4" } as const;
/** CS:GO's numbering (the built-in default). */
const CSGO_MODES = { modeInEye: "spec_mode 4", modeChase: "spec_mode 5", modeRoaming: "spec_mode 6" } as const;
const STANDARD_MODES = new Set<string>([...Object.values(CSGO_MODES), ...Object.values(CS2_ENUM_MODES)]);
/** Moving the free camera with setpos/setang (what getpos prints), for a build where spec_goto doesn't move it. */
const SETPOS_WAY = { staticCamera: "{roaming}; setpos {x} {y} {z}; setang {pitch} {yaw} 0", pathFrame: "setpos {x} {y} {z}; setang {pitch} {yaw} 0" } as const;
/** CS2 console answers worth keeping in the director log: the ones that say a command didn't work. */
const FAILED_REPLY = /unknown command|can'?t use cheat|cheat command|sv_cheats|not (?:allowed|available)|usage:|invalid|not in (?:spectator|observer)/i;
/** The chase view puts the camera at least this far (across) from the player; first person is about 0. */
const CHASE_MIN_DISTANCE = 40;
/** Game data lags the console: just after a free-camera command it can still show the player from before. */
const FREE_FEEDBACK_MS = 1500;
/**
 * Leaving the free camera counts as failed only when the game data still shows the free camera this
 * long after the first try (a shorter wait misreads a camera that did leave as one that didn't).
 */
const LEAVE_FREE_VERDICT_MS = 2000;
const otherModes = (inEye: string) => (inEye === CS2_ENUM_MODES.modeInEye ? CSGO_MODES : CS2_ENUM_MODES);
/** A moving camera shot (slow pans and drifts) is sent this many poses a second, without keeping the engine busy between them. */
const MOTION_HZ = 64;

export interface PathPose {
  position: Vec3;
  pitch: number;
  yaw: number;
}

const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * The camera pose `tMs` into a path: eased in and out over the whole path, Catmull-Rom between
 * keyframes for position, shortest turn for yaw, linear pitch.
 */
export function samplePath(path: Pick<CameraPath, "keyframes">, tMs: number): PathPose {
  const k = path.keyframes;
  const dur = k[k.length - 1]!.tMs;
  const t = dur > 0 ? ease(tMs / dur) * dur : 0;
  let i = 0;
  while (i < k.length - 2 && t > k[i + 1]!.tMs) i++;
  const a = k[i]!;
  const b = k[Math.min(i + 1, k.length - 1)]!;
  const span = b.tMs - a.tMs;
  const u = span > 0 ? Math.min(1, Math.max(0, (t - a.tMs) / span)) : 1;
  const p0 = k[Math.max(0, i - 1)]!.position;
  const p3 = k[Math.min(k.length - 1, i + 2)]!.position;
  const cr = (q0: number, q1: number, q2: number, q3: number) => 0.5 * (2 * q1 + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
  return {
    position: { x: cr(p0.x, a.position.x, b.position.x, p3.x), y: cr(p0.y, a.position.y, b.position.y, p3.y), z: cr(p0.z, a.position.z, b.position.z, p3.z) },
    pitch: a.pitch + (b.pitch - a.pitch) * u,
    yaw: wrap180(a.yaw + wrap180(b.yaw - a.yaw) * u),
  };
}

/** Control evidence per capability, as recorded by the engine. */
export type VerifiedControl = Partial<Record<keyof ControlCapabilities, { build: string | null; at: string; support: "supported" | "partial" }>>;

export interface NetconOptions {
  host: string;
  port: number;
  templates?: Partial<NetconTemplates>;
  now: () => number;
  connectTimeoutMs?: number;
  /** Capability evidence recorded by the setup checklist (persisted by the engine). */
  /** Evidence recorded so far (a function reads the latest, e.g. evidence this adapter reported). */
  verified?: VerifiedControl | (() => VerifiedControl);
  onLine?: (line: string) => void;
  /** Every console line the adapter sends, except the frames of a playing camera path or follow cam. */
  onCommand?: (line: string) => void;
  /** The engine's shared console connection (also used for game options); otherwise the adapter opens its own. */
  connection?: NetconConnection;
  /**
   * The player's in-game name from the latest game data for the {name} placeholder; null when it
   * is unknown or another player has the same name (the console could not tell them apart).
   */
  playerName?: (steamId: string) => string | null;
  /** Evidence that a kind of control works, from getpos readback; the engine records it per game build. */
  onEvidence?: (key: keyof ControlCapabilities, support: "supported" | "partial", detail: string) => void;
  /** The spec_mode numbering that moved the camera (when it isn't the default); the engine keeps it. */
  onModesLearned?: (modes: Partial<NetconTemplates>) => void;
  /** CS2's console answers that say a command didn't work ("Unknown command", a cheat-protected command…). */
  onConsoleReply?: (line: string) => void;
  /**
   * The HLAE camera (see hlae-camera.ts): while its script is connected, every free-camera and
   * moving shot is played by HLAE, which sets the view every frame; the console commands below are
   * the fallback.
   */
  hlae?: HlaeCameraLink;
  /** Camera path frames per second. */
  pathHz?: number;
  /** How long to wait for a getpos answer. */
  readbackTimeoutMs?: number;
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
  readonly supportsChase = true;
  private readonly conn: NetconConnection;
  private readonly ownsConnection: boolean;
  private readonly offLine: () => void;
  private readonly templates: NetconTemplates;
  private lastPose: ObservedCameraState["pose"] = null;
  /** A shot HLAE is drawing (released when the next command or a cut stops it). */
  private hlaeActive = false;
  private lastPoseAt: number | null = null;
  private poseSeq = 0;
  /** The camera is in the free camera (after a static camera or path, or as the game data shows). */
  private freeCam = false;
  /** When the last free-camera command was sent (monotonic ms). */
  private freeAt = -Infinity;
  private telemetryRoaming = false;
  /**
   * Leaving the free camera, until the game data shows a player: when the tries began, and the in-eye
   * command they use (switched to the other numbering when the first doesn't leave).
   */
  private leaving: { since: number; modeInEye: string } | null = null;
  private pathTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null = null;
  private pathToken = 0;
  /** A way of moving the free camera (mode command and spec_goto or setpos) getpos confirmed this session. */
  private cameraLearned = false;
  /** A free-camera command was sent and no first-person one since: the next player selection leaves it. */
  private sentFree = false;
  private replyTimes: number[] = [];
  private chaseLearned = false;
  /** The camera is in the third-person chase view of a player. */
  private chase = false;
  /** The latest observer state from the game data; `seq` counts updates. */
  private observed: { cameraMode: string; observedSteamId: string | null; position: { x: number; y: number; z: number } | null; seq: number } = { cameraMode: "unknown", observedSteamId: null, position: null, seq: 0 };

  constructor(private readonly opts: NetconOptions) {
    this.id = `netcon:${opts.host}:${opts.port}`;
    this.templates = { ...DEFAULT_NETCON_TEMPLATES, ...(opts.templates ?? {}) };
    this.ownsConnection = !opts.connection;
    this.conn = opts.connection ?? new NetconConnection({ host: opts.host, port: opts.port, connectTimeoutMs: opts.connectTimeoutMs ?? 1500 });
    this.offLine = this.conn.onLine((line) => this.onLine(line));
    this.normalizeNumbering();
  }

  /**
   * The three spec_mode commands are one numbering (CS:GO: 4/5/6, CS2: 2/3/4). Saved templates that
   * mix them (a learned CS2 first-person or chase command next to CS:GO's free camera "spec_mode 6",
   * which CS2 doesn't have: the camera then stays at the player and spec_goto is ignored) are set to
   * the numbering a CS2-only command shows. Templates edited by hand to other commands are left alone.
   */
  private normalizeNumbering(): void {
    const t = this.templates;
    if (![t.modeInEye, t.modeChase, t.modeRoaming].every((m) => STANDARD_MODES.has(m))) return;
    const set = t.modeInEye === CS2_ENUM_MODES.modeInEye || t.modeChase === CS2_ENUM_MODES.modeChase ? CS2_ENUM_MODES : CSGO_MODES;
    if (t.modeInEye === set.modeInEye && t.modeChase === set.modeChase && t.modeRoaming === set.modeRoaming) return;
    this.applyNumbering(set);
  }

  /** Uses one numbering for all three mode commands, and saves it. */
  private applyNumbering(set: { modeInEye: string; modeChase: string; modeRoaming: string }): void {
    this.templates.modeInEye = set.modeInEye;
    this.templates.modeChase = set.modeChase;
    this.templates.modeRoaming = set.modeRoaming;
    this.opts.onModesLearned?.({ modeInEye: set.modeInEye, modeChase: set.modeChase, modeRoaming: set.modeRoaming });
  }

  async getCapabilities(): Promise<ControlCapabilities> {
    const v = (typeof this.opts.verified === "function" ? this.opts.verified() : this.opts.verified) ?? {};
    const lim = (what: string) => [`Command template for ${what} is a candidate mapping; verify with the setup checklist on the target CS2 build.`, "Requires the observer client launched with -tools -netconport (CS2 Workshop Tools; loopback only)."];
    const c = (key: keyof ControlCapabilities, what: string, also: string[] = []) =>
      v[key] ? cap(key, v[key]!.support, also, this.id, { build: v[key]!.build, at: v[key]!.at }) : cap(key, "unverified", [...lim(what), ...also], this.id);
    const byName = this.templates.selectPlayer.includes("{name}") ? ["Selects players by in-game name: names with quotes, semicolons or backslashes, and two players with the same name, can't be selected."] : [];
    return {
      playerSelectionControl: c("playerSelectionControl", "player selection", byName),
      observerModeControl: c("observerModeControl", "observer mode"),
      staticCameraControl: c("staticCameraControl", "static camera", ["Confirmed by getpos readback the first time a camera is shown."]),
      cameraPathControl:
        !v.cameraPathControl && v.staticCameraControl?.support === "supported"
          ? // Paths stream the spec_goto command the static camera test confirmed.
            cap("cameraPathControl", "partial", ["Streams the spec_goto command getpos confirmed for static cameras; confirmed again at the end of the first path."], this.id, { build: v.staticCameraControl.build, at: v.staticCameraControl.at })
          : c("cameraPathControl", "camera paths (spec_goto streamed)", ["Confirmed by getpos readback at the end of the first path."]),
      cameraReadback: c("cameraReadback", "pose readback (getpos)"),
    };
  }

  private onLine(line: string): void {
    this.opts.onLine?.(line);
    if (FAILED_REPLY.test(line) && !/^\s*setpos/.test(line)) {
      // At most 20 a minute in the director log.
      const now = this.opts.now();
      this.replyTimes = this.replyTimes.filter((t) => now - t < 60_000);
      if (this.replyTimes.length < 20) {
        this.replyTimes.push(now);
        this.opts.onConsoleReply?.(line.trim().slice(0, 300));
      }
    }
    const m = /setpos(?:_exact)?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(line);
    if (m) {
      this.lastPose = { position: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, pitch: Number(m[4]), yaw: Number(m[5]), fov: null };
      this.lastPoseAt = this.opts.now();
      this.poseSeq++;
    }
  }

  /** Observer state from the game data: lets player selection leave the free camera first. */
  noteObserverState(observer: { cameraMode: string; observedSteamId: string | null; observedPosition?: { x: number; y: number; z: number } | null }): void {
    this.telemetryRoaming = observer.cameraMode === "roaming" && !observer.observedSteamId;
    // A player in game data from just after a free-camera command is from before it: still free.
    if (observer.observedSteamId && !this.pathTimer && this.opts.now() - this.freeAt > FREE_FEEDBACK_MS) this.freeCam = false;
    const l = this.leaving;
    if (l && observer.observedSteamId) {
      // Out of the free camera: the in-eye command that did it is the one for this build.
      this.leaving = null;
      if (l.modeInEye !== this.templates.modeInEye) this.applyNumbering(l.modeInEye === CS2_ENUM_MODES.modeInEye ? CS2_ENUM_MODES : CSGO_MODES);
    }
    this.observed = { cameraMode: observer.cameraMode, observedSteamId: observer.observedSteamId, position: observer.observedPosition ?? null, seq: this.observed.seq + 1 };
  }

  /** A free-camera command was sent: the camera is free now, whatever older game data says. */
  private wentFree(): void {
    this.freeCam = true;
    this.sentFree = true;
    this.freeAt = this.opts.now();
    this.leaving = null;
  }

  /**
   * The in-eye command for leaving the free camera now. Tries keep the same command until the game
   * data has shown the free camera for LEAVE_FREE_VERDICT_MS since the first; then the other spec_mode
   * numbering is tried for as long again, and so on. The first one the game data confirms (it shows
   * the player) is kept, also over a numbering learned earlier.
   */
  private leaveFreeMode(): string {
    const now = this.opts.now();
    const l = this.leaving;
    if (!l) {
      this.leaving = { since: now, modeInEye: this.templates.modeInEye };
      return this.templates.modeInEye;
    }
    if (this.telemetryRoaming && now - l.since >= LEAVE_FREE_VERDICT_MS) {
      l.modeInEye = otherModes(l.modeInEye).modeInEye;
      l.since = now;
    }
    return l.modeInEye;
  }

  private write(line: string): Promise<void> {
    this.opts.onCommand?.(line);
    return this.conn.write(line);
  }

  /** Asks getpos where the camera is; null without an answer in time. */
  private async readPose(): Promise<PathPose | null> {
    const seq = this.poseSeq;
    try {
      await this.write(this.templates.readPose);
    } catch {
      return null;
    }
    const end = Date.now() + (this.opts.readbackTimeoutMs ?? 800);
    while (this.poseSeq === seq && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return this.poseSeq === seq ? null : this.lastPose;
  }

  /** How far (across) the camera is from the spectated player: about 0 in first person, well behind in the chase view. */
  private async chaseDistance(steamId: string): Promise<number | null> {
    if ((await this.waitObserved(steamId, 1000)) !== "player") return null;
    await new Promise((r) => setTimeout(r, 120));
    const pose = await this.readPose();
    const at = this.observed.position;
    if (!pose || !at) return null;
    return Math.hypot(pose.position.x - at.x, pose.position.y - at.y);
  }

  /**
   * After the first chase shot: getpos shows whether the camera really went behind the player. If it
   * stayed in first person, the chase command uses the other spec_mode numbering on this build: try
   * that once, and keep it if it works.
   */
  private async learnChase(steamId: string, token: number): Promise<void> {
    const d = await this.chaseDistance(steamId);
    if (d === null || token !== this.pathToken) return;
    if (d >= CHASE_MIN_DISTANCE) {
      this.chaseLearned = true;
      this.opts.onEvidence?.("observerModeControl", "supported", `getpos showed the chase view ${Math.round(d)} units behind the player (${this.templates.modeChase})`);
      return;
    }
    const alt = this.templates.modeChase === CS2_ENUM_MODES.modeChase ? CSGO_MODES.modeChase : CS2_ENUM_MODES.modeChase;
    try {
      await this.write(alt);
    } catch {
      return;
    }
    const d2 = await this.chaseDistance(steamId);
    if (token !== this.pathToken) return;
    if (d2 !== null && d2 >= CHASE_MIN_DISTANCE) {
      this.chaseLearned = true;
      if (STANDARD_MODES.has(this.templates.modeInEye) && STANDARD_MODES.has(this.templates.modeRoaming)) this.applyNumbering(alt === CS2_ENUM_MODES.modeChase ? CS2_ENUM_MODES : CSGO_MODES);
      else {
        this.templates.modeChase = alt;
        this.opts.onModesLearned?.({ modeChase: alt });
      }
      this.opts.onEvidence?.("observerModeControl", "supported", `getpos showed the chase view ${Math.round(d2)} units behind the player (${alt})`);
      return;
    }
    // Neither number moved the camera behind the player: back to the original command.
    await this.write(this.templates.modeChase).catch(() => undefined);
  }

  /** Waits for game data showing the player, or a fresh update (at least 300 ms after the command) still in the free camera. */
  private async waitObserved(steamId: string, ms: number): Promise<"player" | "free" | "other" | "none"> {
    const seq = this.observed.seq;
    const start = Date.now();
    while (Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 40));
      if (this.observed.seq === seq) continue;
      if (this.observed.observedSteamId === steamId) return "player";
      if (Date.now() - start >= 300 && this.observed.cameraMode === "roaming" && !this.observed.observedSteamId) return "free";
    }
    if (this.observed.seq === seq) return "none";
    if (this.observed.observedSteamId === steamId) return "player";
    return this.observed.cameraMode === "roaming" && !this.observed.observedSteamId ? "free" : "other";
  }

  private cameraCommand(pose: PathPose, template = this.templates.staticCamera, roaming = this.templates.modeRoaming): string {
    return fill(template, { roaming, x: safeValue(pose.position.x), y: safeValue(pose.position.y), z: safeValue(pose.position.z), pitch: safeValue(pose.pitch), yaw: safeValue(pose.yaw) });
  }

  /**
   * CS2 switches to the free camera on a later tick: a spec_goto on the same line as the switch
   * can arrive while the camera still follows the player, and is dropped. The free camera then
   * starts where the player stands (in the ground under them). So the position is sent again a
   * few times over the next ~300 ms (harmless once it has landed).
   */
  /**
   * The ways of putting the free camera at a pose, in order: the one in use first; until one is
   * confirmed this session, then the other numbering's free-camera command, and setpos/setang (what
   * getpos prints) with each.
   */
  private cameraWays(): { roaming: string; staticCamera: string; pathFrame: string }[] {
    const cur = { roaming: this.templates.modeRoaming, staticCamera: this.templates.staticCamera, pathFrame: this.templates.pathFrame };
    if (this.cameraLearned) return [cur];
    const out = [cur];
    const other = !STANDARD_MODES.has(cur.roaming) ? null : cur.roaming === CS2_ENUM_MODES.modeRoaming ? CSGO_MODES.modeRoaming : CS2_ENUM_MODES.modeRoaming;
    if (other) out.push({ ...cur, roaming: other });
    if (cur.staticCamera !== SETPOS_WAY.staticCamera) {
      out.push({ roaming: cur.roaming, ...SETPOS_WAY });
      if (other) out.push({ roaming: other, ...SETPOS_WAY });
    }
    return out;
  }

  /** Keeps the way getpos confirmed: its numbering for all mode commands, and its move command. */
  private learnCameraWay(way: { roaming: string; staticCamera: string; pathFrame: string }): void {
    if (way.roaming !== this.templates.modeRoaming) this.applyNumbering(way.roaming === CS2_ENUM_MODES.modeRoaming ? CS2_ENUM_MODES : CSGO_MODES);
    if (way.staticCamera !== this.templates.staticCamera) {
      this.templates.staticCamera = way.staticCamera;
      this.templates.pathFrame = way.pathFrame;
      this.opts.onModesLearned?.({ staticCamera: way.staticCamera, pathFrame: way.pathFrame });
    }
  }

  /** After a camera that didn't move: the first-person command, so the view is on a player again. */
  private async returnToPlayer(): Promise<void> {
    try {
      await this.write(this.leaveFreeMode());
      this.sentFree = false;
    } catch {
      // the next player selection leaves the free camera
    }
  }

  private async repeatGoto(pose: PathPose, token: number, afterMs: readonly number[] = [50, 150, 300], frame = this.templates.pathFrame): Promise<void> {
    let waited = 0;
    for (const at of afterMs) {
      await new Promise((r) => setTimeout(r, Math.max(0, at - waited)));
      waited = at;
      if (token !== this.pathToken) return;
      try {
        // Like the moving shots' frames: sent, not written to the director log line by line.
        await this.conn.write(this.cameraCommand(pose, frame));
      } catch {
        return;
      }
    }
  }

  /** Asks getpos and compares the answer with where the camera was sent. */
  /**
   * Where the camera is now, from CS2's `getpos` (what you see in the game): saving the current view
   * as a camera. Null when CS2 doesn't answer.
   */
  async readPose(): Promise<{ position: Vec3; pitch: number; yaw: number } | null> {
    const seq = this.poseSeq;
    try {
      await this.write(this.templates.readPose);
    } catch {
      return null;
    }
    const deadline = Date.now() + (this.opts.readbackTimeoutMs ?? 800);
    while (this.poseSeq === seq && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const p = this.lastPose;
    return this.poseSeq === seq || !p ? null : { position: { ...p.position }, pitch: p.pitch, yaw: p.yaw };
  }

  private async readback(pose: PathPose): Promise<"match" | "mismatch" | "none"> {
    const seq = this.poseSeq;
    await new Promise((r) => setTimeout(r, 60));
    try {
      await this.write(this.templates.readPose);
    } catch {
      return "none";
    }
    const deadline = Date.now() + (this.opts.readbackTimeoutMs ?? 800);
    while (this.poseSeq === seq && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const p = this.lastPose;
    if (this.poseSeq === seq || !p) return "none";
    const dxy = Math.hypot(p.position.x - pose.position.x, p.position.y - pose.position.y);
    const dz = Math.abs(p.position.z - pose.position.z);
    const ok = dxy <= 16 && dz <= 72 && Math.abs(wrap180(p.pitch - pose.pitch)) <= 3 && Math.abs(wrap180(p.yaw - pose.yaw)) <= 3;
    return ok ? "match" : "mismatch";
  }

  private confirmed(ctx: CommandContext, detail: string): CommandResult {
    const now = this.opts.now();
    return { commandId: ctx.commandId, status: "confirmed", precision: "observed_exact", failureReason: null, detail, transportAckAtMonotonicMs: now, confirmedAtMonotonicMs: now };
  }

  private stopPath(): void {
    this.pathToken++;
    if (this.hlaeActive) {
      this.hlaeActive = false;
      this.opts.hlae?.release();
    }
    if (this.pathTimer) {
      clearTimeout(this.pathTimer as ReturnType<typeof setTimeout>);
      clearImmediate(this.pathTimer as ReturnType<typeof setImmediate>);
    }
    this.pathTimer = null;
  }

  /**
   * Calls `frame(elapsedMs)` about 128 times a second, evenly spaced, until it returns false or the
   * path is stopped. Every pose is a jump in the game, so the camera glides only when poses come
   * evenly and faster than the recording's frames: Windows timers tick every 15.6 ms, which gave
   * uneven 64-a-second poses (judder). The loop waits with setImmediate between frames (busy while a
   * path or follow cam plays; it still serves the game data and HUDs between frames).
   *
   * `gentle`: MOTION_HZ poses a second, waiting on timers between them (the engine is idle between
   * frames). For slow moves (a pan of a few degrees a second, a drift of a few units a second) each
   * step is far below a pixel, so uneven timer ticks don't show.
   */
  private runFrames(token: number, frame: (elapsedMs: number) => boolean, gentle = false): void {
    const start = performance.now();
    const gap = 1000 / (gentle ? MOTION_HZ : (this.opts.pathHz ?? 128));
    let next = start;
    const tick = () => {
      if (token !== this.pathToken) return;
      const now = performance.now();
      if (now >= next) {
        // Late by more than a frame (the engine was busy): carry on from now, without a burst.
        next = Math.max(next + gap, now + gap * 0.5);
        if (!frame(now - start)) return;
      }
      const wait = next - performance.now();
      this.pathTimer = gentle ? setTimeout(tick, Math.max(0, wait)) : wait > 20 ? setTimeout(tick, wait - 16) : setImmediate(tick);
    };
    tick();
  }

  /**
   * Moves the camera along `motion` (from the pose it was shown at), until the shot's planned end or
   * the next command; it then stays where the move ended. Matchframe sends every pose: CS2's own
   * turning commands can't be used (+left/+right strafe the camera sideways in CS2).
   */
  private playMotion(motion: CameraMotion, token: number): void {
    let last: string | null = null;
    this.runFrames(
      token,
      (elapsed) => {
        const t = Math.min(motion.durationMs, elapsed);
        const pose = motion.pose(t);
        if (!pose) {
          this.stopPath();
          return false;
        }
        try {
          const cmd = this.cameraCommand(pose, this.templates.pathFrame);
          // A still stretch of the move sends nothing.
          if (cmd !== last) void this.conn.write(cmd).catch(() => this.stopPath());
          last = cmd;
        } catch {
          this.stopPath();
          return false;
        }
        if (t < motion.durationMs) return true;
        this.stopPath();
        return false;
      },
      true,
    );
  }

  private async send(ctx: CommandContext, command: string): Promise<CommandResult> {
    if (this.opts.now() > ctx.expiresAtMonotonicMs) return failedResult(ctx, "expired", "command expired before transport");
    try {
      await this.conn.ensure();
    } catch (e) {
      return failedResult(ctx, "transport_error", `netcon unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await this.write(command);
      return transportResult(ctx, true, command, this.opts.now());
    } catch (e) {
      return failedResult(ctx, "transport_error", e instanceof Error ? e.message : "write failed");
    }
  }

  async selectPlayer(steamId: string, observerSlot: number | null, ctx: CommandContext, view: PlayerView = "in_eye"): Promise<CommandResult> {
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
    this.stopPath();
    // spec_player in the free camera only moves the free camera, and it keeps the chase view:
    // first person is set first when leaving either; the chase view is set after the player.
    // Also when Matchframe sent the free camera and no first-person command since: on some builds the
    // game data still names the player in the free camera, and spec_player alone doesn't leave it.
    const leaveFree = this.freeCam || this.telemetryRoaming || this.sentFree;
    const chase = view === "chase";
    // Into first person from the free camera: the in-eye command that the game data confirms on this build.
    // (Out of it into the chase view, the chase command moves the camera: that says nothing about in-eye.)
    if (chase) this.leaving = null;
    const inEye = leaveFree && !chase ? this.leaveFreeMode() : this.templates.modeInEye;
    const prefix = leaveFree || (this.chase && !chase) ? `${inEye}; ` : "";
    const suffix = chase ? `; ${this.templates.modeChase}` : "";
    const r = await this.send(ctx, `${prefix}${cmd}${suffix}`);
    if (r.status !== "failed") {
      this.freeCam = false;
      this.sentFree = false;
      this.chase = chase;
      if (chase && !this.chaseLearned) void this.learnChase(steamId, this.pathToken);
    }
    return r;
  }

  async setObserverMode(mode: CameraMode, ctx: CommandContext): Promise<CommandResult> {
    const t = mode === "in_eye" ? this.templates.modeInEye : mode === "chase" ? this.templates.modeChase : mode === "roaming" ? this.templates.modeRoaming : null;
    if (!t) return failedResult(ctx, "unsupported", `mode ${mode} has no template`);
    return this.send(ctx, t);
  }

  async activateStaticCamera(camera: CameraRecord, ctx: CommandContext, motion?: CameraMotion): Promise<CommandResult> {
    // A moving shot is shown at its first pose, confirmed there, then moved.
    const pose: PathPose = motion?.pose(0) ?? { position: camera.position, pitch: camera.pitch, yaw: camera.yaw };
    let cmd: string;
    try {
      cmd = this.cameraCommand(pose);
    } catch (e) {
      return failedResult(ctx, "target_invalid", e instanceof Error ? e.message : String(e));
    }
    const viaHlae = await this.hlaeShot(ctx, cmd, motion && motion.durationMs > 0 ? hlaeKeys(motion.pose, motion.durationMs) : hlaeKeys(() => pose, 0), `camera ${camera.id}`);
    if (viaHlae) return viaHlae;
    this.stopPath();
    const token = this.pathToken;
    let first: CommandResult | null = null;
    let check: "match" | "mismatch" | "none" = "none";
    const ways = this.cameraWays();
    for (const [i, way] of ways.entries()) {
      if (token !== this.pathToken) break;
      const r = await this.send(ctx, i === 0 ? cmd : this.cameraCommand(pose, way.staticCamera, way.roaming));
      if (r.status === "failed") return r;
      first ??= r;
      this.wentFree();
      await this.repeatGoto(pose, token, undefined, way.pathFrame);
      check = await this.readback(pose);
      if (check === "mismatch" && i === 0 && token === this.pathToken) {
        // Still where the free camera started: the switch took longer.
        await this.repeatGoto(pose, token, [0, 200], way.pathFrame);
        check = await this.readback(pose);
      }
      if (check === "match" && i > 0) this.learnCameraWay(way);
      if (check !== "mismatch") break;
    }
    if (check === "mismatch") {
      // Never left away from the players (at the player's feet, or a mode spec_player can't leave):
      // back to first person, and failed, so the director goes on with a player.
      const at = this.lastPose ? ` (getpos: ${Math.round(this.lastPose.position.x)} ${Math.round(this.lastPose.position.y)} ${Math.round(this.lastPose.position.z)})` : "";
      await this.returnToPlayer();
      return failedResult(ctx, "confirmation_timeout", `the camera did not move to camera ${camera.id}${at}`);
    }
    const r = first!;
    if (check !== "match") return r;
    this.cameraLearned = true;
    // Moved only while this is still the latest command (another one stops the move).
    if (motion && motion.durationMs > 0 && token === this.pathToken) this.playMotion(motion, token);
    this.opts.onEvidence?.("staticCameraControl", "supported", `getpos confirmed camera ${camera.id}`);
    this.opts.onEvidence?.("cameraReadback", "supported", "getpos answered with the camera pose");
    this.opts.onEvidence?.("observerModeControl", "partial", `free camera with ${this.templates.modeRoaming}`);
    return this.confirmed(ctx, `getpos confirmed the camera pose (${this.templates.modeRoaming})`);
  }

  /** Streams the path as spec_goto frames; getpos at the end confirms where it finished. */
  async playCameraPath(path: CameraPath, ctx: CommandContext): Promise<CommandResult> {
    const first = samplePath(path, 0);
    let cmd: string;
    try {
      cmd = this.cameraCommand(first);
    } catch (e) {
      return failedResult(ctx, "target_invalid", e instanceof Error ? e.message : String(e));
    }
    const pathMs = path.keyframes[path.keyframes.length - 1]!.tMs;
    const viaHlae = await this.hlaeShot(ctx, cmd, hlaeKeys((t) => samplePath(path, t), pathMs), `path ${path.id}`);
    if (viaHlae) return viaHlae;
    this.stopPath();
    const r = await this.send(ctx, cmd);
    if (r.status === "failed") return r;
    this.wentFree();
    const token = this.pathToken;
    const dur = path.keyframes[path.keyframes.length - 1]!.tMs;
    const last = samplePath(path, dur);
    this.runFrames(token, (elapsed) => {
      const t = Math.min(dur, elapsed);
      try {
        void this.conn.write(this.cameraCommand(samplePath(path, t), this.templates.pathFrame)).catch(() => this.stopPath());
      } catch {
        this.stopPath();
        return false;
      }
      if (t < dur) return true;
      this.stopPath();
      void this.readback(last).then((res) => {
        if (res === "match") this.opts.onEvidence?.("cameraPathControl", "supported", `getpos confirmed the end of path ${path.id}`);
      });
      return false;
    });
    return r;
  }

  /**
   * A shot through the HLAE camera, when its script is connected: CS2's own free camera is put at
   * the first pose too (the game data then shows the free camera, and the sound is there), unchecked,
   * and HLAE draws the shot from `keys`, every frame. Confirmed when HLAE draws its first frame; null
   * when HLAE isn't there or doesn't answer within a second, and the console way is used instead.
   */
  private async hlaeShot(ctx: CommandContext, consoleCmd: string, keys: HlaeKey[], what: string): Promise<CommandResult | null> {
    const link = this.opts.hlae;
    if (!link?.connected() || keys.length === 0) return null;
    this.stopPath();
    const token = this.pathToken;
    // HLAE draws the shot either way; the console only places CS2's own camera.
    if ((await this.send(ctx, consoleCmd)).status !== "failed") this.wentFree();
    const shown = await link.play(keys, { timeoutMs: 1000 });
    if (!shown || token !== this.pathToken) {
      if (!shown) link.release();
      return null;
    }
    this.hlaeActive = true;
    this.cameraLearned = true;
    this.opts.onEvidence?.("staticCameraControl", "supported", `HLAE showed ${what}`);
    this.opts.onEvidence?.("cameraPathControl", "supported", "HLAE draws camera moves every frame");
    return this.confirmed(ctx, `HLAE shows ${what}`);
  }

  /**
   * Follow cam: the first pose as a static camera (the free camera), then spec_goto ~64 times a
   * second to wherever `poses` says, until it returns null or `durationMs` passes. A player
   * selection or another camera stops it, like a path.
   */
  async streamCamera(poses: PoseStream, durationMs: number, ctx: CommandContext): Promise<CommandResult> {
    const first = poses(0);
    if (!first) return failedResult(ctx, "target_invalid", "no pose to start from");
    let cmd: string;
    try {
      cmd = this.cameraCommand(first);
    } catch (e) {
      return failedResult(ctx, "target_invalid", e instanceof Error ? e.message : String(e));
    }
    const viaHlae = await this.hlaeShot(ctx, cmd, hlaeKeys(() => first, 0), "a moving shot");
    if (viaHlae) {
      // Poses computed live: HLAE eases the view towards each one, every frame.
      const link = this.opts.hlae!;
      let sentAt = -Infinity;
      this.runFrames(this.pathToken, (t) => {
        const pose = t <= durationMs ? poses(t) : null;
        if (!pose) return false;
        if (t - sentAt >= HLAE_KEY_STEP_MS) {
          sentAt = t;
          link.live(pose);
        }
        return true;
      }, true);
      return viaHlae;
    }
    this.stopPath();
    const r = await this.send(ctx, cmd);
    if (r.status === "failed") return r;
    this.wentFree();
    const token = this.pathToken;
    this.runFrames(token, (t) => {
      const pose = t <= durationMs ? poses(t) : null;
      if (!pose) {
        this.stopPath();
        return false;
      }
      try {
        void this.conn.write(this.cameraCommand(pose, this.templates.pathFrame)).catch(() => this.stopPath());
        return true;
      } catch {
        this.stopPath();
        return false;
      }
    });
    return r;
  }

  async cancelPath(ctx: CommandContext): Promise<CommandResult> {
    this.stopPath();
    return transportResult(ctx, true, "path stopped", this.opts.now());
  }

  /** True while a camera path is playing. */
  get playingPath(): boolean {
    return this.pathTimer !== null;
  }

  /** Requests a pose readback; the answer arrives asynchronously via console output. */
  async requestPose(ctx: CommandContext): Promise<CommandResult> {
    return this.send(ctx, this.templates.readPose);
  }

  async readState(): Promise<ObservedCameraState> {
    return { observedSteamId: null, observedSlot: null, mode: "unknown", pose: this.lastPose, observedAtMonotonicMs: this.lastPoseAt, precision: this.lastPose ? "observed_consistent" : "none" };
  }

  cancelPending(): void {
    // Writes are immediate; a playing path is the only queued work.
    this.stopPath();
  }

  async stopAutomation(): Promise<void> {
    this.cancelPending();
  }

  async dispose(): Promise<void> {
    this.stopPath();
    this.offLine();
    // A shared connection belongs to the engine (game options use it too).
    if (this.ownsConnection) this.conn.stop();
  }
}
