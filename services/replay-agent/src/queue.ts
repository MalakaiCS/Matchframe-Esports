import type { CaptureRequest, ClipRecord, ReplayProvider } from "./provider.ts";

export type ClipState = "bookmarked" | "capturing" | "prepared" | "approved" | "playing" | "played" | "rejected" | "failed";

export interface QueueItem {
  id: string;
  state: ClipState;
  label: string;
  reason: string;
  roundNumber: number | null;
  createdAt: string;
  clip: ClipRecord | null;
  error: string | null;
  order: number;
  trim: { startMs: number; durationMs: number } | null;
  /** Which computer filmed it: this one (its program output) or the replay PC (its own observer). */
  origin: "main" | "replay_pc";
  /** Higher plays first in an automatic replay break. */
  priority: number;
  /** How much of the end of the clip to show (the moment and its lead-up); null = the whole clip. */
  playMs: number | null;
  /** Of playMs, how much comes before the first kill (the lead-up, which may be shortened to fit a break); null when unknown. */
  leadMs?: number | null;
  /** What the clip shows, when it was cut for a play. */
  play: ReplayPlay | null;
}

/** The play a clip was cut for. */
export interface ReplayPlay {
  /**
   * missed: the main camera showed neither player; other_angle: it showed the victim, this is the
   * killer; shown: it showed the killer (the replay PC films every kill); big_play: the main camera
   * showed it (3+ kills, from this computer's replay buffer).
   */
  kind: "missed" | "other_angle" | "shown" | "big_play";
  killer: { steamId: string; name: string } | null;
  victims: string[];
  kills: number;
  weapon: string | null;
  headshot: boolean;
}

/**
 * Replay queue: bookmark → capture/prepare → operator approval → playout → played.
 * Playout is operator-approved by default; the director may only suggest bookmarks.
 */
