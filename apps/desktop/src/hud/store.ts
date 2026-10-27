import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_HOTKEYS } from "./types.ts";
import type { HotkeyConfig, OverlayPlacement } from "./types.ts";
import { HUD_ID, isVariant } from "./validate.ts";

/**
 * Program settings for desktop HUDs: overlay placement per HUD and the hotkeys, in
 * `<userData>/hud-overlays.json` (userData is `<data folder>/program`). Pure Node; writes are atomic
 * (temporary file + rename) and debounced.
 */

export interface StoreData {
  version: 1;
  overlays: Record<string, OverlayPlacement>;
  hotkeys: HotkeyConfig;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function placementFrom(v: unknown): OverlayPlacement | null {
  if (!isObject(v) || !isObject(v.bounds)) return null;
  const b = v.bounds;
  if (![b.x, b.y, b.width, b.height].every(finite) || (b.width as number) < 16 || (b.height as number) < 16 || Math.abs(b.x as number) > 100_000 || Math.abs(b.y as number) > 100_000 || (b.width as number) > 32_768 || (b.height as number) > 32_768) return null;
  return {
    displayId: finite(v.displayId) && Number.isSafeInteger(v.displayId) ? v.displayId : null,
    bounds: { x: Math.round(b.x as number), y: Math.round(b.y as number), width: Math.round(b.width as number), height: Math.round(b.height as number) },
    scale: finite(v.scale) && v.scale >= 0.1 && v.scale <= 4 ? v.scale : 1,
    locked: v.locked === true,
    variant: isVariant(v.variant) ? v.variant : "live",
  };
}

/** Reads whatever is in the file, keeping only well-formed entries. */
export function parseStore(raw: unknown): StoreData {
  const out: StoreData = { version: 1, overlays: {}, hotkeys: { ...DEFAULT_HOTKEYS } };
  if (!isObject(raw)) return out;
  if (isObject(raw.overlays)) {
    for (const [id, p] of Object.entries(raw.overlays)) {
      const placement = HUD_ID.test(id) ? placementFrom(p) : null;
      if (placement) out.overlays[id] = placement;
    }
  }
  if (isObject(raw.hotkeys)) {
    const h = raw.hotkeys;
    if (typeof h.toggle === "string" && h.toggle.length <= 64) out.hotkeys.toggle = h.toggle;
    if (typeof h.emergencyHide === "string" && h.emergencyHide.length <= 64) out.hotkeys.emergencyHide = h.emergencyHide;
  }
  return out;
}

export class OverlayStore {
  private data: StoreData;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly onError: (e: unknown) => void = () => undefined,
  ) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Missing or unreadable: defaults.
    }
    this.data = parseStore(raw);
  }

  placement(hudId: string): OverlayPlacement | null {
    const p = this.data.overlays[hudId];
    return p ? { ...p, bounds: { ...p.bounds } } : null;
  }

  placements(): Record<string, OverlayPlacement> {
    return Object.fromEntries(Object.keys(this.data.overlays).map((id) => [id, this.placement(id)!]));
  }

  setPlacement(hudId: string, p: OverlayPlacement): void {
    this.data.overlays[hudId] = { ...p, bounds: { ...p.bounds } };
    this.schedule();
  }

  hotkeys(): HotkeyConfig {
    return { ...this.data.hotkeys };
  }

  setHotkeys(h: HotkeyConfig): void {
    this.data.hotkeys = { ...h };
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  /** Writes pending changes now (also called on quit). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      this.onError(e);
    }
  }
}
