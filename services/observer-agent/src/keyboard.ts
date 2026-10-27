import { platform } from "node:os";
import type { CameraMode, CameraPath, CameraRecord, CommandContext, CommandResult, ObservedCameraState } from "@matchframe/contracts";
import type { ControlCapabilities, ObserverControlAdapter } from "@matchframe/director-policy";
import { failedResult, transportResult } from "@matchframe/director-policy";
import { cap, noControl } from "./common.ts";

/** Native input backend (Windows SendInput via an FFI library); injected so tests can fake it. */
export interface InputBackend {
  foregroundWindowTitle(): string | null;
  pressKey(key: string): boolean;
}

/** Validated observer slot → key mapping; roster order is never assumed to equal key number. */
export function slotKey(slot: number | null): string | null {
  if (slot === null || !Number.isInteger(slot) || slot < 0 || slot > 9) return null;
  return String(slot);
}

/**
 * Keyboard fallback scoped to the configured observer window. Input is only sent when that window
 * is in the foreground; otherwise the command fails with `window_not_focused` and nothing is sent
 * (global switching keys never go to unrelated applications). Player selection relies on the
 * observer slot reported by telemetry, re-read for every command.
 */
export class KeyboardObserverAdapter implements ObserverControlAdapter {
  readonly id = "keyboard";
  readonly kind = "keyboard" as const;
  readonly simulated = false;
  private cancelled = false;

  constructor(
    private readonly backend: InputBackend | null,
    private readonly opts: { windowTitle: RegExp; now: () => number; verified?: { build: string | null; at: string } | null },
  ) {}

  async getCapabilities(): Promise<ControlCapabilities> {
    if (!this.backend) return noControl("Keyboard fallback requires Windows and the native input backend.", this.id);
    const base = noControl("not available via keyboard fallback", this.id);
    return {
      ...base,
      playerSelectionControl: this.opts.verified
        ? cap("playerSelectionControl", "supported", ["Requires the observer window to be focused."], this.id, this.opts.verified)
        : cap("playerSelectionControl", "unverified", ["Slot-key mapping and focus behaviour must be verified with the setup checklist.", "Requires the observer window to be focused."], this.id),
    };
  }

  private focused(): boolean {
    const title = this.backend?.foregroundWindowTitle() ?? null;
    return title !== null && this.opts.windowTitle.test(title);
  }

  async selectPlayer(_steamId: string, observerSlot: number | null, ctx: CommandContext): Promise<CommandResult> {
    if (!this.backend) return failedResult(ctx, "adapter_unavailable", "keyboard backend unavailable on this platform");
    const key = slotKey(observerSlot);
    if (key === null) return failedResult(ctx, "target_invalid", `no valid observer slot (${observerSlot})`);
    if (this.opts.now() > ctx.expiresAtMonotonicMs) return failedResult(ctx, "expired", "expired before input");
    if (!this.focused()) return failedResult(ctx, "window_not_focused", "observer window is not in the foreground; no input sent");
    this.cancelled = false;
    const ok = this.backend.pressKey(key);
    if (this.cancelled) return failedResult(ctx, "superseded", "cancelled");
    return ok ? transportResult(ctx, true, `key ${key}`, this.opts.now()) : failedResult(ctx, "transport_error", "SendInput failed");
  }

  async setObserverMode(_m: CameraMode, ctx: CommandContext) {
    return failedResult(ctx, "unsupported", "observer mode control is not available via keyboard fallback");
  }
  async activateStaticCamera(_c: CameraRecord, ctx: CommandContext) {
    return failedResult(ctx, "unsupported", "static cameras are not available via keyboard fallback");
  }
  async playCameraPath(_p: CameraPath, ctx: CommandContext) {
    return failedResult(ctx, "unsupported", "camera paths are not available via keyboard fallback");
  }
  async cancelPath(ctx: CommandContext) {
    return failedResult(ctx, "unsupported", "camera paths are not available via keyboard fallback");
  }
  async readState(): Promise<ObservedCameraState> {
    return { observedSteamId: null, observedSlot: null, mode: "unknown", pose: null, observedAtMonotonicMs: null, precision: "none" };
  }
  cancelPending(): void {
    this.cancelled = true;
  }
  async stopAutomation(): Promise<void> {
    this.cancelPending();
  }
  async dispose(): Promise<void> {}
}

/**
 * Loads the Windows SendInput backend through the optional `koffi` FFI package. Returns null on
 * other platforms or when the package is not installed. Not exercised in this repository's Linux
 * CI; marked unverified until tested on Windows.
 */
export async function loadWindowsInputBackend(): Promise<InputBackend | null> {
  if (platform() !== "win32") return null;
  try {
    const modName = "koffi";
    const koffi = (await import(modName)) as { default?: unknown } & Record<string, unknown>;
    const k = (koffi.default ?? koffi) as {
      load(lib: string): { func(sig: string): (...args: unknown[]) => unknown };
    };
    const user32 = k.load("user32.dll");
    const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)");
    const keybd_event = user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)");
    return {
      foregroundWindowTitle(): string | null {
        const h = GetForegroundWindow();
        if (!h) return null;
        const buf = new Uint16Array(256);
        const n = GetWindowTextW(h, buf, 256) as number;
        return String.fromCharCode(...buf.slice(0, n));
      },
      pressKey(key: string): boolean {
        const vk = key.charCodeAt(0); // '0'..'9' map to VK 0x30..0x39
        keybd_event(vk, 0, 0, 0);
        keybd_event(vk, 0, 2, 0);
        return true;
      },
    };
  } catch {
    return null;
  }
}
