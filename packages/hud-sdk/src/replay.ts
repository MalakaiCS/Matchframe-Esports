import type { HudReplayClip } from "./state.ts";

/**
 * What a replay graphic shows at a moment: the "REPLAY" tag and the lower third with its clip.
 * `in` means on screen (or coming in); `out` means leaving; the HUD animates each change.
 */
export interface ReplayGraphicView {
  tag: "off" | "in" | "out";
  card: { clip: HudReplayClip; state: "in" | "out" } | null;
}

export const REPLAY_GRAPHIC_OFF: ReplayGraphicView = { tag: "off", card: null };

/** When things move (ms): the tag and the lower third come in a moment after a clip starts. */
export interface ReplayGraphicTiming {
  /** From a clip starting to the tag coming in. */
  tagInMs: number;
  /** From a clip starting to its lower third coming in (also the next clip's, in a break's replays). */
  cardInMs: number;
  /** From the replays ending to the graphic being gone (the HUD's out animation fits in it). */
  outMs: number;
}

export const REPLAY_GRAPHIC_TIMING: ReplayGraphicTiming = { tagInMs: 350, cardInMs: 750, outMs: 500 };

/**
 * Times a replay graphic from `HudState.replay.clip` as it changes: a clip comes on air, so the tag
 * and its lower third come in a moment later; the next clip of a break's replays, so the lower third
 * goes out and comes back with the new clip (the tag stays); the replays end, so both go out. Feed
 * it every state (`update`); the same clip again changes nothing, unless what it shows changed.
 */
export class ReplayGraphicSequencer {
  private view: ReplayGraphicView = REPLAY_GRAPHIC_OFF;
  private clip: HudReplayClip | null = null;
  private key = "";
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly onView: (view: ReplayGraphicView) => void,
    private readonly timing: ReplayGraphicTiming = REPLAY_GRAPHIC_TIMING,
  ) {}

  get current(): ReplayGraphicView {
    return this.view;
  }

  update(clip: HudReplayClip | null): void {
    const key = clip ? JSON.stringify(clip) : "";
    if (key === this.key) return;
    this.key = key;
    const before = this.clip;
    this.clip = clip;
    if (clip && before && clip.id === before.id) {
      // The same clip with something new (its team, its side): shown as it is now.
      if (this.view.card?.clip.id === clip.id) this.set({ ...this.view, card: { ...this.view.card, clip } });
      return;
    }
    this.clear();
    if (!clip) {
      if (this.view.tag === "off" && !this.view.card) return;
      this.set({ tag: this.view.tag === "off" ? "off" : "out", card: this.view.card ? { ...this.view.card, state: "out" } : null });
      this.later(this.timing.outMs, () => this.set(REPLAY_GRAPHIC_OFF));
      return;
    }
    // Another clip: the lower third of the one before goes (the tag stays), and the new one comes in.
    if (this.view.card?.state === "in") this.set({ ...this.view, card: { ...this.view.card, state: "out" } });
    if (this.view.tag !== "in") this.later(this.timing.tagInMs, () => this.set({ ...this.view, tag: "in" }));
    this.later(this.timing.cardInMs, () => this.set({ tag: "in", card: { clip: this.clip ?? clip, state: "in" } }));
  }

  /** Stops its timers (the page is going away). */
  dispose(): void {
    this.clear();
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private set(view: ReplayGraphicView): void {
    this.view = view;
    this.onView(view);
  }
}

/** "2K", "3K", "4K", "ACE" for two kills or more; null otherwise. */
export function multiKillTag(kills: number | null): HudReplayClip["multiKill"] {
  if (kills === null || kills < 2) return null;
  return kills >= 5 ? "ACE" : (`${kills}K` as "2K" | "3K" | "4K");
}

/** The play in a few words for a badge: "1V3 CLUTCH", "ACE", "3K", "HEADSHOT", or null for a plain kill. */
export function replayBadge(clip: HudReplayClip): string | null {
  if (clip.clutchVersus !== null) return `1V${clip.clutchVersus} CLUTCH`;
  if (clip.multiKill) return clip.multiKill;
  return null;
}
