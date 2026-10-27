/**
 * Replay provider contract (spec §19.1). "Angle kind" distinguishes what a clip actually is:
 * program footage, a recorded independent angle, a delayed replay observer, or an offline demo
 * re-render. A provider only offers angles it really captured.
 */
export type AngleKind = "program" | "recorded_angle" | "delayed_observer" | "offline_render";

export interface ReplaySource {
  id: string;
  name: string;
  angle: AngleKind;
  available: boolean;
}

export interface ReplayProviderCapabilities {
  health: boolean;
  listSources: boolean;
  bufferRange: boolean;
  capture: boolean;
  prepare: boolean;
  preview: boolean;
  playout: boolean;
  cancel: boolean;
  export: boolean;
  limitations: string[];
}

export interface ClipMedia {
  path: string | null;
  durationMs: number | null;
  frameRate: number | null;
  /** Media time base / start PTS when known. */
  timebase: string | null;
  startPts: number | null;
  hasAudio: boolean | null;
  width: number | null;
  height: number | null;
}

export interface ClipRecord {
  clipId: string;
  providerId: string;
  sourceId: string;
  angle: AngleKind;
  /** Canonical match time covered by the clip, with uncertainty, when known. */
  matchTimeFromMs: number | null;
  matchTimeToMs: number | null;
  timeUncertaintyMs: number | null;
  epoch: number | null;
  roundNumber: number | null;
  media: ClipMedia;
  createdAt: string;
}

export interface CaptureRequest {
  bookmarkId: string;
  preRollMs: number;
  postRollMs: number;
  sourceIds: string[] | null;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
  epoch: number | null;
  roundNumber: number | null;
}

export interface ReplayProvider {
  readonly id: string;
  readonly kind: "existing_tool" | "obs_replay_buffer" | "test";
  capabilities(): Promise<ReplayProviderCapabilities>;
  health(): Promise<{ ok: boolean; detail: string }>;
  listSources(): Promise<ReplaySource[]>;
  bufferRange(): Promise<{ fromMs: number; toMs: number } | null>;
  capture(req: CaptureRequest): Promise<ClipRecord[]>;
  cancel(clipId: string): Promise<void>;
  exportClip(clipId: string, destDir: string): Promise<string>;
}
