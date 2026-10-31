import { z } from "zod";
import type { HudLibraryEntry } from "@matchframe/contracts";
import type { HudReplayClip, HudSide, HudState } from "@matchframe/hud-sdk";
import { multiKillTag } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import { displayWeaponName } from "../live/weapons.ts";

/**
 * The replay graphic (ADR-061): while a replay clip is on air, Matchframe's HUDs show a "REPLAY" tag
 * and a lower third with the play (who, weapon, headshot, victims, 2K–ACE, clutch, round) on their
 * `replay` entry point: a page that is transparent but for that, made for the replay scene. The
 * live HUD never shows it. An LHM-format HUD (kaiHUD…) has no such page: the built-in Broadcast
 * HUD's is used. The clip on air is the program's replay (played by hand, or automatic replays in
 * OBS), else the automatic replays' clip when they play in vMix.
 */

export const ReplayGraphicSettings = z.object({
  enabled: z.boolean().default(true),
  /** The HUD whose replay graphic goes in the replay scene: "auto" (the HUD in OBS) or a HUD Library id. */
  hudId: z.string().min(1).max(64).default("auto"),
});
export type ReplayGraphicSettings = z.infer<typeof ReplayGraphicSettings>;
export const ReplayGraphicPatch = z.object({ enabled: z.boolean().optional(), hudId: z.string().min(1).max(64).optional() });

/** The browser source put in the replay scene. */
export const GRAPHIC_SOURCE = "Matchframe Replay Graphic";
const BUILTIN = "matchframe-default";
const POLL_MS = 100;

export type ClipTeam = NonNullable<HudReplayClip["team"]>;

/** Where the replay graphic comes from: a HUD's own `replay` page, or the built-in one. */
export interface GraphicOutput {
  /** The HUD whose page it is. */
  hudId: string;
  hudName: string;
  /** The HUD it is for (the HUD on air, or the one chosen). */
  forHudId: string;
  forHudName: string;
  style: "own" | "builtin";
  url: string;
  /** In a few words, why this page. */
  why: string;
}

/** The weapon of a play ("ak47", "weapon_ak47") as the HUD shows it. */
export function playWeapon(weapon: string | null): HudReplayClip["weapon"] {
  const w = weapon?.trim();
  if (!w) return null;
  const name = w.startsWith("weapon_") ? w : `weapon_${w}`;
  return { name, displayName: displayWeaponName(name) };
}

/** A clip as the replay graphic shows it. */
export function replayClip(it: Pick<QueueItem, "id" | "label" | "reason" | "roundNumber" | "play">, extra: { team: ClipTeam | null; side: HudSide | null }): HudReplayClip {
  const p: ReplayPlay | null = it.play;
  const clutch = it.reason === "clutch" ? (p?.kills ?? Number(/1v(\d)/i.exec(it.label)?.[1] ?? 0)) || null : null;
  // A clutch clip counts the opponents, not the kills.
  const kills = clutch !== null ? (p?.victims.length ? p.victims.length : null) : p ? Math.max(1, p.kills) : null;
  return {
    id: it.id,
    roundNumber: it.roundNumber,
    label: it.label,
    player: p?.killer ? { steamId: p.killer.steamId || null, name: p.killer.name } : null,
    team: extra.team,
    side: extra.side,
    weapon: playWeapon(p?.weapon ?? null),
    headshot: p?.headshot ?? false,
    victims: p?.victims ?? [],
    kills,
    multiKill: multiKillTag(kills),
    clutchVersus: clutch,
  };
}

/**
 * The side a player had in another round, from the side they have now: the same in the same half,
 * the other in the other half of regulation, the same in the same half of an overtime (3 rounds);
 * null otherwise (across regulation and overtime, sides depend on the server's settings).
 */
export function sideInRound(sideNow: HudSide, roundNow: number, roundThen: number, regulation = 24): HudSide | null {
  if (roundNow === roundThen) return sideNow;
  const half = (r: number) => (r <= regulation ? (r <= regulation / 2 ? "r1" : "r2") : `ot${Math.floor((r - regulation - 1) / 3)}`);
  const a = half(roundNow);
  const b = half(roundThen);
  if (a === b) return sideNow;
  if (a.startsWith("r") && b.startsWith("r")) return sideNow === "CT" ? "T" : "CT";
  return null;
}

