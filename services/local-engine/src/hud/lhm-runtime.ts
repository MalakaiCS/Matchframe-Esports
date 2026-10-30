import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { join } from "node:path";
import { Server as IoServer } from "socket.io";
import type { MatchState, Player, Team } from "@matchframe/contracts";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { Engine } from "../app.ts";
import { assetDir } from "../routes/domain.ts";
import { safeResolve } from "../http/static.ts";
import { libraryOutputId } from "./library.ts";
import { hudConfig, isPanelAction, parsePanel, type LhmLookup, type LhmPanel } from "./lhm.ts";
import { outlineRadar, type LhmRadarConfig } from "./outline-radar.ts";

/**
 * LHM compatibility layer: what an LHM-format HUD (Lexogrine template protocol) expects from LHM,
 * served by Matchframe's HUD server.
 *
 * - socket.io at /socket.io: "readyToRegister" → the HUD's "register" → "hud_config" (its panel
 *   settings); "update" with the game data as CS2 sent it (auth token removed): at once when
 *   something a viewer sees switch changes (see lhmUrgentKey), else the latest packet at most twenty
 *   times a second (UPDATE_MS), fewer while the HUD's page can't keep up (updatePacer);
 *   "hud_action" for panel buttons; "match" when the current match changes.
 * - GET /api/... (match, teams and logos, players and avatars, tournament, camera, radar maps) from
 *   Matchframe's own data.
 * - Player cams (ADR-048): `/api/camera` lists the match's players; a HUD's "registerAsHUD" gets
 *   "playersCameraStatus" and an "offerFromPlayer" for every cam on air (again every few seconds,
 *   which the HUD ignores while it has the cam). The offers carry a marker that the page's
 *   RTCPeerConnection (hud-runtime lhm-cams.js) answers locally with the delayed cam.
 *
 * LHM HUDs cannot pass Matchframe's HUD token, so the wrapper page (opened with the token) sets an
 * HttpOnly cookie per HUD; sockets and API requests without a valid cookie are refused. Everything
 * here is read-only, like the rest of the HUD server.
 */

export const lhmCookieName = (hudId: string) => `mf_lhm_${hudId}`;

/** The camera room id LHM HUDs read from /api/camera and pass back in "registerAsHUD". */
export const LHM_CAM_UUID = "matchframe-cams";
/** An offer for a player's cam that lhm-cams.js recognises (it never reaches a real connection). */
export const lhmCamOffer = (steamId: string) => ({ offer: { type: "offer", sdp: `v=0\r\no=matchframe 0 0 IN IP4 127.0.0.1\r\ns=matchframe-cam\r\nt=0 0\r\na=x-matchframe-cam:${steamId}\r\n` } });

/**
 * Game data reaches LHM HUDs at most this often (ms), apart from urgent changes. CS2 sends up to 50
 * packets a second at Matchframe's setting (for instant POV switches), and an LHM HUD redraws its
 * whole page for each. Measured with kaiHUD in Chromium (a player running across its minimap):
 * - 10 a second: the minimap dot (LHM's 0.1 s eased transition) surged and stopped ten times a
 *   second, which looks like a HUD drawing at 20 fps although the page drew at 60;
 * - 20 a second: the dot moves evenly; main thread 21 % busy (16 % at 10), and 60 fps still with
 *   the CPU 4× slower;
 * - 30 or 50 a second: no smoother, and with the CPU 4× slower the main thread is full and frames drop.
 * kaiHUD's page does about 2.6 times the work of Matchframe's own HUD for the same game data (main
 * thread 31 % against 12 %), nearly all of it redrawing for each update. So an LHM HUD whose page
 * can't keep up gets fewer (see updatePacer), down to MAX_UPDATE_MS.
 */
