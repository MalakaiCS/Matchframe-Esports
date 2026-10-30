import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MatchState, Team } from "@matchframe/contracts";
import type { Cs2Install } from "@matchframe/game-adapters";
import { NetconConnection, type NetconStatus } from "@matchframe/observer-agent";
import type { DocumentRepo, SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";

/**
 * Start CS2 from the program, and CS2's console while it runs.
 *
 * - standard: CS2 through Steam with the GSI config in place. Game data only.
 * - tools: adds `-tools -netconport <port>` (needs the free CS2 Workshop Tools). Matchframe connects
 *   to the game's console on loopback for camera control and the console options below.
 * - hlae: the same through HLAE (advancedfx) with `-insecure`, which adds HLAE's console commands
 *   (no flash, killfeed colours, no end-of-match scene). Insecure clients cannot join VAC-secured
 *   servers (they need `tv_secure_bypass 1`); HLAE on a VAC-secured server risks a VAC ban.
 *
 * Only commands from a fixed list are sent, filled with validated values.
 */

export const GameLaunchMode = z.enum(["standard", "tools", "hlae"]);
export type GameLaunchMode = z.infer<typeof GameLaunchMode>;

/** Launch options the operator may add; Matchframe manages the console and security flags itself. */
const MANAGED_ARGS = new Set(["-tools", "-netconport", "-insecure", "-steam"]);
const ARG = /^(?:[-+][A-Za-z0-9_.]+|[A-Za-z0-9_.:/-]+)$/;

export function parseExtraArgs(text: string): { args: string[]; error: string | null } {
  const args = text.trim() ? text.trim().split(/\s+/) : [];
  for (const a of args) {
    if (!ARG.test(a)) return { args: [], error: `"${a}" is not allowed in launch options (letters, digits, and - + _ . : / only)` };
    if (MANAGED_ARGS.has(a.toLowerCase())) return { args: [], error: `${a} is set by the launch mode; remove it from the extra launch options` };
  }
  return { args, error: null };
}

export const GameLaunchProfile = z.object({
  mode: GameLaunchMode.default("standard"),
  netconPort: z.number().int().min(1024).max(65535).default(2121),
  extraArgs: z
    .string()
    .max(400)
    .default("")
    .refine((t) => parseExtraArgs(t).error === null, { message: "invalid extra launch options" }),
  /** When the operator accepted the HLAE warning (-insecure, VAC); required for the HLAE mode. */
  insecureAcknowledgedAt: z.string().nullable().default(null),
});
export type GameLaunchProfile = z.infer<typeof GameLaunchProfile>;

export const ConsoleOptions = z.object({
  /** `cl_draw_only_deathnotices 1`: the game's HUD shows only the kill feed (your HUD shows the rest). */
  hideGameHud: z.boolean().default(true),
  /**
   * `spec_show_xray`: players seen through walls while spectating (the game's default is on), with
   * the players' names above them going with it (`hud_showtargetid`, and
   * `cl_drawhud_force_teamid_overhead`, which shows them also with only the kill feed drawn).
   */
  xray: z.boolean().default(true),
  /**
   * X-ray (and the names) off while one player is alone against two or more in a live round, until
   * the round ends: the viewer doesn't see the opponents coming, so a won clutch looks like magic.
   */
  clutchXrayOff: z.boolean().default(true),
  /**
   * X-ray (and the names) off for a retake (retakeUnderway): after the plant, once the CTs go for
   * the bomb with time to defuse, until the round ends. The viewer doesn't see where the Ts wait.
   */
  retakeXrayOff: z.boolean().default(true),
  /**
   * `engine_no_focus_sleep 0; snd_mute_losefocus 0`: CS2 keeps drawing every frame and playing its
   * sound while Matchframe, OBS or another window has focus (by default it slows down and goes silent).
   */
  runInBackground: z.boolean().default(true),
  /**
   * `fps_max`: CS2 draws at most this many frames a second, leaving the graphics card room for the
   * HUD, OBS and the encoder (uncapped on high settings, CS2 takes the whole card and an LHM HUD like
   * kaiHUD stutters). Null: CS2's own setting is left alone.
   */
  frameCap: z.number().int().min(30).max(1000).nullable().default(null),
  /** HLAE `mirv_noflash 1`: no white-out from flashbangs on the observer's screen. */
  noFlash: z.boolean().default(false),
  /** HLAE `mirv_deathmsg colors`: CT and T names in the kill feed in the teams' colours. */
  killfeedTeamColours: z.boolean().default(false),
  /** HLAE `mirv_endofmatch 0`: no end-of-match scene over the game. */
  hideEndOfMatch: z.boolean().default(false),
  /**
   * HLAE `mirv_deathmsg filter add block=1`: CS2's own kill feed is blocked, so only the HUD's kill
   * feed shows. With Hide game HUD (`cl_draw_only_deathnotices 1`) the crosshair still shows.
   */
  hideGameKillfeed: z.boolean().default(false),
});
export type ConsoleOptions = z.infer<typeof ConsoleOptions>;

/** A change to some options. Keys that are left out keep their value: nothing is filled with defaults. */
export const ConsoleOptionsPatch = z.object({
  hideGameHud: z.boolean().optional(),
  xray: z.boolean().optional(),
  clutchXrayOff: z.boolean().optional(),
  retakeXrayOff: z.boolean().optional(),
  runInBackground: z.boolean().optional(),
  frameCap: z.number().int().min(30).max(1000).nullable().optional(),
  noFlash: z.boolean().optional(),
  killfeedTeamColours: z.boolean().optional(),
  hideEndOfMatch: z.boolean().optional(),
  hideGameKillfeed: z.boolean().optional(),
});
export type ConsoleOptionsPatch = z.infer<typeof ConsoleOptionsPatch>;

export interface SideColours {
  ct: string | null;
  t: string | null;
}

const rgba = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} 255`;
};
const HEX = /^#[0-9a-fA-F]{6}$/;

export function killfeedColourCommands(on: boolean, colours: SideColours): string[] {
  const one = (side: "ct" | "t", hex: string | null) => `mirv_deathmsg colors ${side} ${on && hex && HEX.test(hex) ? rgba(hex) : "default"}`;
  return [one("ct", colours.ct), one("t", colours.t)];
}

/**
 * X-ray and the names above the players, together. `cl_drawhud_force_teamid_overhead 1` draws the
 * names (team overhead) even with `cl_draw_only_deathnotices 1`; 0 hides them.
 */
export function xrayCommands(on: boolean): string[] {
  return [`spec_show_xray ${on ? 1 : 0}`, `hud_showtargetid ${on ? 1 : 0}`, `cl_drawhud_force_teamid_overhead ${on ? 1 : 0}`];
}

/**
 * The player alone against two or more opponents in a live round, or null. Coaches and anyone dead
 * don't count.
 */
export function clutchPlayer(state: MatchState): MatchState["players"][number] | null {
  if (state.roundPhase !== "live") return null;
  const alive = state.players.filter((p) => p.lifeState === "alive" && !p.coach);
  const t = alive.filter((p) => p.side === "T");
  const ct = alive.filter((p) => p.side === "CT");
  return t.length === 1 && ct.length >= 2 ? t[0]! : ct.length === 1 && t.length >= 2 ? ct[0]! : null;
}

/** How close (units) a CT has to be to the planted bomb for the CTs to be going for it. */
export const RETAKE_RANGE = 1600;

/**
 * A retake on: a live round with the bomb planted (or being defused), players alive on both teams
 * (coaches aside), and the CTs going for it: a CT within RETAKE_RANGE of the bomb, with time left to
 * defuse (5 s with a kit, 10 s without). CTs saving, or out of time, are no retake.
 */
export function retakeUnderway(state: MatchState): boolean {
  const bomb = state.bomb;
  if (state.roundPhase !== "live" || !bomb || (bomb.state !== "planted" && bomb.state !== "defusing")) return false;
  const alive = state.players.filter((p) => p.lifeState === "alive" && !p.coach);
  const ct = alive.filter((p) => p.side === "CT");
  if (!ct.length || !alive.some((p) => p.side === "T")) return false;
  if (bomb.state === "defusing") return true;
  if (bomb.countdownSec !== null && bomb.countdownSec < (ct.some((p) => p.defuseKit) ? 5 : 10)) return false;
  const at = bomb.position;
  if (!at) return true;
  return ct.some((p) => p.position && Math.hypot(p.position.x - at.x, p.position.y - at.y, p.position.z - at.z) <= RETAKE_RANGE);
}

/** The console lines that put the game in the state the options describe. */
export function consoleCommands(o: ConsoleOptions, mode: GameLaunchMode, colours: SideColours): string[] {
  if (mode === "standard") return [];
  // cl_drawhud 1: the game draws its HUD at all (the kill feed, the names above the players).
  const out = ["cl_drawhud 1", `cl_draw_only_deathnotices ${o.hideGameHud ? 1 : 0}`, ...xrayCommands(o.xray)];
  // Off: the game's own defaults (sleep 20 ms a frame and mute while another window has focus).
  out.push(`engine_no_focus_sleep ${o.runInBackground ? 0 : 20}`, `snd_mute_losefocus ${o.runInBackground ? 0 : 1}`);
  if (o.frameCap !== null) out.push(`fps_max ${o.frameCap}`);
  if (mode === "hlae") {
    out.push(`mirv_noflash ${o.noFlash ? 1 : 0}`, `mirv_endofmatch ${o.hideEndOfMatch ? 0 : 1}`, ...killfeedColourCommands(o.killfeedTeamColours, colours));
    // A rule with no player match applies to every kill notice. Cleared first so applying again never stacks rules.
    out.push("mirv_deathmsg filter clear");
    if (o.hideGameKillfeed) out.push("mirv_deathmsg filter add block=1", "mirv_deathmsg clear");
  }
  return out;
}

export interface LaunchPlan {
  mode: GameLaunchMode;
  installDir: string;
  /** steam.exe, when found: CS2 is started with `steam.exe -applaunch 730 <args>`. */
  steamExe: string | null;
  /** cs2.exe, for the HLAE mode (HLAE starts it directly with `-steam`). */
  cs2Exe: string;
  /** Launch options for CS2 (without `-applaunch 730`). */
  args: string[];
  netconPort: number | null;
}

export function launchPlan(profile: GameLaunchProfile, install: Pick<Cs2Install, "installDir" | "steamRoot">, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): LaunchPlan {
  const extra = parseExtraArgs(profile.extraArgs).args;
  const consoleArgs = profile.mode === "standard" ? [] : ["-tools", "-netconport", String(profile.netconPort)];
  const args = profile.mode === "hlae" ? ["-steam", "-insecure", ...consoleArgs, ...extra] : [...consoleArgs, ...extra];
  const steamExe = install.steamRoot ? join(install.steamRoot, platform === "win32" ? "steam.exe" : "steam") : null;
  return {
    mode: profile.mode,
    installDir: install.installDir,
    steamExe: steamExe && exists(steamExe) ? steamExe : null,
    cs2Exe: join(install.installDir, "game", "bin", "win64", "cs2.exe"),
    args,
    netconPort: profile.mode === "standard" ? null : profile.netconPort,
  };
}

export interface GameConsoleStatus {
  profile: GameLaunchProfile;
  options: ConsoleOptions;
  console: NetconStatus | "off";
  port: number | null;
  connectedAt: string | null;
  lastError: string | null;
  /** Console lines sent since the last connect that the game did not accept as written. */
  lastApplyError: string | null;
  lastAppliedAt: string | null;
}

/** Keeps the console connection for the chosen launch mode and applies the console options to it. */
export class GameConsoleService {
  private conn: NetconConnection | null = null;
  private colours: SideColours = { ct: null, t: null };
  private lastApplyError: string | null = null;
  private lastAppliedAt: string | null = null;
  /** X-ray turned off for a clutch or a retake: the round attempt it is off for, until that round is no longer live. */
  private xrayHold: { round: string | null; reason: "clutch" | "retake"; steamId: string | null } | null = null;
  private readonly changeListeners = new Set<(conn: NetconConnection | null) => void>();

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      teams: Pick<DocumentRepo<typeof Team>, "get">;
      logger: Pick<Logger, "info" | "warn">;
      connect?: (host: string, port: number) => NetconConnection;
      /** Lines sent each time the console connects, after the options (the HLAE camera script in the HLAE mode). */
      connectLines?: (profile: GameLaunchProfile) => string[];
    },
  ) {}

  profile(): GameLaunchProfile {
    const r = GameLaunchProfile.safeParse(this.deps.settings.get("game.launch", {}));
    return r.success ? r.data : GameLaunchProfile.parse({});
  }

  options(): ConsoleOptions {
    const r = ConsoleOptions.safeParse(this.deps.settings.get("game.consoleOptions", {}));
    return r.success ? r.data : ConsoleOptions.parse({});
  }

  /** The options as applied now: X-ray off during a clutch or a retake. */
  private effectiveOptions(): ConsoleOptions {
    const o = this.options();
    return this.xrayHold ? { ...o, xray: false } : o;
  }

  /** The clutch or retake X-ray is off for, if any. */
  get xrayOff(): { round: string | null; reason: "clutch" | "retake"; steamId: string | null } | null {
    return this.xrayHold;
  }

  /** The shared console connection (null in the standard mode). */
  get connection(): NetconConnection | null {
    return this.conn;
  }

  /** Called when the connection object is replaced (mode or port change), to re-share it. */
  onConnectionChange(fn: (conn: NetconConnection | null) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  setProfile(p: GameLaunchProfile): GameLaunchProfile {
    this.deps.settings.set("game.launch", p);
    this.sync();
    return p;
  }

  setOptions(patch: ConsoleOptionsPatch): ConsoleOptions {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = ConsoleOptions.parse({ ...this.options(), ...given });
    this.deps.settings.set("game.consoleOptions", next);
    void this.apply();
    return next;
  }

  /** Starts, replaces or stops the connection to match the launch profile. */
  sync(): void {
    const p = this.profile();
    const wanted = p.mode === "standard" ? null : p.netconPort;
    if (this.conn && this.conn.port === wanted) {
      this.conn.start();
      return;
    }
    this.conn?.stop();
    this.conn = null;
    if (wanted !== null) {
      const conn = this.deps.connect ? this.deps.connect("127.0.0.1", wanted) : new NetconConnection({ host: "127.0.0.1", port: wanted, retryMs: 2000, maxRetryMs: 10_000 });
      conn.onConnect(() => {
        this.deps.logger.info("CS2 console connected", { port: wanted });
        void this.apply().then(() => {
          const extra = this.deps.connectLines?.(this.profile()) ?? [];
          return extra.length ? this.apply(extra) : undefined;
        });
      });
      this.conn = conn;
      conn.start();
    }
    for (const fn of this.changeListeners) fn(this.conn);
  }

  /** Sends the console lines for the current options (when connected). */
  async apply(lines?: string[]): Promise<void> {
    const conn = this.conn;
    if (!conn?.connected) return;
    const todo = lines ?? consoleCommands(this.effectiveOptions(), this.profile().mode, this.colours);
    try {
      for (const line of todo) await conn.write(line);
      this.lastApplyError = null;
      this.lastAppliedAt = new Date().toISOString();
    } catch (e) {
      this.lastApplyError = e instanceof Error ? e.message : String(e);
      this.deps.logger.warn("could not apply CS2 console options", { error: this.lastApplyError });
    }
  }

  /** Follows which team is on CT and T (sides swap at half time) for the kill feed colours, and clutches and retakes for X-ray. */
  onState(state: MatchState): void {
    this.trackXrayHold(state);
    const colour = (id: string | null) => (id ? (this.deps.teams.get(id)?.data.primaryColor ?? null) : null);
    const next = { ct: colour(state.teams.CT.teamId), t: colour(state.teams.T.teamId) };
    if (next.ct === this.colours.ct && next.t === this.colours.t) return;
    this.colours = next;
    const p = this.profile();
    if (p.mode === "hlae" && this.options().killfeedTeamColours) void this.apply(killfeedColourCommands(true, next));
  }

  /**
   * X-ray (with the names) off from the moment one player is alone against two or more in a live
   * round (`clutchXrayOff`), or a retake is on (`retakeXrayOff`), back on when that round is no
   * longer live (won, lost, or a new round). Only with X-ray on, in a console launch mode.
   */
  private trackXrayHold(state: MatchState): void {
    const o = this.options();
    const held = this.xrayHold;
    if (held) {
      const allowed = o.xray && (held.reason === "clutch" ? o.clutchXrayOff : o.retakeXrayOff);
      if (!allowed || state.roundPhase !== "live" || state.roundAttemptId !== held.round) {
        this.xrayHold = null;
        this.deps.logger.info(`x-ray back on after the ${held.reason}`, { steamId: held.steamId });
        void this.apply(xrayCommands(o.xray));
      }
      return;
    }
    if (!o.xray || this.profile().mode === "standard") return;
    const lone = o.clutchXrayOff ? clutchPlayer(state) : null;
    const reason = lone ? "clutch" : o.retakeXrayOff && retakeUnderway(state) ? "retake" : null;
    if (!reason) return;
    this.xrayHold = { round: state.roundAttemptId, reason, steamId: lone?.steamId ?? null };
    this.deps.logger.info(`x-ray off for the ${reason}`, { steamId: lone?.steamId ?? null });
    void this.apply(xrayCommands(false));
  }

  status(): GameConsoleStatus {
    const c = this.conn;
    return {
      profile: this.profile(),
      options: this.options(),
      console: c ? c.status : "off",
      port: c ? c.port : null,
      connectedAt: c?.connectedAt ?? null,
      lastError: c?.lastError ?? null,
      lastApplyError: this.lastApplyError,
      lastAppliedAt: this.lastAppliedAt,
    };
  }

  stop(): void {
    this.conn?.stop();
    this.conn = null;
  }
}
