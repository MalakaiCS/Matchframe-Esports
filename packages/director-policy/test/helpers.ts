import type { CameraMode, CommandContext, CommandResult, ObservedCameraState, SourceCapabilities, Vec3 } from "@matchframe/contracts";
import { emptySourceCapabilities } from "@matchframe/contracts";
import type { SyntheticGrenade, SyntheticPlayer } from "@matchframe/cs2-state";
import { buildSyntheticGsiPayload, MatchStateStore, normalizeGsi, parseGsiPayload } from "@matchframe/cs2-state";
import { MapRuntime, syntheticMapPack } from "@matchframe/map-runtime";
import type { ControlCapabilities, ObserverControlAdapter } from "../src/index.ts";
import { transportResult } from "../src/index.ts";

export const T = (i: number) => `7656119800000000${i}`;
export const CT = (i: number) => `7656119800000001${i}`;

export function player(steamId: string, side: "T" | "CT", slot: number, position: Vec3, forward: Vec3 | null = { x: 1, y: 0, z: 0 }, extra: Partial<SyntheticPlayer> = {}): SyntheticPlayer {
  return {
    steamId,
    name: steamId.slice(-3),
    slot,
    side,
    position,
    forward,
    weapons: [{ name: side === "T" ? "weapon_ak47" : "weapon_m4a1", type: "Rifle", state: "active", ammoClip: 30, ammoClipMax: 30, ammoReserve: 90 }],
    ...extra,
  };
}

export const facingTo = (from: Vec3, to: Vec3): Vec3 => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l, z: 0 };
};

/** Drives a MatchStateStore with synthetic payloads (labelled synthetic; logic tests only). */
export class Sim {
  readonly store: MatchStateStore;
  now = 10_000;
  private ts = 1_700_000_000;
  constructor(mapName = "de_synthetic", runtime?: MapRuntime) {
    const rt = runtime ?? new MapRuntime(syntheticMapPack({ withValidatedCamera: true, mapName }));
    this.store = new MatchStateStore({ sessionId: "sim", simulated: true, mapContextFor: () => rt });
  }
  push(players: SyntheticPlayer[], opts: { grenades?: SyntheticGrenade[]; observed?: string | null; dtMs?: number; bomb?: { state: string; position?: Vec3; countdown?: number }; phase?: string; mapName?: string } = {}) {
    this.now += opts.dtMs ?? 100;
    this.ts += 1;
    const raw = buildSyntheticGsiPayload({
      mapName: opts.mapName ?? "de_synthetic",
      players,
      grenades: opts.grenades ?? [],
      observed: opts.observed === undefined ? players[0]!.steamId : opts.observed,
      timestamp: this.ts,
      ...(opts.bomb ? { bomb: opts.bomb } : {}),
      phase: opts.phase ?? "live",
      phaseEndsIn: 60,
      round: 3,
    });
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    this.store.ingest(normalizeGsi(parsed.payload, { sourceId: "gsi:sim", receivedAtMonotonicMs: this.now, payloadHash: JSON.stringify(raw) + this.now }));
    return this.store.snapshot(this.now);
  }
}

export function syntheticRuntime(validated = true) {
  return new MapRuntime(syntheticMapPack({ withValidatedCamera: validated }));
}

/** Capabilities for logic tests where camera control is assumed verified (simulation only). */
export function capsWithCameraControl(support: "supported" | "unverified" = "supported"): SourceCapabilities {
  const c = emptySourceCapabilities();
  for (const k of ["he", "flashbang", "smoke", "molotov", "incendiary", "decoy"] as const) c.grenadeTypeSupport[k] = { ...c.grenadeTypeSupport[k], support: "supported" };
  c.staticCameraControl = { ...c.staticCameraControl, support };
  c.playerSelectionControl = { ...c.playerSelectionControl, support: "supported" };
  return c;
}

export class FakeAdapter implements ObserverControlAdapter {
  readonly id = "fake";
  readonly kind = "simulation" as const;
  readonly simulated = true;
  calls: { kind: string; target: string | null; ctx: CommandContext }[] = [];
  failTransport = 0;
  cancelled = 0;
  stopped = 0;
  constructor(private now: () => number) {}
  async getCapabilities(): Promise<ControlCapabilities> {
    const c = emptySourceCapabilities();
    return { playerSelectionControl: c.playerSelectionControl, observerModeControl: c.observerModeControl, staticCameraControl: c.staticCameraControl, cameraPathControl: c.cameraPathControl, cameraReadback: c.cameraReadback };
  }
  private result(kind: string, target: string | null, ctx: CommandContext): CommandResult {
    this.calls.push({ kind, target, ctx });
    if (this.failTransport > 0) {
      this.failTransport--;
      return transportResult(ctx, false, "simulated transport failure", this.now());
    }
    return transportResult(ctx, true, null, this.now());
  }
  async selectPlayer(steamId: string, _slot: number | null, ctx: CommandContext) {
    return this.result("select_player", steamId, ctx);
  }
  async setObserverMode(mode: CameraMode, ctx: CommandContext) {
    return this.result("set_observer_mode", mode, ctx);
  }
  async activateStaticCamera(camera: { id: string }, ctx: CommandContext) {
    return this.result("activate_static_camera", camera.id, ctx);
  }
  async playCameraPath(path: { id: string }, ctx: CommandContext) {
    return this.result("play_camera_path", path.id, ctx);
  }
  async cancelPath(ctx: CommandContext) {
    return this.result("cancel_path", null, ctx);
  }
  async readState(): Promise<ObservedCameraState> {
    return { observedSteamId: null, observedSlot: null, mode: "unknown", pose: null, observedAtMonotonicMs: null, precision: "none" };
  }
  cancelPending() {
    this.cancelled++;
  }
  async stopAutomation() {
    this.stopped++;
  }
  async dispose() {}
}
