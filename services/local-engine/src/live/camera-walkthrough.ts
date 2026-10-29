import type { SettingsRepo } from "../db/store.ts";
import type { LiveSession } from "./session.ts";
import type { MapRegistry } from "@matchframe/map-runtime";

/** The operator's verdict on a camera after seeing it in game. */
export type CameraVerdict = "keep" | "hide";
const REVIEW_KEY = "cameras.review";

export interface WalkthroughCamera {
  id: string;
  displayName: string;
  verdict: CameraVerdict | null;
  /** How the camera command went: shown, didn't move (getpos), or not sent. */
  result: "shown" | "failed" | "pending" | null;
  detail: string | null;
}

export interface WalkthroughStatus {
  running: boolean;
  mapName: string | null;
  secondsPer: number;
  index: number;
  cameras: WalkthroughCamera[];
}

/**
 * The camera walkthrough: every camera of the map being played, shown in turn for a few seconds
 * (as a manual camera, so the Auto Director stands back), with a Keep / Hide verdict for each.
 * Hidden cameras are never used by the director (MapRuntime.hiddenCameras); verdicts are kept per
 * map in the settings.
 */
export class CameraWalkthrough {
  private st: WalkthroughStatus = { running: false, mapName: null, secondsPer: 4, index: 0, cameras: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      maps: MapRegistry;
      session: Pick<LiveSession, "state" | "manualCamera" | "returnToPov">;
    },
  ) {
    for (const [map, verdicts] of Object.entries(this.reviews())) this.applyHidden(map, verdicts);
  }

  reviews(): Record<string, Record<string, CameraVerdict>> {
    return this.deps.settings.get<Record<string, Record<string, CameraVerdict>>>(REVIEW_KEY, {});
  }

  /** Keep, hide, or forget (null) a camera on a map. */
  review(mapName: string, cameraId: string, verdict: CameraVerdict | null): Record<string, CameraVerdict> {
    const all = this.reviews();
    const map = { ...(all[mapName] ?? {}) };
    if (verdict) map[cameraId] = verdict;
    else delete map[cameraId];
    this.deps.settings.set(REVIEW_KEY, { ...all, [mapName]: map });
    this.applyHidden(mapName, map);
    const cam = this.st.mapName === mapName ? this.st.cameras.find((c) => c.id === cameraId) : undefined;
    if (cam) cam.verdict = verdict;
    return map;
  }

  private applyHidden(mapName: string, verdicts: Record<string, CameraVerdict>): void {
    this.deps.maps.setHiddenCameras(
      mapName,
      Object.entries(verdicts)
        .filter(([, v]) => v === "hide")
        .map(([id]) => id),
    );
  }

  status(): WalkthroughStatus {
    return { ...this.st, cameras: this.st.cameras.map((c) => ({ ...c })) };
  }

  /** Starts on the map being played: its cameras of this revision that aren't invalidated (hidden ones too, to look again). */
  start(opts: { secondsPer?: number; onlyUnreviewed?: boolean } = {}): WalkthroughStatus {
    const mapName = this.deps.session.state()?.mapName ?? null;
    const rt = mapName ? this.deps.maps.get(mapName) : undefined;
    if (!mapName || !rt) throw Object.assign(new Error("no map is being played: load a map or demo in CS2 first"), { status: 409 });
    const verdicts = this.reviews()[mapName] ?? {};
    const cameras = rt.pack.cameras
      .filter((c) => c.validation !== "invalidated" && c.mapRevision === rt.pack.mapRevision)
      .filter((c) => !opts.onlyUnreviewed || !verdicts[c.id])
      .map((c): WalkthroughCamera => ({ id: c.id, displayName: c.displayName, verdict: verdicts[c.id] ?? null, result: null, detail: null }));
    if (!cameras.length) throw Object.assign(new Error(opts.onlyUnreviewed ? "every camera on this map has a verdict already" : "this map has no cameras"), { status: 409 });
    this.stopTimer();
    this.st = { running: true, mapName, secondsPer: Math.min(10, Math.max(2, opts.secondsPer ?? 4)), index: 0, cameras };
    void this.show();
    return this.status();
  }

  /** Shows the current camera, then the next one after secondsPer; at the end the walkthrough stops. */
  private async show(): Promise<void> {
    this.stopTimer();
    const token = ++this.token;
    const cam = this.st.cameras[this.st.index];
    if (!this.st.running || !cam) return;
    cam.result = "pending";
    try {
      const r = await this.deps.session.manualCamera(cam.id, "camera-walkthrough", this.st.secondsPer * 1000 + 500);
      if (token !== this.token) return;
      const failed = r.status === "failed" || r.status === "cancelled";
      cam.result = failed ? "failed" : "shown";
      cam.detail = failed ? (r.detail ?? r.failureReason ?? null) : null;
    } catch (e) {
      if (token !== this.token) return;
      cam.result = "failed";
      cam.detail = e instanceof Error ? e.message : String(e);
    }
    this.timer = setTimeout(() => this.step(1, true), this.st.secondsPer * 1000);
  }

  private step(by: number, auto = false): void {
    if (!this.st.running) return;
    const next = this.st.index + by;
    if (next >= this.st.cameras.length) {
      if (auto) void this.stop();
      return;
    }
    this.st.index = Math.max(0, next);
    void this.show();
  }

  next(): WalkthroughStatus {
    this.step(1);
    return this.status();
  }

  previous(): WalkthroughStatus {
    this.step(-1);
    return this.status();
  }

  /** Stops and puts the observer back on a player. */
  async stop(): Promise<WalkthroughStatus> {
    const was = this.st.running;
    this.stopTimer();
    this.token++;
    this.st.running = false;
    if (was) await this.deps.session.returnToPov("camera-walkthrough").catch(() => undefined);
    return this.status();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
