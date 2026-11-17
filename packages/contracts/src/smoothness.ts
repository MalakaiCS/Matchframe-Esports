/**
 * When a HUD output counts as stuttering (ADR-033, ADR-078): the HUD Library's amber flag and the
 * engine's Low-spec mode suggestion use the same rule. Plain values, no schema: the console imports
 * this file on its own (`@matchframe/contracts/smoothness`).
 */

/** An output that stopped drawing this long (ms) in the last minute is stuttering. */
export const HUD_STUTTER_MS = 250;
/** An output drawing fewer frames a second than this (its worst 5 s) looks choppy. */
export const HUD_LOW_FPS = 40;
/** Under a frame cap (Low-spec mode), an output is choppy below this share of the cap. */
export const HUD_CAPPED_FPS_SHARE = 0.8;

/** The fewest frames a second an output may draw before it looks choppy: 40, or 80 % of its frame cap. */
export function hudLowFps(frameCap: number | null | undefined): number {
  return frameCap ? Math.min(HUD_LOW_FPS, Math.round(frameCap * HUD_CAPPED_FPS_SHARE)) : HUD_LOW_FPS;
}

/** Whether an output stuttered (a pause) or drew too few frames for its frame cap. */
export function hudOutputStutters(s: { fps: number; worstPauseMs: number; frameCap?: number | null } | undefined | null): boolean {
  return !!s && (s.worstPauseMs >= HUD_STUTTER_MS || s.fps < hudLowFps(s.frameCap));
}
