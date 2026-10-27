import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ObsManager } from "@matchframe/obs-adapter";
import { probeMedia } from "./media.ts";
import type { CaptureRequest, ClipRecord, ReplayProvider, ReplayProviderCapabilities, ReplaySource } from "./provider.ts";

/**
 * Captured-program fallback using the OBS replay buffer. It stores only the configured OBS
 * output — i.e. the program angle — never other player POVs.
 */
export class ObsReplayBufferProvider implements ReplayProvider {
  readonly id = "obs-replay-buffer";
  readonly kind = "obs_replay_buffer" as const;
  private clips = new Map<string, ClipRecord>();
  private counter = 0;

  constructor(
    private readonly obs: ObsManager,
    private readonly opts: { bufferSeconds: number | null; ffprobe?: string; wait?: (ms: number) => Promise<void> } = { bufferSeconds: null },
  ) {}

  async capabilities(): Promise<ReplayProviderCapabilities> {
    return {
      health: true,
      listSources: true,
      bufferRange: this.opts.bufferSeconds !== null,
      capture: true,
      prepare: true,
      preview: false,
      playout: true,
      cancel: false,
      export: true,
      limitations: [
        "Program angle only (whatever OBS recorded); no additional player angles.",
        "Clip match-time range is estimated from the save time and buffer length.",
      ],
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.obs.state.connected) return { ok: false, detail: "OBS not connected" };
    if (!this.obs.state.replayBuffer) return { ok: false, detail: "OBS replay buffer is not running" };
    return { ok: true, detail: "replay buffer active" };
  }

  async listSources(): Promise<ReplaySource[]> {
    return [{ id: "program", name: "OBS program output", angle: "program", available: this.obs.state.replayBuffer === true }];
  }

  async bufferRange(): Promise<{ fromMs: number; toMs: number } | null> {
    if (this.opts.bufferSeconds === null) return null;
    const now = Date.now();
    return { fromMs: now - this.opts.bufferSeconds * 1000, toMs: now };
  }

  async capture(req: CaptureRequest): Promise<ClipRecord[]> {
    const h = await this.health();
    if (!h.ok) throw new Error(h.detail);
    // Wait for the post-roll to be recorded before saving.
    if (req.postRollMs > 0) await (this.opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(req.postRollMs);
    const { savedPath } = await this.obs.saveReplayBuffer();
    const media = await probeMedia(savedPath, this.opts.ffprobe);
    const clipId = `clip_obs_${Date.now().toString(36)}_${this.counter++}`;
    const duration = media.durationMs;
    const clip: ClipRecord = {
      clipId,
      providerId: this.id,
      sourceId: "program",
      angle: "program",
      matchTimeFromMs: req.matchTimeMs !== null && duration !== null ? req.matchTimeMs + req.postRollMs - duration : null,
      matchTimeToMs: req.matchTimeMs !== null ? req.matchTimeMs + req.postRollMs : null,
      timeUncertaintyMs: (req.timeUncertaintyMs ?? 500) + 500,
      epoch: req.epoch,
      roundNumber: req.roundNumber,
      media,
      createdAt: new Date().toISOString(),
    };
    this.clips.set(clipId, clip);
    return [clip];
  }

  async cancel(): Promise<void> {
    throw new Error("OBS replay saves cannot be cancelled once requested");
  }

  async exportClip(clipId: string, destDir: string): Promise<string> {
    const c = this.clips.get(clipId);
    if (!c?.media.path) throw new Error("clip has no media file");
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, basename(c.media.path));
    copyFileSync(c.media.path, dest);
    return dest;
  }
}
