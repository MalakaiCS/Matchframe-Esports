import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";

/**
 * Replay PC (the second computer). It runs its own CS2, Auto Director and OBS replay buffer, and is
 * linked to the main PC:
 *
 * - it asks the main PC every 250 ms which player is on air there, and its own director avoids that
 *   player, so it films the other side of the same fight or another fight;
 * - when a kill happens that the main camera didn't show (or showed only from the victim) and this
 *   computer's camera had the killer, it saves its replay buffer and sends the clip to the main PC,
 *   which plays it in the next replay break (replay/auto.ts).
 */

export const ReplayPcSettings = z.object({
  enabled: z.boolean().default(false),
  /** The main PC's program address, e.g. http://192.168.1.20:37211. */
  mainUrl: z.string().max(200).default(""),
  /** Seconds before the first kill a clip shows. */
  preRollMs: z.number().int().min(2000).max(15000).default(5000),
  /** Seconds after the last kill (also how long the computer waits before saving). */
  postRollMs: z.number().int().min(500).max(5000).default(2000),
});
export type ReplayPcSettings = z.infer<typeof ReplayPcSettings>;

export interface MainOnAir {
  computer: string;
  version: string;
  observedSteamId: string | null;
  roundNumber: number | null;
  roundPhase: string | null;
  mapName: string | null;
}

export interface ReplayPcStatus {
  enabled: boolean;
  state: "off" | "connecting" | "connected" | "error";
  detail: string;
  main: { computer: string; version: string; url: string } | null;
  /** The player on air on the main PC (Steam ID), while connected. */
  mainObserved: string | null;
  obsReady: boolean;
  sent: number;
  failed: number;
  last: { label: string; at: string; ok: boolean; error: string | null } | null;
}

const POLL_MS = 250;
/** A main-PC answer older than this is not used to avoid or judge anything. */
const FRESH_MS = 1500;
/** The main camera "showed" a player when it had them within this long before the kill. */
const SHOWN_WINDOW_MS = 2500;
/** Kills by the same player this close together go into one clip. */
const CHAIN_MS = 4000;
/** A clip never covers more kills than fit in this span. */
const MAX_SPAN_MS = 12000;

interface Pending {
  killer: { steamId: string; name: string };
  victims: string[];
  weapon: string | null;
  headshot: boolean;
  kind: "missed" | "other_angle";
  firstAt: number;
  lastAt: number;
  roundNumber: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export const SECRET_KEY = "replayPc.token";

export class ReplayLink {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private status: ReplayPcStatus = { enabled: false, state: "off", detail: "This computer is not a replay PC.", main: null, mainObserved: null, obsReady: false, sent: 0, failed: 0, last: null };
  /** The main PC's on-air player over time (local monotonic ms). */
  private mainHistory: { at: number; steamId: string | null }[] = [];
  /** This computer's on-air player over time. */
  private ownHistory: { at: number; steamId: string | null }[] = [];
  private lastAnswerAt = -Infinity;
  private pending = new Map<string, Pending>();
  private unsubscribe: (() => void)[] = [];
  private bufferStartTried = false;

  constructor(private readonly e: Engine) {}

  settings(): ReplayPcSettings {
    const r = ReplayPcSettings.safeParse(this.e.settings.get("replayPc", {}));
    return r.success ? r.data : ReplayPcSettings.parse({});
  }

  setSettings(patch: Partial<ReplayPcSettings> & { token?: string | null }): ReplayPcSettings {
    const { token, ...rest } = patch;
    const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const next = ReplayPcSettings.parse({ ...this.settings(), ...given });
    if (next.mainUrl) next.mainUrl = normalizeUrl(next.mainUrl);
    this.e.settings.set("replayPc", next);
    if (token !== undefined) this.e.secrets.setSecret(SECRET_KEY, token ? token.trim() : null);
    this.restart();
    return next;
  }

  hasToken(): boolean {
    return !!this.e.secrets.getSecret(SECRET_KEY);
  }