export const UPDATE_MS = 50;
/** The slowest an LHM HUD whose page can't keep up gets game data (ms): five times a second. */
export const MAX_UPDATE_MS = 200;
/**
 * How long the HUD page's tasks wait (90th percentile over 5 s, ms; the output page pings itself
 * every 100 ms): from BUSY_LAG_MS the page has more work than time, under CALM_LAG_MS it has room.
 * Measured with kaiHUD at 20 updates a second: 0.1 ms at full speed; 11, 18 and 27 ms with the CPU
 * 2, 3 and 4 times slower (55, 55 and 42 fps).
 */
export const BUSY_LAG_MS = 15;
export const CALM_LAG_MS = 6;

/**
 * What must reach an LHM HUD at once: the spectated player, round and countdown phase, bomb state,
 * who is alive, the score and the round number. Positions, the clock and money can wait for the next
 * tick.
 */
/**
 * Passes game data on: urgent packets at once, others as the latest one at most every `everyMs`
 * (a packet in between replaces the waiting one).
 */
export function updateCoalescer(emit: (payload: Record<string, unknown>) => void, everyMs: number | (() => number) = UPDATE_MS, now: () => number = Date.now): { push: (payload: Record<string, unknown>) => void; dispose: () => void } {
  const every = typeof everyMs === "function" ? everyMs : () => everyMs;
  let pending: Record<string, unknown> | null = null;
  let lastSent = -Infinity;
  let lastKey = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    emit(pending);
    pending = null;
    lastSent = now();
  };
  return {
    push: (payload) => {
      pending = payload;
      const key = lhmUrgentKey(payload);
      const urgent = key !== lastKey;
      lastKey = key;
      const wait = every() - (now() - lastSent);
      if (urgent || wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** What changed an LHM HUD's update interval (for the director log). */
export interface PaceChange {
  hudId: string;
  everyMs: number;
  was: number;
  lagMs: number;
}

/**
 * Each LHM HUD's update interval, from how long its output pages' tasks wait. A busy page (any of
 * the HUD's outputs) doubles it, up to MAX_UPDATE_MS; three calm reports in a row (15 s) halve it,
 * back to UPDATE_MS. After a HUD was slowed down, it waits a minute of calm before trying faster
 * again, so a page that can't keep up at 20 a second doesn't swing between the two. A HUD none of
 * whose outputs reported for 30 s is back at UPDATE_MS.
 */
export function updatePacer(now: () => number = Date.now) {
  const huds = new Map<string, { everyMs: number; calm: number; needCalm: number; changedAt: number; outputs: Map<object, { at: number; lagMs: number }> }>();
  return {
    everyMs: (hudId: string | null): number => {
      const h = hudId ? huds.get(hudId) : undefined;
      if (!h) return UPDATE_MS;
      // None of its outputs reported for a while (the busy one closed): back to the normal rate.
      if (![...h.outputs.values()].some((v) => now() - v.at < 30_000)) huds.delete(hudId!);
      return huds.get(hudId!)?.everyMs ?? UPDATE_MS;
    },
    /** One output page's report; returns the change when the interval changed. */
    report(hudId: string, output: object, lagMs: number): PaceChange | null {
      const t = now();
      let h = huds.get(hudId);
      if (!h) huds.set(hudId, (h = { everyMs: UPDATE_MS, calm: 0, needCalm: 3, changedAt: -Infinity, outputs: new Map() }));
      h.outputs.set(output, { at: t, lagMs });
      for (const [k, v] of h.outputs) if (t - v.at > 12_000) h.outputs.delete(k);
      const worst = Math.max(...[...h.outputs.values()].map((v) => v.lagMs));
      const was = h.everyMs;
      if (worst >= BUSY_LAG_MS) {
        h.calm = 0;
        // A full report (5 s) at the new pace before slowing down again.
        if (h.everyMs < MAX_UPDATE_MS && t - h.changedAt >= 9000) {
          h.everyMs = Math.min(MAX_UPDATE_MS, h.everyMs * 2);
          h.needCalm = 12;
        }
      } else if (worst < CALM_LAG_MS) {
        h.calm += 1;
        if (h.everyMs > UPDATE_MS && h.calm >= h.needCalm) {
          h.everyMs = Math.max(UPDATE_MS, h.everyMs / 2);
          h.calm = 0;
          h.needCalm = 3;
        }
      } else h.calm = 0;
      if (h.everyMs === was) return null;
      h.changedAt = t;
      return { hudId, everyMs: h.everyMs, was, lagMs: worst };
    },
  };
}

/**
 * The game data as an LHM HUD gets it: coaches listed with a team left out of `allplayers`, and each
 * player's `observer_slot` the spectator number key (1–9, 0; PlayerState.observerKey). CS2 counts
 * slots from 0, so a HUD showing observer_slot as the player's number (kaiHUD's minimap) showed the
 * first player as 0.
 */
export function lhmGamePayload(raw: Record<string, unknown>, state: MatchState | null): Record<string, unknown> {
  if (!state || !raw.allplayers || typeof raw.allplayers !== "object") return raw;
  const byId = new Map(state.players.map((p) => [p.steamId, p]));
  const allplayers: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(raw.allplayers as Record<string, unknown>)) {
    const p = byId.get(id);
    if (p?.coach) continue;
    allplayers[id] = p && v && typeof v === "object" ? { ...(v as Record<string, unknown>), observer_slot: p.observerKey ?? undefined } : v;
  }
  const out: Record<string, unknown> = { ...raw, allplayers };
  const player = raw.player as Record<string, unknown> | undefined;
  const spectated = typeof player?.steamid === "string" ? byId.get(player.steamid) : undefined;
  if (player && spectated && "observer_slot" in player) out.player = { ...player, observer_slot: spectated.observerKey ?? undefined };
  return out;
}

export function lhmUrgentKey(p: Record<string, unknown>): string {
  const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const all = Object.values(o(p.allplayers)).map((x) => {
    const st = o(o(x).state);
    return `${st.health === 0 ? 0 : 1}`;
  });
  const map = o(p.map);
  return [o(p.player).steamid, o(p.round).phase, o(p.phase_countdowns).phase, o(p.bomb).state, all.join(""), map.round, map.phase, o(map.team_ct).score, o(map.team_t).score].join("|");
}

/**
 * A killfeed entry as an HLAE player_death game event (what LHM relays as "update_mirv"). Only
 * kills with a killer are sent; details game data does not have (wallbang, no-scope, through smoke,
 * flash assist, in air) are false.
 */
export function mirvPlayerDeath(k: HudKillfeedEntry): Record<string, unknown> | null {
  if (!k.killer) return null;
  const who = (steamId: string | null) => ({ value: 0, xuid: steamId ?? "0" });
  return {
    name: "player_death",
    keys: {
      userid: who(k.victim.steamId),
      attacker: who(k.killer.steamId),
      assister: who(k.assister?.steamId ?? null),
      assistedflash: false,
      weapon: (k.weapon ?? "world").replace(/^weapon_/, ""),
      headshot: k.headshot === true,
      penetrated: 0,
      attackerblind: k.attackerBlind === true,
      thrusmoke: false,
      noscope: false,
      attackerinair: false,
    },
  };
}

export function lhmSetCookie(hudId: string, token: string): string {
  return `${lhmCookieName(hudId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      } catch {
        // A malformed cookie is ignored.
      }
    }
  }
  return out;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
};

export class LhmRuntime {
  private io: IoServer | null = null;
  private readonly panels = new Map<string, { dir: string; panel: LhmPanel }>();
  private readonly cleanup: (() => void)[] = [];
  private matchSignature = "";
  private readonly pacer = updatePacer();
  /** Radars drawn from map-pack outlines, per map (redrawn when its pack changes). */
  private readonly outlines = new Map<string, { pack: object; radar: { svg: string; config: LhmRadarConfig } | null }>();
  /** Each connected HUD page's game data, at its HUD's pace. */
  private readonly feeds = new Set<{ push: (payload: Record<string, unknown>) => void; dispose: () => void }>();

  constructor(private readonly e: Engine) {}

  /** LHM HUDs whose cookie in this request carries their current token. */
  allowedHuds(req: IncomingMessage): string[] {
    const out: string[] = [];
    for (const [name, value] of cookies(req)) {
      if (!name.startsWith("mf_lhm_")) continue;
      const id = name.slice("mf_lhm_".length);
      if (this.e.hudLibrary.runtimeConfig(id)?.runtime === "lhm" && this.e.hudLibrary.checkToken(id, value)) out.push(id);
    }
    return out;
  }

  private panel(hudId: string): LhmPanel {
    const dir = this.e.hudLibrary.runtimeConfig(hudId)?.installDir ?? null;
    if (!dir) return [];
    const cached = this.panels.get(hudId);
    if (cached && cached.dir === dir) return cached.panel;
    const file = join(dir, "panel.json");
    const panel = existsSync(file) ? parsePanel(readFileSync(file, "utf8")) : [];
    this.panels.set(hudId, { dir, panel });
    return panel;
  }

  private readonly lookup: LhmLookup = {
    player: (steamId) => {
      const p = this.e.players.list().find((d) => d.data.steamId === steamId)?.data;
      return p ? this.player(p) : { steamid: steamId, username: steamId };
    },
    team: (teamId) => {
      const t = this.e.teams.get(teamId)?.data;
      return t ? this.team(t) : null;
    },
    image: (assetId) => {
      if (!/\.(png|jpe?g|webp|svg|gif)$/i.test(assetId)) return null;
      const f = safeResolve(assetDir(this.e), assetId);
      if (!f || !existsSync(f) || statSync(f).size > LhmRuntime.IMAGE_MAX) return null;
      return readFileSync(f).toString("base64");
    },
  };
  /** Image inputs are sent inside hud_config as base64: each image at most this big. */
  private static readonly IMAGE_MAX = 4 * 1024 * 1024;

  config(hudId: string): Record<string, Record<string, unknown>> {
    const rt = this.e.hudLibrary.runtimeConfig(hudId);
    return rt ? hudConfig(this.panel(hudId), rt.settings, this.lookup) : {};
  }

  attach(server: HttpServer): void {
    const io = new IoServer(server, {
      path: "/socket.io",
      serveClient: false,
      allowRequest: (req, cb) => cb(null, this.allowedHuds(req).length > 0),
    });
    this.io = io;
    io.on("connection", (socket) => {
      const allowed = this.allowedHuds(socket.request);
      // The HUD this page is (its registered name, else its only cookie) sets its pace.
      let hud: string | null = allowed.length === 1 ? allowed[0]! : null;
      const feed = updateCoalescer((payload) => socket.emit("update", payload), () => this.pacer.everyMs(hud));
      this.feeds.add(feed);
      socket.on("disconnect", () => {
        feed.dispose();
        this.feeds.delete(feed);
      });
      socket.on("register", (name: unknown) => {
        let id: string;
        try {
          id = typeof name === "string" ? decodeURIComponent(name) : "";
        } catch {
          return;
        }
        if (!allowed.includes(id)) return;
        hud = id;
        void socket.join(`hud:${id}`);
        socket.emit("hud_config", this.config(id));
      });
      // Player cams: the HUD asks for the cams on air.
      socket.on("registerAsHUD", (uuid: unknown) => {
        if (uuid !== LHM_CAM_UUID) return;
        void socket.join("cams");
        socket.emit("playersCameraStatus", this.camStatus());
        for (const id of this.e.cams.onAir()) socket.emit("offerFromPlayer", LHM_CAM_UUID, lhmCamOffer(id), id);
      });
      // Everything else the HUD sends ("started", its answers to cam offers, ...) is ignored: read-only.
      socket.emit("readyToRegister");
    });
    let camsOnAir = "";
    const offerCams = (all: boolean) => {
      const on = this.e.cams.onAir().sort();
      const sig = on.join(",");
      const was = new Set(camsOnAir.split(",").filter(Boolean));
      if (sig !== camsOnAir) io.to("cams").emit("playersCameraStatus", this.camStatus());
      camsOnAir = sig;
      for (const id of on) if (all || !was.has(id)) io.to("cams").emit("offerFromPlayer", LHM_CAM_UUID, lhmCamOffer(id), id);
    };
    this.cleanup.push(this.e.cams.onChange(() => offerCams(false)));
    const camTimer = setInterval(() => offerCams(true), 3000);
    camTimer.unref?.();
    this.cleanup.push(() => clearInterval(camTimer));
    this.cleanup.push(
      this.e.onRawGsi((raw) => {
        if (!this.feeds.size) return;
        const payload = lhmGamePayload(raw, this.e.session.state());
        for (const f of this.feeds) f.push(payload);
      }),
    );
    this.cleanup.push(() => {
      for (const f of this.feeds) f.dispose();
      this.feeds.clear();
    });
    // The template's killfeed only listens to HLAE game events: Matchframe's paired kills, in that form.
    this.cleanup.push(
      this.e.onKill((k) => {
        const ev = mirvPlayerDeath(k);
        if (ev) io.emit("update_mirv", ev);
      }),
    );
    this.cleanup.push(
      this.e.hudLibrary.onChange((ev) => {
        if (ev.type !== "settings" || !ev.hudId) return;
        this.panels.delete(ev.hudId);
        io.to(`hud:${ev.hudId}`).emit("hud_config", this.config(ev.hudId));
      }),
    );
    const timer = setInterval(() => {
      const sig = JSON.stringify(this.currentMatch());
      if (sig !== this.matchSignature) {
        this.matchSignature = sig;
        io.emit("match", true);
      }
    }, 2000);
    timer.unref?.();
    this.cleanup.push(() => clearInterval(timer));
  }

  /** An LHM HUD output page's report of how long its tasks wait: paces that HUD's game data. */
  noteLoad(hudId: string, output: object, lagMs: number): void {
    const ch = this.pacer.report(hudId, output, lagMs);
    if (ch) this.e.directorLog.info(ch.everyMs > ch.was ? "lhm hud busy: fewer updates" : "lhm hud has room: more updates", { hud: hudId, updatesPerSec: Math.round(1000 / ch.everyMs), lagMs: ch.lagMs });
  }

  /** Maps with no radar image (Anubis, Cache): their map pack's outline as a radar. */
  private outlineRadars(): Map<string, { svg: string; config: LhmRadarConfig }> {
    const out = new Map<string, { svg: string; config: LhmRadarConfig }>();
    for (const rt of this.e.maps.list()) {
      if (this.e.radars.get(rt.mapName) || !/^(de|cs|ar)_/.test(rt.mapName) || rt.mapName === "de_synthetic") continue;
      let cached = this.outlines.get(rt.mapName);
      if (!cached || cached.pack !== rt.pack) this.outlines.set(rt.mapName, (cached = { pack: rt.pack, radar: outlineRadar(rt) }));
      if (cached.radar) out.set(rt.mapName, cached.radar);
    }
    return out;
  }

  /** For "playersCameraStatus": every listed player, whether their cam is on air. */
  private camStatus(): { steamid: string; label: string; allow: boolean; active: boolean }[] {
    const on = new Set(this.e.cams.onAir());
    return this.e.cams.rosterPlayers().map((p) => ({ steamid: p.steamId, label: p.name, allow: true, active: on.has(p.steamId) }));
  }

  /** A panel button pressed in the HUD's settings. */
  action(hudId: string, key: string, value: string): boolean {
    const target = isPanelAction(this.panel(hudId), key, value);
    if (!target || !this.io) return false;
    this.io.to(`hud:${hudId}`).emit("hud_action", { action: target.input, data: value });
    return true;
  }

  /** Connected LHM sockets for a HUD (registered ones). */
  connected(hudId: string): number {
    return this.io?.sockets.adapter.rooms.get(`hud:${hudId}`)?.size ?? 0;
  }

  async close(): Promise<void> {
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.io) {
      this.io.disconnectSockets(true);
      // The HTTP server is closed by its owner.
      this.io.engine.close();
      this.io = null;
    }
  }

  // ---------------------------------------------------------------- data in LHM's shapes

  private team(t: Team): Record<string, unknown> {
    return {
      _id: t.id,
      name: t.name,
      shortName: t.shortName,
      country: t.countryCode,
      // A path that serves the logo: template HUDs only test it and load /api/teams/logo/<id>
      // themselves, others (kaiHUD) use it as the image address.
      logo: t.logoAssetId ? `/api/teams/logo/${encodeURIComponent(t.id)}` : null,
      extra: { TeamColor: t.primaryColor ?? "", SecondaryColor: t.secondaryColor ?? "", ...t.sponsorMetadata },
    };
  }

  private player(p: Player): Record<string, unknown> {
    const [first, ...rest] = (p.realName ?? "").split(" ");
    const teamId = this.e.roster.history(p.id).find((m) => m.validTo === null)?.teamId ?? null;
    return {
      _id: p.id,
      firstName: first ?? "",
      lastName: rest.join(" "),
      username: p.displayName,
      avatar: p.photoVisible && p.avatarAssetId ? this.e.assetUrl(p.avatarAssetId) : "",
      country: p.countryCode ?? "",
      steamid: p.steamId ?? "",
      team: teamId ?? "",
      extra: {},
    };
  }

  private currentMatch(): Record<string, unknown> | null {
    const m = this.e.activeMatch();
    if (!m) return null;
    const hud = this.e.hudState(libraryOutputId("matchframe-default"));
    const leftId = hud?.left.teamId ?? m.teamAId;
    const rightId = hud?.right.teamId ?? m.teamBId;
    const winsOf = (id: string | null) => (id === m.teamAId ? m.seriesScoreA : id === m.teamBId ? m.seriesScoreB : 0);
    const maps = this.e.mapInstances.forMatch(m.id);
    return {
      id: m.id,
      current: true,
      matchType: `bo${m.format.bestOf}`,
      left: { id: leftId, wins: winsOf(leftId) },
      right: { id: rightId, wins: winsOf(rightId) },
      vetos: maps.map((mi) => ({
        teamId: mi.pickedByTeamId ?? "",
        mapName: mi.mapName,
        side: "NO",
        type: mi.isDecider ? "decider" : "pick",
        reverseSide: false,
        mapEnd: mi.status === "completed",
        winner: mi.winnerTeamId ?? undefined,
        score: { [m.teamAId]: mi.scoreA, [m.teamBId]: mi.scoreB },
      })),
    };
  }

  /** GET /api/... for LHM HUDs; false when the path is not one of them. */
  handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): boolean {
    if (!path.startsWith("/api/")) return false;
    if (this.allowedHuds(req).length === 0) {
      json(res, 401, { error: "unauthorized", message: "open the HUD through its Matchframe URL" });
      return true;
    }
    const seg = path.slice("/api/".length).split("/").map((s) => decodeURIComponent(s));
    const teams = () => this.e.teams.list().map((d) => d.data);
    if (seg[0] === "match" && (seg.length === 1 || seg[1] === "current")) {
      const m = this.currentMatch();
      json(res, 200, seg.length === 1 ? (m ? [m] : []) : m);
    } else if (seg[0] === "teams" && seg[1] === "logo" && seg[2]) {
      const t = this.e.teams.get(seg[2])?.data;
      const url = t?.logoAssetId ? this.e.assetUrl(t.logoAssetId) : null;
      if (!url) json(res, 404, { error: "not_found" });
      else res.writeHead(302, { location: url, "cache-control": "no-store" }).end();
    } else if (seg[0] === "teams" && seg[1]) {
      const t = this.e.teams.get(seg[1])?.data;
      json(res, t ? 200 : 404, t ? this.team(t) : { error: "not_found" });
    } else if (seg[0] === "teams") {
      json(res, 200, teams().map((t) => this.team(t)));
    } else if (seg[0] === "players" && seg[1] === "avatar" && seg[2] === "steamid" && seg[3]) {
      const p = this.e.players.list().find((d) => d.data.steamId === seg[3])?.data;
      json(res, 200, { custom: p && p.photoVisible && p.avatarAssetId ? this.e.assetUrl(p.avatarAssetId) : "", steam: "" });
    } else if (seg[0] === "players") {
      const ids = (query.get("steamids") ?? "").split(";").filter(Boolean);
      const list = this.e.players.list().map((d) => d.data).filter((p) => p.steamId && (ids.length === 0 || ids.includes(p.steamId)));
      json(res, 200, list.map((p) => this.player(p)));
    } else if (seg[0] === "tournament") {
      json(res, 200, null);
    } else if (seg[0] === "camera") {
      // Player cams: the match's players (each HUD makes a place for their cam).
      const players = this.e.cams.settings().enabled ? this.e.cams.rosterPlayers() : [];
      json(res, 200, { uuid: LHM_CAM_UUID, availablePlayers: players.map((p) => ({ steamid: p.steamId, label: p.name })) });
    } else if (seg[0] === "radar" && seg[1] === "maps") {
      // Older template HUDs (kaiHUD) bundle their radars and only add maps they lack from here: the
      // maps with no radar drawing, from their map pack's outline.
      json(res, 200, Object.fromEntries([...this.outlineRadars()].map(([name, r]) => [name, { config: r.config, file: `/api/game-maps/cs2/image/${encodeURIComponent(name)}/radar` }])));
    } else if (seg[0] === "game-maps" && seg[1] === "cs2" && seg.length === 2) {
      // Newer template HUDs load radars from LHM: Matchframe's built-in radars, then the maps with no
      // radar drawing from their map pack's outline, in that shape.
      const map = (name: string, radars: { lhmId: string; originX: number; originY: number; pxPerUX: number; pxPerUY: number; visibleUnderHeight: number | null; visibleOverHeight: number | null }[]) => ({
        _id: name,
        name,
        lhmId: name,
        game: "cs2",
        inVetoPool: true,
        isActive: true,
        radars: radars.map((r, i) => ({ id: i, ...r, radar: "radar" })),
      });
      json(res, 200, [
        ...this.e.radars.maps.map((name) => {
          const r = this.e.radars.get(name)!;
          return map(name, r.layers.map((l) => ({ lhmId: r.layers.length > 1 ? l.id : "default", originX: l.originX, originY: l.originY, pxPerUX: l.pxPerUX, pxPerUY: l.pxPerUY, visibleUnderHeight: l.zMin ?? null, visibleOverHeight: l.zMax ?? null })));
        }),
        ...[...this.outlineRadars()].map(([name, r]) => map(name, [{ lhmId: "default", originX: r.config.origin.x, originY: r.config.origin.y, pxPerUX: r.config.pxPerUX, pxPerUY: r.config.pxPerUY, visibleUnderHeight: null, visibleOverHeight: null }])),
      ]);
    } else if (seg[0] === "game-maps" && seg[1] === "cs2" && seg[2] === "image" && seg[3] && seg[4] === "radar") {
      const r = this.e.radars.get(seg[3]);
      const outline = r ? null : this.outlineRadars().get(seg[3]);
      if (r) res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }).end(readFileSync(r.file));
      else if (outline) res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-cache" }).end(outline.svg);
      else json(res, 404, { error: "not_found" });
    } else {
      json(res, 404, { error: "not_found", message: "not part of Matchframe's LHM compatibility layer" });
    }
    return true;
  }
}
