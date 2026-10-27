import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState } from "@matchframe/contracts";
import type { ControlCapabilities, ObserverControlAdapter } from "@matchframe/director-policy";
import { failedResult } from "@matchframe/director-policy";
import { noControl } from "./common.ts";

/** Explicit "no control" adapter: Matchframe runs HUD/advisory without game control. */
export class NoControlAdapter implements ObserverControlAdapter {
  readonly id = "none";
  readonly kind = "none" as const;
  readonly simulated = false;
  async getCapabilities(): Promise<ControlCapabilities> {
    return noControl("No observer control adapter configured. Advisory mode only.");
  }
  private no(ctx: CommandContext): CommandResult {
    return failedResult(ctx, "adapter_unavailable", "no observer control adapter configured");
  }
  async selectPlayer(_s: string, _slot: number | null, ctx: CommandContext) {
    return this.no(ctx);
  }
  async setObserverMode(_m: CameraMode, ctx: CommandContext) {
    return this.no(ctx);
  }
  async activateStaticCamera(_c: CameraRecord, ctx: CommandContext) {
    return this.no(ctx);
  }
  async playCameraPath(_p: CameraPath, ctx: CommandContext) {
    return this.no(ctx);
  }
  async cancelPath(ctx: CommandContext) {
    return this.no(ctx);
  }
  async readState(): Promise<ObservedCameraState> {
    return { observedSteamId: null, observedSlot: null, mode: "unknown", pose: null, observedAtMonotonicMs: null, precision: "none" };
  }
  cancelPending() {}
  async stopAutomation() {}
  async dispose() {}
}
