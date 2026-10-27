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
  /** `spec_show_xray`: players seen through walls while spectating (the game's default is on). */
  xray: z.boolean().default(true),
  /** HLAE `mirv_noflash 1`: no white-out from flashbangs on the observer's screen. */
  noFlash: z.boolean().default(false),
  /** HLAE `mirv_deathmsg colors`: CT and T names in the kill feed in the teams' colours. */
  killfeedTeamColours: z.boolean().default(false),
  /** HLAE `mirv_endofmatch 0`: no end-of-match scene over the game. */
  hideEndOfMatch: z.boolean().default(false),
});
export type ConsoleOptions = z.infer<typeof ConsoleOptions>;

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

/** The console lines that put the game in the state the options describe. */
export function consoleCommands(o: ConsoleOptions, mode: GameLaunchMode, colours: SideColours): string[] {
  if (mode === "standard") return [];
  const out = [`cl_draw_only_deathnotices ${o.hideGameHud ? 1 : 0}`, `spec_show_xray ${o.xray ? 1 : 0}`];
  if (mode === "hlae") out.push(`mirv_noflash ${o.noFlash ? 1 : 0}`, `mirv_endofmatch ${o.hideEndOfMatch ? 0 : 1}`, ...killfeedColourCommands(o.killfeedTeamColours, colours));
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
  private readonly changeListeners = new Set<(conn: NetconConnection | null) => void>();

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      teams: Pick<DocumentRepo<typeof Team>, "get">;
      logger: Pick<Logger, "info" | "warn">;
      connect?: (host: string, port: number) => NetconConnection;
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

  setOptions(patch: Partial<ConsoleOptions>): ConsoleOptions {
    const next = ConsoleOptions.parse({ ...this.options(), ...patch });
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
        void this.apply();
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
    const todo = lines ?? consoleCommands(this.options(), this.profile().mode, this.colours);
    try {
      for (const line of todo) await conn.write(line);
      this.lastApplyError = null;
      this.lastAppliedAt = new Date().toISOString();
    } catch (e) {
      this.lastApplyError = e instanceof Error ? e.message : String(e);
      this.deps.logger.warn("could not apply CS2 console options", { error: this.lastApplyError });
    }
  }

  /** Follows which team is on CT and T (sides swap at half time) for the kill feed colours. */
  onState(state: MatchState): void {
    const colour = (id: string | null) => (id ? (this.deps.teams.get(id)?.data.primaryColor ?? null) : null);
    const next = { ct: colour(state.teams.CT.teamId), t: colour(state.teams.T.teamId) };
    if (next.ct === this.colours.ct && next.t === this.colours.t) return;
    this.colours = next;
    const p = this.profile();
    if (p.mode === "hlae" && this.options().killfeedTeamColours) void this.apply(killfeedColourCommands(true, next));
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
