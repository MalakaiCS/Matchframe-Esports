import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HudReplayClip } from "./state.ts";
import type { ReplayGraphicView } from "./replay.ts";
import { multiKillTag, replayBadge, ReplayGraphicSequencer } from "./replay.ts";

const clip = (id: string, over: Partial<HudReplayClip> = {}): HudReplayClip => ({
  id,
  roundNumber: 14,
  label: `3K: nova ▸ a, b, c`,
  player: { steamId: "76561198000000001", name: "nova" },
  team: { key: "left", name: "Northern Lights", shortName: "NRL", logoUrl: null, color: null },
  side: "CT",
  weapon: { name: "weapon_ak47", displayName: "AK-47" },
  headshot: true,
  victims: ["a", "b", "c"],
  kills: 3,
  multiKill: "3K",
  clutchVersus: null,
  ...over,
});

describe("replay graphic timing", () => {
  let views: ReplayGraphicView[];
  let seq: ReplayGraphicSequencer;
  const last = () => views[views.length - 1]!;
  beforeEach(() => {
    vi.useFakeTimers();
    views = [];
    seq = new ReplayGraphicSequencer((v) => views.push(v), { tagInMs: 300, cardInMs: 700, outMs: 500 });
  });
  afterEach(() => {
    seq.dispose();
    vi.useRealTimers();
  });

  it("brings the tag and the lower third in a moment after a clip starts, and takes them out after", () => {
    seq.update(null);
    expect(views).toEqual([]);
    seq.update(clip("a"));
    expect(views).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(views).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(last()).toEqual({ tag: "in", card: null });
    vi.advanceTimersByTime(400);
    expect(last()).toMatchObject({ tag: "in", card: { state: "in", clip: { id: "a" } } });
    // The same clip in the next state: nothing moves.
    const n = views.length;
    seq.update(clip("a"));
    expect(views.length).toBe(n);
    seq.update(null);
    expect(last()).toMatchObject({ tag: "out", card: { state: "out", clip: { id: "a" } } });
    vi.advanceTimersByTime(500);
    expect(last()).toEqual({ tag: "off", card: null });
  });

  it("swaps the lower third for each clip of a break's replays, the tag staying", () => {
    seq.update(clip("a"));
    vi.advanceTimersByTime(700);
    seq.update(clip("b", { label: "nova ▸ d", kills: 1, multiKill: null, victims: ["d"] }));
    expect(last()).toMatchObject({ tag: "in", card: { state: "out", clip: { id: "a" } } });
    vi.advanceTimersByTime(699);
    expect(last().card?.clip.id).toBe("a");
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ tag: "in", card: { state: "in", clip: { id: "b", victims: ["d"] } } });
    expect(views.every((v) => v.tag === "in")).toBe(true);
  });

  it("shows what changed about the same clip, and comes back in when a clip starts while it goes out", () => {
    seq.update(clip("a", { side: null }));
    vi.advanceTimersByTime(700);
    seq.update(clip("a", { side: "T" }));
    expect(last().card?.clip.side).toBe("T");
    seq.update(null);
    vi.advanceTimersByTime(200);
    seq.update(clip("c"));
    vi.advanceTimersByTime(700);
    expect(last()).toMatchObject({ tag: "in", card: { state: "in", clip: { id: "c" } } });
    // The earlier "off" never came.
    expect(views.some((v) => v.tag === "off")).toBe(false);
  });

  it("names the play", () => {
    expect([1, 2, 3, 4, 5].map((k) => multiKillTag(k))).toEqual([null, "2K", "3K", "4K", "ACE"]);
    expect(multiKillTag(null)).toBeNull();
    expect(replayBadge(clip("a", { clutchVersus: 3, multiKill: null, kills: null }))).toBe("1V3 CLUTCH");
    expect(replayBadge(clip("a", { multiKill: "ACE" }))).toBe("ACE");
    expect(replayBadge(clip("a", { multiKill: null }))).toBeNull();
  });
});