export class ReplayGraphic {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The automatic replays' clip on air in vMix (polled; their status is not read for every HUD push). */
  private vmixId: string | null = null;
  private lastKey = "";

  constructor(private readonly e: Engine) {}

  settings(): ReplayGraphicSettings {
    const r = ReplayGraphicSettings.safeParse(this.e.settings.get("replay.graphic", {}));
    return r.success ? r.data : ReplayGraphicSettings.parse({});
  }

  setSettings(patch: z.infer<typeof ReplayGraphicPatch>): ReplayGraphicSettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = ReplayGraphicSettings.parse({ ...this.settings(), ...given });
    this.e.settings.set("replay.graphic", next);
    this.e.refreshHuds();
    return next;
  }

  /** Watches for the clip on air changing, so HUDs get it at once (not only with the next game data). */
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    const a = this.e.autoReplay;
    if (a.settings().mixer === "vmix") {
      const st = a.getStatus();
      this.vmixId = st.state === "playing" ? (st.playing?.id ?? null) : null;
    } else this.vmixId = null;
    const id = this.onAirId();
    const it = id ? this.e.replays.get(id) : undefined;
    const key = `${this.settings().enabled}|${id ?? ""}|${it?.label ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.e.refreshHuds();
  }

  /** The replay clip on air: the program's (by hand, or automatic replays in OBS), else automatic replays' in vMix. */
  onAirId(): string | null {
    const p = this.e.program;
    if (p.mode === "REPLAY_PLAYING" && p.activeReplay) return p.activeReplay;
    return this.vmixId;
  }

  /** The clip on air for `HudState.replay.clip`, its team as `hud` shows it; null when none or turned off. */
  forHud(hud: HudState | null): HudReplayClip | null {
    if (!this.settings().enabled) return null;
    const id = this.onAirId();
    if (!id) return null;
    const it = this.e.replays.get(id);
    if (!it) return replayClip({ id, label: "Replay", reason: "manual", roundNumber: null, play: null }, { team: null, side: null });
    const steamId = it.play?.killer?.steamId ?? null;
    return replayClip(it, { team: steamId ? (this.teamInHud(hud, steamId) ?? this.teamOf(steamId)) : null, side: this.sideOf(it) });
  }

  /** The player's team as the HUD shows it (left or right). */
  private teamInHud(hud: HudState | null, steamId: string): ClipTeam | null {
    if (!hud) return null;
    const t = hud.left.players.some((p) => p.steamId === steamId) ? hud.left : hud.right.players.some((p) => p.steamId === steamId) ? hud.right : null;
    return t ? { key: t.key === "right" ? "right" : "left", name: t.name, shortName: t.shortName, logoUrl: t.logoUrl, color: t.color } : null;
  }

  /**
   * A player's team without the HUD: their team in Matchframe (roster), left or right as the active
   * match has it; else the team on the side they play now in the game data.
   */
  teamOf(steamId: string): ClipTeam | null {
    const playerId = this.e.steamIndex.lookup(steamId);
    const teamId = playerId ? this.e.roster.teamOf(playerId) : null;
    const team = teamId ? this.e.teams.get(teamId)?.data : undefined;
    const match = this.e.activeMatch();
    if (team) {
      const key = match?.teamAId === team.id ? "left" : match?.teamBId === team.id ? "right" : null;
      return { key, name: team.name, shortName: team.shortName, logoUrl: this.e.assetUrl(team.logoAssetId), color: team.primaryColor };
    }
    const s = this.e.session.state();
    const side = s?.players.find((p) => p.steamId === steamId)?.side;
    const name = side ? s?.teams[side].name : null;
    return name ? { key: null, name, shortName: name.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || name.slice(0, 4), logoUrl: null, color: null } : null;
  }

  /**
   * The side the player had in the clip's round: from the kills seen in that round (the killer's side
   * at the kill), else as kept with the clip, else their side now moved to that round (halves).
   */
  private sideOf(it: QueueItem): HudSide | null {
    const h = this.e.highlights;
    const kept = h.maps().flatMap((m) => m.clips.map((c) => ({ m, c }))).find((x) => x.c.id === it.id);
    const seen = h.sideIn(kept?.m ?? h.current(), it.roundNumber, it.play) ?? kept?.c.side ?? null;
    if (seen) return seen;
    const s = this.e.session.state();
    const side = s?.players.find((p) => p.steamId === it.play?.killer?.steamId)?.side;
    if (!side || s?.roundNumber == null || it.roundNumber === null) return null;
    return sideInRound(side, s.roundNumber, it.roundNumber, this.e.activeMatch()?.format.regulationRounds ?? 24);
  }

  // ------------------------------------------------------------------ the page in OBS

  /** The HUD the graphic is for: the one chosen, else the HUD in OBS (most recently started), else the last started, else the built-in. */
  private chosenHud(huds: HudLibraryEntry[]): HudLibraryEntry | undefined {
    const want = this.settings().hudId;
    const chosen = want !== "auto" ? huds.find((h) => h.id === want) : undefined;
    if (chosen) return chosen;
    const recent = (a: HudLibraryEntry, b: HudLibraryEntry) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || b.outputs.obs - a.outputs.obs;
    // The built-in HUD may be in OBS only as another HUD's replay graphic.
    const inObs = huds.filter((h) => h.outputs.obs > 0 && h.id !== BUILTIN).sort(recent)[0];
    return inObs ?? huds.filter((h) => h.lastUsedAt && h.id !== BUILTIN).sort(recent)[0] ?? huds.find((h) => h.id === BUILTIN);
  }

  /** The replay graphic's page: the HUD's own `replay` page, or the built-in HUD's for one without (LHM-format HUDs). */
  output(): GraphicOutput | null {
    const huds = this.e.hudLibrary.list().huds;
    const target = this.chosenHud(huds);
    const builtin = huds.find((h) => h.id === BUILTIN);
    if (!target) return null;
    const own = target.runtime !== "lhm" && !!target.urls.replay && target.status !== "error";
    const page = own ? target : builtin;
    if (!page?.urls.replay) return null;
    const why = own
      ? `${target.name} has its own replay graphic.`
      : target.runtime === "lhm"
        ? `${target.name} is an LHM-format HUD without a replay graphic: Matchframe's built-in style.`
        : `${target.name} has no replay graphic: Matchframe's built-in style.`;
    return { hudId: page.id, hudName: page.name, forHudId: target.id, forHudName: target.name, style: page.id === target.id ? "own" : "builtin", url: page.urls.replay, why };
  }

  /** Puts the replay graphic (a 1920×1080 browser source) on top of the mapped replay scene in OBS, or points it at the current page. */
  async setupObs(): Promise<{ scene: string; source: string; url: string; created: boolean; onTop: boolean; output: GraphicOutput }> {
    if (!this.e.obs.state.connected) throw new HttpError(409, "connect OBS first (Settings → Devices)", "obs_not_connected");
    const scene = this.e.program.sceneMap.REPLAY;
    if (!scene) throw new HttpError(409, "map the replay scene first: Replays → Set up OBS replay scene, or OBS scenes → Replay scene", "no_replay_scene");
    const out = this.output();
    if (!out) throw new HttpError(409, "no HUD has a replay graphic (the built-in HUD's files are missing)", "no_graphic");
    const r = await this.e.obs.provisionBrowserSource({ sceneName: scene, sourceName: GRAPHIC_SOURCE, url: out.url, width: 1920, height: 1080 });
    const items = await this.e.obs.sceneItems(scene);
    const at = items.findIndex((i) => i.sourceName === GRAPHIC_SOURCE);
    if (at < 0) throw new HttpError(409, `OBS has a source named “${GRAPHIC_SOURCE}” in another scene: add it to “${scene}” in OBS (Add → Existing), or remove it and press again`, "source_elsewhere");
    // OBS lists a scene's sources from the bottom up.
    return { scene, source: GRAPHIC_SOURCE, url: out.url, created: r.createdInput, onTop: at === items.length - 1, output: out };
  }

  /** After the HUD choice changed: the browser source Matchframe made, if OBS has it, shows the new page. */
  async repointObs(): Promise<boolean> {
    const scene = this.e.program.sceneMap.REPLAY;
    const out = this.output();
    if (!scene || !out || !this.e.obs.state.connected || !this.e.obs.state.scenes.includes(scene) || !this.e.obs.state.inputs.some((i) => i.name === GRAPHIC_SOURCE && i.kind === "browser_source")) return false;
    await this.e.obs.ensureInput({ sceneName: scene, inputName: GRAPHIC_SOURCE, inputKind: "browser_source", settings: { url: out.url, width: 1920, height: 1080 } });
    return true;
  }
}
