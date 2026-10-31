import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { HudKillfeedEntry, HudReplayClip, HudSide } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
import { mapDisplayName } from "../live/projection.ts";
import { clipScore, type RankFacts } from "./rank.ts";
import { replayClip, type ClipTeam } from "./graphic.ts";

/**
 * Clips kept for highlight reels (ADR-061). The replay queue and its clip files are short-lived: the
 * queue keeps 200 items in memory, and the replay PC's files are deleted when they drop off it or
 * when more than 120 newer ones arrived. So every clip with a file is kept here as soon as it is in
 * the queue, under `<data>/highlights/clips/<map>/`: a hard link to the same file (no extra space,
 * and it survives the original's deletion), or a copy when the file is on another drive. Kept: the
 * current and the previous map, at most `keepGb` together (unplayed clips go first, then the oldest
 * played). With each map, its kills (killer, side, victim, when) and round winners, for the replay
 * ranking's score, round order and the side a player had in a round.
 */

/** Maps kept: the current one and the one before. */
export const KEEP_MAPS = 2;
export const DEFAULT_KEEP_GB = 3;
/** Kills kept per map (a long overtime map has some 300). */
const KEEP_KILLS = 800;
const TICK_MS = 2000;

export interface KeptKill {
  round: number;
  killer: string;
  side: HudSide | null;
  /** The victim's name, as in a clip's play. */
  victim: string;
  /** Wall clock (ms). */
  at: number;
}

export interface KeptClip {
  id: string;
  label: string;
  reason: string;
  roundNumber: number | null;
  createdAt: string;
  origin: QueueItem["origin"];
  play: ReplayPlay | null;
  played: boolean;
  /** The kept file, relative to `root`. */
  file: string;
  /** The clips folder it was kept in (Storage can move new ones to another drive); older entries: the data folder's. */
  root?: string;
  bytes: number;
  playMs: number | null;
  leadMs: number | null;
  trim: { startMs: number; durationMs: number } | null;
  media: { durationMs: number | null; width: number | null; height: number | null; frameRate: number | null; hasAudio: boolean | null };
  /** The player's team and side in that round, as known when the clip came in (filled in later when they weren't). */
  team: ClipTeam | null;
  side: HudSide | null;
  /** When its play happened (wall ms): its first kill as this computer saw it, else estimated. */
  killAt: number;
}

export interface KeptMap {
  key: string;
  mapName: string;
  matchId: string | null;
  /** "Team A vs Team B" when known. */
  title: string | null;
  startedAt: string;
  kills: KeptKill[];
  /** Round winners by side ("CT"/"T"). */
  winners: Record<string, HudSide>;
  clips: KeptClip[];
}

interface Index {
  version: 1;
  maps: KeptMap[];
}

export interface HighlightSettings {
  /** Disk space for kept clips (GB), the current and previous map together. */
  keepGb: number;
}

/** A clip of a reel, as planned. */
export interface ReelClip {
  id: string;
  label: string;
  roundNumber: number | null;
  played: boolean;
  score: number;
  reasons: string[];
  /** The part shown (ms), and where it starts in the file. */
  startMs: number;
  durationMs: number;
  /** For the burned-in lower third. */
  graphic: HudReplayClip;
}

export interface ReelPlan {
  mapKey: string;
  mapName: string;
  displayName: string;
  title: string | null;
  clips: ReelClip[];
  fadeMs: number;
  /** The reel's length: the clips less the crossfades. */
  totalMs: number;
}

export interface ReelChoice {
  /** The map's key; null for the current (latest) map. */
  map: string | null;
  /** Every played clip, or the best N. */
  count: "all" | number;
  /** With the best N: also clips that weren't played. */
  unplayed: boolean;
  fadeMs: number;
}

const playable = (s: QueueItem["state"]) => s === "prepared" || s === "approved" || s === "playing" || s === "played";