  getStatus(): ReplayPcStatus {
    return { ...this.status, obsReady: this.e.obs.state.connected && this.e.obs.state.replayBuffer === true };
  }

  start(): void {
    this.restart();
  }

  restart(): void {
    this.stop();
    const st = this.settings();
    if (!st.enabled) {
      this.status = { ...this.status, enabled: false, state: "off", detail: "This computer is not a replay PC.", main: null, mainObserved: null };
      return;
    }
    if (!st.mainUrl || !this.hasToken()) {
      this.status = { ...this.status, enabled: true, state: "error", detail: "Enter the main PC's address and its replay PC code.", main: null, mainObserved: null };
      return;
    }
    this.status = { ...this.status, enabled: true, state: "connecting", detail: `Connecting to ${st.mainUrl}…` };
    this.unsubscribe.push(this.e.onKill((k) => this.onKill(k)));
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const fn of this.unsubscribe.splice(0)) fn();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    this.e.session.director.avoid([], 0);
  }

  /** Called with every game-state update on this computer. */
  noteOwnState(observedSteamId: string | null): void {
    if (!this.timer) return;
    const now = this.e.now();
    const last = this.ownHistory[this.ownHistory.length - 1];
    if (!last || last.steamId !== observedSteamId) this.ownHistory.push({ at: now, steamId: observedSteamId });
    trim(this.ownHistory, now);
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    const st = this.settings();
    const token = this.e.secrets.getSecret(SECRET_KEY);
    if (!st.enabled || !st.mainUrl || !token) return;
    this.inFlight = true;
    try {
      const res = await fetch(`${st.mainUrl}/api/v1/replay-link/on-air`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      if (res.status === 401 || res.status === 403) throw new Error("the main PC refused this computer's code: make a new replay PC code on the main PC");
      if (!res.ok) throw new Error(`the main PC answered ${res.status}`);
      const onAir = (await res.json()) as MainOnAir;
      const now = this.e.now();
      this.lastAnswerAt = now;
      const last = this.mainHistory[this.mainHistory.length - 1];
      if (!last || last.steamId !== onAir.observedSteamId) this.mainHistory.push({ at: now, steamId: onAir.observedSteamId });
      trim(this.mainHistory, now);
      // Prefer anyone but the main PC's player for a little longer than one poll.
      this.e.session.director.avoid(onAir.observedSteamId ? [onAir.observedSteamId] : [], now + FRESH_MS);
      this.status = { ...this.status, state: "connected", detail: `Linked to ${onAir.computer}.`, main: { computer: onAir.computer, version: onAir.version, url: st.mainUrl }, mainObserved: onAir.observedSteamId };
      void this.ensureReplayBuffer();
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "TimeoutError" ? "the main PC didn't answer in time" : err.message) : String(err);
      this.status = { ...this.status, state: "error", detail: `Can't reach the main PC at ${st.mainUrl}: ${msg}.`, mainObserved: null };
    } finally {
      this.inFlight = false;
    }
  }

  /** Starts OBS's replay buffer on this computer once, when OBS is connected and it isn't running. */
  private async ensureReplayBuffer(): Promise<void> {
    if (this.bufferStartTried || !this.e.obs.state.connected || this.e.obs.state.replayBuffer !== false) return;
    this.bufferStartTried = true;
    await this.e.obs.setOutput("replay", true).catch((err) => this.e.logger.warn("replay PC: could not start the OBS replay buffer", { error: String(err) }));
  }

  /** Who a camera had on air during [from, to] (local monotonic ms). */
  private showedDuring(history: { at: number; steamId: string | null }[], steamIds: string[], from: number, to: number): boolean {
    for (let i = 0; i < history.length; i++) {
      const h = history[i]!;
      const until = history[i + 1]?.at ?? Infinity;
      if (until < from || h.at > to) continue;
      if (h.steamId && steamIds.includes(h.steamId)) return true;
    }
    return false;
  }

