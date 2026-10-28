import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { join } from "node:path";
import { Server as IoServer } from "socket.io";
import type { Player, Team } from "@matchframe/contracts";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { Engine } from "../app.ts";
import { assetDir } from "../routes/domain.ts";
import { safeResolve } from "../http/static.ts";
import { libraryOutputId } from "./library.ts";
import { hudConfig, isPanelAction, parsePanel, type LhmLookup, type LhmPanel } from "./lhm.ts";

/**
 * LHM compatibility layer: what an LHM-format HUD (Lexogrine template protocol) expects from LHM,
 * served by Matchframe's HUD server.
 *
 * - socket.io at /socket.io: "readyToRegister" → the HUD's "register" → "hud_config" (its panel
 *   settings); "update" with every game-data packet as CS2 sent it (auth token removed);
 *   "hud_action" for panel buttons; "match" when the current match changes.
 * - GET /api/... (match, teams and logos, players and avatars, tournament, camera, radar maps) from
 *   Matchframe's own data.
 *
 * LHM HUDs cannot pass Matchframe's HUD token, so the wrapper page (opened with the token) sets an
 * HttpOnly cookie per HUD; sockets and API requests without a valid cookie are refused. Everything
 * here is read-only, like the rest of the HUD server.
 */

export const lhmCookieName = (hudId: string) => `mf_lhm_${hudId}`;

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
      socket.on("register", (name: unknown) => {
        let id: string;
        try {
          id = typeof name === "string" ? decodeURIComponent(name) : "";
        } catch {
          return;
        }
        if (!allowed.includes(id)) return;
        void socket.join(`hud:${id}`);
        socket.emit("hud_config", this.config(id));
      });
      // Everything else the HUD sends ("started", camera signalling, ...) is ignored: read-only.
      socket.emit("readyToRegister");
    });
    this.cleanup.push(this.e.onRawGsi((payload) => io.emit("update", payload)));
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
      // Player cameras (WebRTC through LHM) are not available: no players offered.
      json(res, 200, { uuid: "matchframe", availablePlayers: [] });
    } else if (seg[0] === "radar" && seg[1] === "maps") {
      // Older template HUDs bundle their radars and only add maps they lack from here.
      json(res, 200, {});
    } else if (seg[0] === "game-maps" && seg[1] === "cs2" && seg.length === 2) {
      // Newer template HUDs load radars from LHM: Matchframe's built-in radars, in that shape.
      json(
        res,
        200,
        this.e.radars.maps.map((name) => {
          const r = this.e.radars.get(name)!;
          return {
            _id: name,
            name,
            lhmId: name,
            game: "cs2",
            inVetoPool: true,
            isActive: true,
            radars: r.layers.map((l, i) => ({ id: i, lhmId: r.layers.length > 1 ? l.id : "default", originX: l.originX, originY: l.originY, pxPerUX: l.pxPerUX, pxPerUY: l.pxPerUY, radar: "radar", visibleUnderHeight: l.zMin ?? null, visibleOverHeight: l.zMax ?? null })),
          };
        }),
      );
    } else if (seg[0] === "game-maps" && seg[1] === "cs2" && seg[2] === "image" && seg[3] && seg[4] === "radar") {
      const r = this.e.radars.get(seg[3]);
      if (!r) json(res, 404, { error: "not_found" });
      else res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }).end(readFileSync(r.file));
    } else {
      json(res, 404, { error: "not_found", message: "not part of Matchframe's LHM compatibility layer" });
    }
    return true;
  }
}