/** Errors carrying an HTTP-style status so API layers report 4xx instead of 500. */
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export class ReplayQueue {
  private items: QueueItem[] = [];
  /** Clips never listed (list, playlist), found only by their id: the Test replays button's sample clips. */
  private unlisted = new Map<string, QueueItem>();
  private counter = 0;

  constructor(
    private provider: ReplayProvider | null,
    /** Called with an item that dropped off the end of the queue (its media may be deleted). */
    private readonly onEvict?: (item: QueueItem) => void,
  ) {}

  setProvider(p: ReplayProvider | null): void {
    this.provider = p;
  }

  list(): QueueItem[] {
    return [...this.items].sort((a, b) => a.order - b.order);
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id) ?? this.unlisted.get(id);
  }

  /**
   * A clip that is never listed: not in list() (so never ranked, never in an automatic break) nor in
   * playlist() (highlights), only found by its id until removed. For sample clips played to test the
   * replay chain (replay/test-run.ts); `reason` is "test".
   */
  addUnlisted(label: string, clip: ClipRecord, extra: Partial<Pick<QueueItem, "playMs" | "leadMs" | "play">> = {}): QueueItem {
    const it: QueueItem = { id: `test_${Date.now().toString(36)}_${this.counter++}`, state: "prepared", label, reason: "test", roundNumber: null, createdAt: new Date().toISOString(), clip, error: null, order: -1, trim: null, origin: "main", priority: 0, playMs: null, play: null, ...extra };
    this.unlisted.set(it.id, it);
    return it;
  }

  /** Removes an unlisted clip (listed ones stay: they are the match's). */
  removeUnlisted(id: string): void {
    this.unlisted.delete(id);
  }

  bookmark(label: string, reason: string, roundNumber: number | null, extra: Partial<Pick<QueueItem, "priority" | "playMs" | "leadMs" | "play">> = {}): QueueItem {
    const it: QueueItem = { id: `bm_${Date.now().toString(36)}_${this.counter}`, state: "bookmarked", label, reason, roundNumber, createdAt: new Date().toISOString(), clip: null, error: null, order: this.counter++, trim: null, origin: "main", priority: 0, playMs: null, play: null, ...extra };
    return this.push(it);
  }

  /** A clip captured elsewhere (the replay PC), ready for approval. */
  addExternal(label: string, reason: string, roundNumber: number | null, clip: ClipRecord, extra: Partial<Pick<QueueItem, "priority" | "playMs" | "leadMs" | "play">> = {}): QueueItem {
    const it: QueueItem = { id: `rp_${Date.now().toString(36)}_${this.counter}`, state: "prepared", label, reason, roundNumber, createdAt: new Date().toISOString(), clip, error: null, order: this.counter++, trim: null, origin: "replay_pc", priority: 0, playMs: null, play: null, ...extra };
    return this.push(it);
  }

  private push(it: QueueItem): QueueItem {
    this.items.push(it);
    if (this.items.length > 200) {
      const gone = this.items.shift();
      if (gone) this.onEvict?.(gone);
    }
    return it;
  }

  async capture(id: string, req: Omit<CaptureRequest, "bookmarkId">): Promise<QueueItem> {
    const it = this.require(id);
    if (!this.provider) {
      it.state = "failed";
      it.error = "no replay provider configured";
      return it;
    }
    it.state = "capturing";
    try {
      const clips = await this.provider.capture({ ...req, bookmarkId: id });
      it.clip = clips[0] ?? null;
      // Rejected while capturing (a longer clip of the same play replaced it): stays rejected.
      if ((it.state as ClipState) === "rejected") return it;
      it.state = it.clip?.media.path || it.clip ? "prepared" : "failed";
      if (!it.clip) it.error = "provider returned no clip";
    } catch (e) {
      it.state = "failed";
      it.error = e instanceof Error ? e.message : String(e);
    }
    return it;
  }

  approve(id: string): QueueItem {
    const it = this.require(id);
    if (it.state !== "prepared") throw fail(409, `clip must be prepared before approval (is ${it.state})`);
    it.state = "approved";
    return it;
  }

  reject(id: string): QueueItem {
    const it = this.require(id);
    if (it.state === "playing" || it.state === "played" || it.state === "rejected") throw fail(409, `a ${it.state} clip cannot be rejected`);
    it.state = "rejected";
    return it;
  }

  setTrim(id: string, startMs: number, durationMs: number): QueueItem {
    const it = this.require(id);
    const d = it.clip?.media.durationMs;
    if (d === null || d === undefined) throw fail(409, `clip has no measured media yet (is ${it.state})`);
    if (it.state === "playing" || it.state === "played" || it.state === "rejected") throw fail(409, `a ${it.state} clip cannot be trimmed`);
    if (startMs < 0 || startMs + durationMs > d) throw fail(400, "trim outside clip duration");
    it.trim = { startMs, durationMs };
    return it;
  }

  reorder(id: string, order: number): void {
    this.require(id).order = order;
  }

  markPlaying(id: string): QueueItem {
    const it = this.require(id);
    if (it.state !== "approved") throw fail(409, "only approved clips can be played");
    it.state = "playing";
    return it;
  }

  /** Playout was requested but the mixer never reported playback: visible failure, not "played". */
  markPlaybackFailed(id: string, error: string): void {
    const it = this.get(id);
    if (it && it.state === "playing") {
      it.state = "failed";
      it.error = error;
    }
  }

  markPlayed(id: string): void {
    const it = this.get(id);
    if (it && it.state === "playing") it.state = "played";
  }

  /** Halftime/full-time highlight playlist: approved or played clips in order. */
  playlist(roundFrom?: number, roundTo?: number): QueueItem[] {
    return this.list().filter((i) => (i.state === "approved" || i.state === "played") && (roundFrom === undefined || (i.roundNumber ?? 0) >= roundFrom) && (roundTo === undefined || (i.roundNumber ?? 0) <= roundTo));
  }

  private require(id: string): QueueItem {
    const it = this.get(id);
    if (!it) throw Object.assign(new Error(`replay item ${id} not found`), { status: 404 });
    return it;
  }
}