export class HighlightStore {
  private index: Index = { version: 1, maps: [] };
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Copies under way (a clip on another drive), by queue item id. */
  private copying = new Set<string>();
  /**
   * Queue items already handled, with the map they came in on: kept, or left out. One left out for
   * space while it wasn't played comes back if it plays; anything else isn't kept again.
   */
  private seen = new Map<string, { map: string; again: boolean }>();
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly e: Engine) {
    this.load();
  }

  get dir(): string {
    return join(this.e.cfg.dataDir, "highlights");
  }

  /** Where new clips are kept: the chosen highlights folder's "Kept clips", else the data folder's. */
  private get clipsDir(): string {
    const chosen = this.e.storageFolders().highlights;
    return chosen ? join(chosen, "Kept clips") : this.defaultClipsDir;
  }

  private get defaultClipsDir(): string {
    return join(this.dir, "clips");
  }

  settings(): HighlightSettings {
    const v = this.e.settings.get<Partial<HighlightSettings>>("highlights.settings", {});
    const gb = typeof v.keepGb === "number" && Number.isFinite(v.keepGb) ? v.keepGb : DEFAULT_KEEP_GB;
    return { keepGb: Math.max(0.5, Math.min(500, gb)) };
  }

  setSettings(patch: Partial<HighlightSettings>): HighlightSettings {
    this.e.settings.set("highlights.settings", { ...this.settings(), ...patch });
    this.prune();
    this.save();
    return this.settings();
  }

  start(): void {
    this.cleanup.push(this.e.onKill((k) => this.noteKill(k)));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const fn of this.cleanup.splice(0)) fn();
    this.save();
  }

  /** The kept maps, oldest first. */
  maps(): KeptMap[] {
    return this.index.maps;
  }

  /** The map being played (the latest seen). */
  current(): KeptMap | null {
    return this.index.maps[this.index.maps.length - 1] ?? null;
  }

  map(key: string | null): KeptMap | null {
    return key ? (this.index.maps.find((m) => m.key === key) ?? null) : this.current();
  }

  /** The map before the current one, or null. */
  previous(): KeptMap | null {
    return this.index.maps[this.index.maps.length - 2] ?? null;
  }

  /** A kept clip by its id (the replay list's), with its map. */
  find(id: string): { map: KeptMap; clip: KeptClip } | null {
    for (const map of this.index.maps) {
      const clip = map.clips.find((c) => c.id === id);
      if (clip) return { map, clip };
    }
    return null;
  }

  /** The last round a map has anything of (a round won, a kill, a clip). */
  lastRound(map: KeptMap): number | null {
    const rounds = [...Object.keys(map.winners).map(Number), ...map.kills.map((k) => k.round), ...map.clips.map((c) => c.roundNumber ?? 0)].filter((r) => Number.isFinite(r) && r > 0);
    return rounds.length ? Math.max(...rounds) : null;
  }

  /**
   * A kept clip as a replay list item, for playing it on air (highlights, ADR-063): its kept file,
   * the part replays show (playMs, the play and its lead-up, from the end), its play. Not added to
   * the list.
   */
  asItem(c: KeptClip): QueueItem {
    const m = c.media;
    return {
      id: c.id,
      state: "prepared",
      label: c.label,
      reason: c.reason,
      roundNumber: c.roundNumber,
      createdAt: c.createdAt,
      clip: { clipId: `kept_${c.id}`, providerId: "highlights", sourceId: "highlights", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: c.roundNumber, media: { path: this.filePath(c), durationMs: m.durationMs, frameRate: m.frameRate, timebase: null, startPts: null, hasAudio: m.hasAudio, width: m.width, height: m.height }, createdAt: c.createdAt },
      error: null,
      order: 0,
      trim: null,
      origin: c.origin,
      priority: 0,
      playMs: c.playMs,
      leadMs: c.leadMs,
      play: c.play,
    };
  }

  filePath(c: KeptClip): string {
    return join(c.root ?? this.defaultClipsDir, c.file);
  }

  totalBytes(): number {
    return this.index.maps.reduce((n, m) => n + m.clips.reduce((k, c) => k + c.bytes, 0), 0);
  }

  // ------------------------------------------------------------------ what happens in the game

  /** The map being played; a new one starts when the map (or the match) changes. */
  private follow(): KeptMap | null {
    const s = this.e.session.state();
    const mapName = s?.mapName ?? null;
    const match = this.e.activeMatch();
    let cur = this.current();
    if (mapName && (!cur || cur.mapName !== mapName || (match && cur.matchId && cur.matchId !== match.id))) {
      const teams = match ? [match.teamAId, match.teamBId].map((id) => this.e.teams.get(id)?.data.name).filter(Boolean) : [];
      cur = { key: `m${Date.now().toString(36)}`, mapName, matchId: match?.id ?? null, title: teams.length === 2 ? teams.join(" vs ") : null, startedAt: new Date().toISOString(), kills: [], winners: {}, clips: [] };
      this.index.maps.push(cur);
      this.dirty = true;
      this.prune();
    }
    if (cur && s && s.mapName === cur.mapName) {
      for (const r of s.roundHistory) {
        if (r.winnerSide && cur.winners[r.roundNumber] !== r.winnerSide) {
          cur.winners[r.roundNumber] = r.winnerSide;
          this.dirty = true;
        }
      }
      if (!cur.title) {
        const names = [s.teams.CT.name, s.teams.T.name].filter((n): n is string => !!n);
        if (names.length === 2) {
          cur.title = names.join(" vs ");
          this.dirty = true;
        }
      }
    }
    return cur;
  }

  noteKill(k: HudKillfeedEntry): void {
    if (!k.killer || k.killer.steamId === k.victim.steamId) return;
    const round = this.e.session.state()?.roundNumber ?? null;
    const cur = this.follow();
    if (!cur || round === null) return;
    cur.kills.push({ round, killer: k.killer.steamId, side: k.killer.side, victim: k.victim.name, at: Date.now() });
    if (cur.kills.length > KEEP_KILLS) cur.kills.splice(0, cur.kills.length - KEEP_KILLS);
    this.dirty = true;
  }

  /** The first kill of a play (its killer's, of one of its victims) in a round of a map. */
  firstKill(map: KeptMap | null, round: number | null, play: ReplayPlay | null): KeptKill | null {
    const killer = play?.killer?.steamId;
    if (!map || round === null || !killer) return null;
    return map.kills.find((k) => k.round === round && k.killer === killer && (play.victims.length === 0 || play.victims.includes(k.victim))) ?? null;
  }

  /** The side a player had in a round, from the kills seen in it (the clip's own, else any of theirs). */
  sideIn(map: KeptMap | null, round: number | null, play: ReplayPlay | null): HudSide | null {
    const first = this.firstKill(map, round, play);
    if (first?.side) return first.side;
    const killer = play?.killer?.steamId;
    if (!map || round === null || !killer) return null;
    return map.kills.find((k) => k.round === round && k.killer === killer && k.side)?.side ?? null;
  }

  /** Keeps the queue's clips (played ones and those that may still play), and follows their state. */
  tick(): void {
    const cur = this.follow();
    const byId = new Map<string, { map: KeptMap; clip: KeptClip }>();
    for (const m of this.index.maps) for (const c of m.clips) byId.set(c.id, { map: m, clip: c });
    const queue = this.e.replays.list();
    const inQueue = new Set(queue.map((i) => i.id));
    for (const id of this.seen.keys()) if (!inQueue.has(id)) this.seen.delete(id);
    for (const it of queue) {
      const kept = byId.get(it.id);
      if (kept) {
        if (it.state === "rejected" || it.state === "failed") {
          // Turned down after it came in: no use for a reel unless it was on air.
          if (!kept.clip.played) this.drop(kept.map, kept.clip);
          continue;
        }
        const played = kept.clip.played || it.state === "played";
        if (played !== kept.clip.played || it.label !== kept.clip.label || JSON.stringify(it.trim) !== JSON.stringify(kept.clip.trim)) {
          Object.assign(kept.clip, { played, label: it.label, trim: it.trim });
          this.dirty = true;
        }
        if (!kept.clip.side && kept.clip.play) {
          const side = this.sideIn(kept.map, kept.clip.roundNumber, kept.clip.play);
          if (side) {
            kept.clip.side = side;
            this.dirty = true;
          }
        }
        continue;
      }
      if (!it.clip?.media.path || this.copying.has(it.id)) continue;
      const seen = this.seen.get(it.id);
      if (seen) {
        const home = this.index.maps.find((m) => m.key === seen.map);
        if (home && seen.again && it.state === "played") {
          seen.again = false;
          this.keep(home, it);
        }
        continue;
      }
      if (!cur || !playable(it.state)) continue;
      this.seen.set(it.id, { map: cur.key, again: false });
      this.keep(cur, it);
    }
    this.prune();
    this.save();
  }

  private keep(map: KeptMap, it: QueueItem): void {
    const src = it.clip!.media.path!;
    if (!existsSync(src)) return;
    const rel = `${map.key}/${it.id}${extname(src) || ".mp4"}`;
    const root = this.clipsDir;
    const dest = join(root, rel);
    mkdirSync(join(root, map.key), { recursive: true });
    const add = () => {
      if (!this.index.maps.includes(map)) return;
      const first = this.firstKill(map, it.roundNumber, it.play);
      const playMs = it.playMs ?? it.clip?.media.durationMs ?? null;
      const s = this.e.session.state();
      const player = it.play?.killer ? s?.players.find((p) => p.steamId === it.play!.killer!.steamId) : undefined;
      // The side now is the side in the clip's round while that round is the one being played.
      const sideNow = player?.side && it.roundNumber !== null && it.roundNumber === s?.roundNumber ? player.side : null;
      const media = it.clip!.media;
      const clip: KeptClip = {
        id: it.id,
        label: it.label,
        reason: it.reason,
        roundNumber: it.roundNumber,
        createdAt: it.createdAt,
        origin: it.origin,
        play: it.play,
        played: it.state === "played",
        file: rel,
        root,
        bytes: statSync(dest).size,
        playMs: it.playMs,
        leadMs: it.leadMs ?? null,
        trim: it.trim,
        media: { durationMs: media.durationMs, width: media.width, height: media.height, frameRate: media.frameRate, hasAudio: media.hasAudio },
        team: it.play?.killer ? this.e.replayGraphic.teamOf(it.play.killer.steamId) : null,
        side: this.sideIn(map, it.roundNumber, it.play) ?? sideNow,
        killAt: first?.at ?? Date.parse(it.createdAt) - Math.max(0, (playMs ?? 0) - (it.leadMs ?? 0)),
      };
      map.clips.push(clip);
      this.dirty = true;
    };
    try {
      rmSync(dest, { force: true });
      linkSync(src, dest);
      add();
    } catch {
      // Another drive (or no hard links there): a copy, in the background.
      this.copying.add(it.id);
      void copyFile(src, `${dest}.part`)
        .then(() => {
          renameSync(`${dest}.part`, dest);
          add();
          this.prune();
          this.save();
        })
        .catch((err) => {
          rmSync(`${dest}.part`, { force: true });
          this.e.logger.warn("highlights: could not keep a clip", { id: it.id, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => this.copying.delete(it.id));
    }
  }

  private drop(map: KeptMap, clip: KeptClip): void {
    rmSync(this.filePath(clip), { force: true });
    map.clips = map.clips.filter((c) => c !== clip);
    this.dirty = true;
  }

  /**
   * Only the current and the previous map; then, over the space allowed, clips that weren't played
   * go first (the previous map's first), then the oldest played ones.
   */
  prune(): void {
    while (this.index.maps.length > KEEP_MAPS) {
      const old = this.index.maps.shift()!;
      for (const root of new Set([this.clipsDir, ...old.clips.map((c) => c.root ?? this.defaultClipsDir)])) rmSync(join(root, old.key), { recursive: true, force: true });
      this.dirty = true;
    }
    const cap = this.settings().keepGb * 1024 ** 3;
    let total = this.totalBytes();
    if (total <= cap) return;
    const order = (played: boolean) => this.index.maps.flatMap((m) => m.clips.filter((c) => c.played === played).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((c) => ({ m, c })));
    for (const { m, c } of [...order(false), ...order(true)]) {
      if (total <= cap) break;
      total -= c.bytes;
      this.drop(m, c);
      // Left out while it wasn't played: kept again if it plays.
      if (!c.played) this.seen.set(c.id, { map: m.key, again: true });
    }
  }

  // ------------------------------------------------------------------ reels

  /** What the replay ranking says about a kept clip's kills (rank.ts), from its map's kills. */
  private facts(map: KeptMap, c: KeptClip): RankFacts {
    const play = c.play!;
    const kills = c.roundNumber !== null ? map.kills.filter((k) => k.round === c.roundNumber) : [];
    const mine = kills.filter((k) => k.killer === play.killer?.steamId && play.victims.includes(k.victim));
    const first = kills[0];
    const last = kills[kills.length - 1];
    const winner = c.roundNumber !== null ? (map.winners[c.roundNumber] ?? null) : null;
    return {
      opening: !!first && mine.includes(first),
      closing: !!last && mine.includes(last) && winner !== null && last.side === winner,
      clutchVersus: c.reason === "clutch" ? play.kills : null,
      spanMs: mine.length >= 2 ? mine[mine.length - 1]!.at - mine[0]!.at : null,
    };
  }

  /** The part of a kept clip a reel shows: its trim, else the part the replay showed (its end), else all of it. */
  part(c: KeptClip, fileMs: number | null = c.media.durationMs): { startMs: number; durationMs: number } {
    const dur = fileMs ?? c.trim?.durationMs ?? c.playMs ?? 8000;
    if (c.trim) {
      const start = Math.min(c.trim.startMs, Math.max(0, dur - 500));
      return { startMs: start, durationMs: Math.max(500, Math.min(c.trim.durationMs, dur - start)) };
    }
    if (c.playMs !== null && dur > c.playMs + 300) return { startMs: dur - c.playMs, durationMs: c.playMs };
    return { startMs: 0, durationMs: dur };
  }

  /**
   * A map's clips for a reel or for highlights on air (ADR-063): every played clip, or the best N by
   * the replay ranking's score (rank.ts), with unplayed clips too when asked; the same kills only
   * once (the better clip); only `rounds` when given (a half). In round order, and in a round by when
   * its play happened. Only clips whose kept file is there.
   */
  choose(map: KeptMap, choice: { count: "all" | number; unplayed: boolean; rounds?: { from: number; to: number } | null }): { c: KeptClip; score: number; reasons: string[] }[] {
    const inRounds = (c: KeptClip) => !choice.rounds || (c.roundNumber !== null && c.roundNumber >= choice.rounds.from && c.roundNumber <= choice.rounds.to);
    const pool = map.clips.filter((c) => (c.played || (choice.count !== "all" && choice.unplayed)) && inRounds(c) && existsSync(this.filePath(c)) && !this.copying.has(c.id));
    const scored = pool
      .map((c) => ({ c, ...(c.play ? clipScore(c.play, this.facts(map, c)) : { score: 0, reasons: [] as string[] }) }))
      .sort((a, b) => b.score - a.score || Number(b.c.played) - Number(a.c.played) || (a.c.origin === "replay_pc" ? -1 : 0) - (b.c.origin === "replay_pc" ? -1 : 0) || a.c.createdAt.localeCompare(b.c.createdAt));
    const kept: typeof scored = [];
    for (const s of scored) {
      const p = s.c.play;
      const same = p?.killer && kept.some((k) => k.c.play?.killer?.steamId === p.killer!.steamId && k.c.roundNumber === s.c.roundNumber && k.c.play.victims.some((v) => p.victims.includes(v)));
      if (!same) kept.push(s);
    }
    const chosen = choice.count === "all" ? kept : kept.slice(0, Math.max(1, choice.count));
    const at = (c: KeptClip) => this.firstKill(map, c.roundNumber, c.play)?.at ?? c.killAt;
    return chosen.sort((a, b) => (a.c.roundNumber ?? Number.MAX_SAFE_INTEGER) - (b.c.roundNumber ?? Number.MAX_SAFE_INTEGER) || at(a.c) - at(b.c));
  }

  /**
   * A map's reel: every played clip, or the best N by the replay ranking's score (rank.ts), with
   * unplayed clips too when asked; the same kills only once (the better clip). In round order, and
   * in a round by when its play happened.
   */
  plan(choice: ReelChoice): ReelPlan | null {
    this.tick();
    const map = this.map(choice.map);
    if (!map) return null;
    const chosen = this.choose(map, choice);
    const clips: ReelClip[] = chosen.map(({ c, score, reasons }) => ({
      id: c.id,
      label: c.label,
      roundNumber: c.roundNumber,
      played: c.played,
      score,
      reasons,
      ...this.part(c),
      graphic: replayClip(c, { team: c.team ?? (c.play?.killer ? this.e.replayGraphic.teamOf(c.play.killer.steamId) : null), side: c.side ?? this.sideIn(map, c.roundNumber, c.play) }),
    }));
    const fadeMs = clips.length > 1 ? clampFade(choice.fadeMs, clips.map((c) => c.durationMs)) : 0;
    const totalMs = clips.reduce((n, c) => n + c.durationMs, 0) - fadeMs * Math.max(0, clips.length - 1);
    return { mapKey: map.key, mapName: map.mapName, displayName: mapDisplayName(map.mapName) ?? map.mapName, title: map.title, clips, fadeMs, totalMs };
  }

  // ------------------------------------------------------------------ file

  private get indexFile(): string {
    return join(this.dir, "index.json");
  }

  private load(): void {
    try {
      if (!existsSync(this.indexFile)) return;
      const raw = JSON.parse(readFileSync(this.indexFile, "utf8")) as Index;
      if (raw?.version !== 1 || !Array.isArray(raw.maps)) return;
      for (const m of raw.maps) m.clips = m.clips.filter((c) => existsSync(this.filePath(c)));
      this.index = raw;
    } catch (err) {
      this.e.logger.warn("highlights: the list of kept clips couldn't be read; starting a new one", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${this.indexFile}.tmp`, JSON.stringify(this.index));
      renameSync(`${this.indexFile}.tmp`, this.indexFile);
    } catch (err) {
      this.e.logger.warn("highlights: the list of kept clips couldn't be saved", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** A crossfade no longer than a third of the shortest clip (and 2 s). */
export function clampFade(fadeMs: number, durations: number[]): number {
  const shortest = Math.min(...durations);
  return Math.max(0, Math.min(2000, Math.round(fadeMs), Math.floor(shortest / 3)));
}
