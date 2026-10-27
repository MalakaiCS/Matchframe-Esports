import type { HudVariant } from "@matchframe/contracts";

/**
 * Desktop HUD bridge (`window.matchframe.hud`), provided by the program's preload script
 * (apps/desktop/src/preload.ts). Absent in plain browsers and tests; `available` is false in remote
 * mode, where desktop overlays are disabled.
 */

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  /** DIP coordinates; displays left of or above the primary have negative x/y. */
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** Physical pixels (bounds × scaleFactor). */
  pixels: { width: number; height: number };
}

export interface OverlayPlacement {
  displayId: number | null;
  /** DIP bounds of the overlay window. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Window width ÷ the HUD's design width. */
  scale: number;
  locked: boolean;
  variant: HudVariant;
}

export interface OverlayState extends OverlayPlacement {
  hudId: string;
  open: boolean;
  visible: boolean;
  editing: boolean;
  status: "starting" | "running" | "error";
  error: string | null;
  previews: number;
}

export interface OverlayConfigPatch {
  displayId?: number;
  bounds?: Partial<OverlayPlacement["bounds"]>;
  scale?: number;
  locked?: boolean;
  variant?: HudVariant;
  /** Re-place on the display: fit it (centred, aspect kept) or 100 % of the design size, centred. */
  fit?: "display" | "native";
}

export interface HotkeyConfig {
  /** Toggle the desktop HUD overlays. */
  toggle: string;
  /** Hide all HUD graphics, including OBS sources (press again to show). */
  emergencyHide: string;
}

export interface HotkeyState extends HotkeyConfig {
  registered: { toggle: boolean; emergencyHide: boolean };
  emergencyHidden: boolean;
}

export interface DesktopHudBridge {
  available: boolean;
  /** Why desktop overlays are unavailable (remote mode), or null. */
  unavailableReason: string | null;
  displays(): Promise<DisplayInfo[]>;
  overlays(): Promise<OverlayState[]>;
  launch(hudId: string, opts?: { variant?: HudVariant }): Promise<OverlayState>;
  close(hudId: string): Promise<void>;
  setVisible(hudId: string, visible: boolean): Promise<void>;
  configure(hudId: string, patch: OverlayConfigPatch): Promise<OverlayState>;
  setEditing(hudId: string, editing: boolean): Promise<void>;
  openPreview(hudId: string, opts: { variant: HudVariant; checker: boolean }): Promise<void>;
  closePreviews(hudId: string): Promise<void>;
  hideAll(): Promise<void>;
  showAll(): Promise<void>;
  stopAll(): Promise<void>;
  hotkeys(): Promise<HotkeyState>;
  setHotkeys(patch: Partial<HotkeyConfig>): Promise<HotkeyState>;
  /** Native file dialogs; ZIP bytes are uploaded to the engine by the manager. */
  pickZip(): Promise<{ name: string; bytes: Uint8Array } | null>;
  pickFolder(): Promise<string | null>;
  openHudsFolder(): Promise<void>;
  openHudFolder(hudId: string): Promise<void>;
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
  /** Overlay state pushes (open, move, visibility, status); returns an unsubscribe function. */
  onOverlays(fn: (overlays: OverlayState[]) => void): () => void;
}

export function desktopHud(): DesktopHudBridge | null {
  return (window as unknown as { matchframe?: { hud?: DesktopHudBridge } }).matchframe?.hud ?? null;
}
