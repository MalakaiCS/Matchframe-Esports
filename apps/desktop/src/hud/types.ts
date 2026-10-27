/**
 * Desktop HUD types. These mirror the bridge contract in apps/operator-web/src/api/desktop.ts and
 * the library shape in packages/contracts/src/hud.ts (the program bundle does not depend on either
 * package; hud/validate.test.ts keeps the variant list in step with the contracts).
 */

export const HUD_VARIANTS = ["live", "compact", "replay", "veto", "pre-match", "break", "post-map", "post-series", "studio"] as const;
export type HudVariant = (typeof HUD_VARIANTS)[number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  /** DIP coordinates; displays left of or above the primary have negative x/y. */
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
  /** Physical pixels (bounds × scaleFactor). */
  pixels: Size;
}

export interface OverlayPlacement {
  displayId: number | null;
  /** DIP bounds of the overlay window. */
  bounds: Rect;
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
  bounds?: Partial<Rect>;
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

export const DEFAULT_HOTKEYS: HotkeyConfig = { toggle: "CommandOrControl+Shift+H", emergencyHide: "CommandOrControl+Shift+F9" };

/** The part of a library entry (GET /api/v1/hud/library) the program uses. */
export interface LibraryHud {
  id: string;
  name: string;
  variants: HudVariant[];
  designResolution: Size;
  folder: string | null;
  status: "ready" | "running" | "stopped" | "error";
  error: string | null;
  stopped: boolean;
  urls: Partial<Record<HudVariant, string>>;
}

export interface Library {
  huds: LibraryHud[];
  hudsDir: string | null;
  overlayOrigin: string;
  hiddenAll: boolean;
}

/** IPC replies: errors travel as plain messages so the console shows them without Electron's prefix. */
export type HudReply<T> = { ok: true; value: T } | { ok: false; error: string };
