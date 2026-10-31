import { useEffect, useRef, useState } from "react";
import type { HudReplayClip, ReplayGraphicView } from "@matchframe/hud-sdk";
import { REPLAY_GRAPHIC_OFF, ReplayGraphicSequencer } from "@matchframe/hud-sdk";

/**
 * The replay graphic's tag and lower third for the clip on air (`state.replay.clip`), timed by the
 * HUD SDK's sequencer: in a moment after a clip starts, swapped per clip, out when the replays end.
 * Shared by Matchframe's HUDs (the Vector and Lineup HUDs import it).
 */
export function useReplayGraphic(clip: HudReplayClip | null): ReplayGraphicView {
  const [view, setView] = useState<ReplayGraphicView>(REPLAY_GRAPHIC_OFF);
  const seq = useRef<ReplayGraphicSequencer | null>(null);
  seq.current ??= new ReplayGraphicSequencer(setView);
  useEffect(() => {
    seq.current!.update(clip);
  });
  useEffect(() => () => seq.current?.dispose(), []);
  return view;
}

/**
 * The colour of the clip's player: their team's own colour, else the colour of the side they played
 * in that round (`colors`: the HUD's CT and T colours), else `neutral`.
 */
export function clipColor(clip: HudReplayClip, colors: { ct: string; t: string }, neutral: string): string {
  if (clip.team?.color) return clip.team.color;
  return clip.side === "CT" ? colors.ct : clip.side === "T" ? colors.t : neutral;
}

/** Who died, in a line; for a clutch without them, the round won. */
export function clipVictims(clip: HudReplayClip): string | null {
  if (clip.victims.length) return clip.victims.join(", ");
  return clip.clutchVersus !== null ? "Won the round" : null;
}

/** Up to four letters for a team without a logo. */
export const teamMonogram = (team: NonNullable<HudReplayClip["team"]>): string => (team.shortName || team.name).slice(0, 4).toUpperCase();

/** The page is the replay layer: the `replay` entry point (`variant=replay`), `layer=replay`, or `demo=replay`. */
export function isReplayLayer(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  const q = new URLSearchParams(search);
  return q.get("variant") === "replay" || q.get("layer") === "replay" || q.get("demo") === "replay";
}