  private onKill(k: HudKillfeedEntry): void {
    if (!k.killer || this.status.state !== "connected") return;
    const now = this.e.now();
    if (now - this.lastAnswerAt > FRESH_MS) return;
    const killer = k.killer.steamId;
    const victim = k.victim.steamId;
    // This computer must have had the killer on camera just before the kill.
    if (!this.showedDuring(this.ownHistory, [killer], now - 1500, now)) return;
    const mainHadKiller = this.showedDuring(this.mainHistory, [killer], now - SHOWN_WINDOW_MS, now);
    if (mainHadKiller) return;
    const mainHadVictim = this.showedDuring(this.mainHistory, [victim], now - SHOWN_WINDOW_MS, now);
    const kind = mainHadVictim ? "other_angle" : "missed";
    const roundNumber = this.e.session.state()?.roundNumber ?? null;
    const st = this.settings();
    const p = this.pending.get(killer);
    if (p && now - p.lastAt <= CHAIN_MS && now - p.firstAt <= MAX_SPAN_MS) {
      p.victims.push(k.victim.name);
      p.lastAt = now;
      p.headshot ||= k.headshot === true;
      if (kind === "missed") p.kind = "missed";
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => void this.capture(killer), st.postRollMs);
      return;
    }
    const next: Pending = { killer: { steamId: killer, name: k.killer.name }, victims: [k.victim.name], weapon: k.weapon, headshot: k.headshot === true, kind, firstAt: now, lastAt: now, roundNumber, timer: null };
    next.timer = setTimeout(() => void this.capture(killer), st.postRollMs);
    this.pending.set(killer, next);
  }

  private async capture(killerId: string): Promise<void> {
    const p = this.pending.get(killerId);
    if (!p) return;
    this.pending.delete(killerId);
    const st = this.settings();
    const token = this.e.secrets.getSecret(SECRET_KEY);
    const play: ReplayPlay = { kind: p.kind, killer: p.killer, victims: p.victims, kills: p.victims.length, weapon: p.weapon, headshot: p.headshot };
    const label = replayLabel(play);
    const playMs = Math.round(st.preRollMs + (p.lastAt - p.firstAt) + st.postRollMs);
    try {
      if (!this.e.obs.state.connected) throw new Error("OBS isn't connected on this computer");
      const { savedPath } = await this.e.obs.saveReplayBuffer();
      const body = readFileSync(savedPath);
      const ext = (extname(savedPath).slice(1) || "mp4").toLowerCase();
      const q = new URLSearchParams({ label, kind: play.kind, playMs: String(playMs), ext, kills: String(play.kills), killer: p.killer.steamId, killerName: p.killer.name, victims: play.victims.join("\n"), weapon: play.weapon ?? "", headshot: play.headshot ? "1" : "0", ...(p.roundNumber !== null ? { round: String(p.roundNumber) } : {}) });
      const res = await fetch(`${st.mainUrl}/api/v1/replays/incoming?${q.toString()}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`the main PC answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      this.status = { ...this.status, sent: this.status.sent + 1, last: { label, at: new Date().toISOString(), ok: true, error: null } };
      this.e.logger.info("replay PC: sent a clip", { label, bytes: body.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, failed: this.status.failed + 1, last: { label, at: new Date().toISOString(), ok: false, error } };
      this.e.logger.warn("replay PC: clip not sent", { label, error });
    }
  }
}

/** "haze ▸ kite, saber (AWP)". */
export function replayLabel(p: ReplayPlay): string {
  const weapon = p.weapon ? ` (${p.weapon.replace(/^weapon_/, "").toUpperCase()})` : "";
  const who = p.killer?.name ?? "Unknown";
  const prefix = p.kills >= 3 ? `${p.kills}K: ` : "";
  return `${prefix}${who} ▸ ${p.victims.join(", ")}${weapon}`;
}

export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  const url = new URL(u);
  if (!url.port) url.port = "37211";
  return `${url.protocol}//${url.host}`;
}

function trim(history: { at: number }[], now: number): void {
  while (history.length > 2 && history[1]!.at < now - 30000) history.shift();
}
