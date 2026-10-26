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
}

/**
 * Replay queue: bookmark → capture/prepare → operator approval → playout → played.
 * Playout is operator-approved by default; the director may only suggest bookmarks.
 */
export class ReplayQueue {
  private items: QueueItem[] = [];
  private counter = 0;

  constructor(private provider: ReplayProvider | null) {}

  setProvider(p: ReplayProvider | null): void {
    this.provider = p;
  }

  list(): QueueItem[] {
    return [...this.items].sort((a, b) => a.order - b.order);
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  bookmark(label: string, reason: string, roundNumber: number | null): QueueItem {
    const it: QueueItem = { id: `bm_${Date.now().toString(36)}_${this.counter}`, state: "bookmarked", label, reason, roundNumber, createdAt: new Date().toISOString(), clip: null, error: null, order: this.counter++, trim: null };
    this.items.push(it);
    if (this.items.length > 200) this.items.shift();
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
    if (it.state !== "prepared") throw new Error(`clip must be prepared before approval (is ${it.state})`);
    it.state = "approved";
    return it;
  }

  reject(id: string): QueueItem {
    const it = this.require(id);
    it.state = "rejected";
    return it;
  }

  setTrim(id: string, startMs: number, durationMs: number): QueueItem {
    const it = this.require(id);
    const d = it.clip?.media.durationMs;
    if (d !== null && d !== undefined && (startMs < 0 || startMs + durationMs > d)) throw new Error("trim outside clip duration");
    it.trim = { startMs, durationMs };
    return it;
  }

  reorder(id: string, order: number): void {
    this.require(id).order = order;
  }

  markPlaying(id: string): QueueItem {
    const it = this.require(id);
    if (it.state !== "approved") throw new Error("only approved clips can be played");
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
