import { BrowserWindow, screen, session } from "electron";
import type { Display, Event as ElectronEvent, WebContents } from "electron";
import { applyPlacementPatch, boundsPasses, placementAfterDisplayChange, resolvePlacement, toDisplayInfo } from "./placement.ts";
import type { DisplayLike } from "./placement.ts";
import type { OverlayStore } from "./store.ts";
import type { DisplayInfo, HudVariant, Library, LibraryHud, OverlayConfigPatch, OverlayPlacement, OverlayState, Rect, Size } from "./types.ts";

/**
 * Desktop HUD outputs (ADR-020, "Desktop program"): one transparent, click-through, always-on-top,
 * non-focusable window per HUD over a borderless-windowed game, and framed preview windows. Both load
 * the HUD server's output page (`urls[variant]` from the engine's library) and are independent of
 * the manager window: minimising or hiding the manager leaves them running.
 */

/** Tag on every HUD window, readable from the main process (smoke and overlay checks). */
export const HUD_WINDOW_TAG = Symbol.for("matchframe.hud-window");
export interface HudWindowTag {
  kind: "overlay" | "preview";
  hudId: string;
  /** Electron has no getter for setIgnoreMouseEvents; this mirrors the last call. */
  ignoringMouse: boolean;
  transparent: boolean;
  backgroundColor: string;
}

/** In-memory session for HUD output windows: no storage shared with the manager, no permissions. */
export const HUD_PARTITION = "mf-hud-outputs";
const TOPMOST_MS = 3000;
const RETRY_MS = 5000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASH_RELOADS = 3;
const DEFAULT_DESIGN: Size = { width: 1920, height: 1080 };
const TRANSPARENT = "#00000000";

type Status = OverlayState["status"];

interface Overlay {
  hudId: string;
  name: string;
  design: Size;
  url: string;
  origin: string;
  win: BrowserWindow;
  placement: OverlayPlacement;
  visible: boolean;
  editing: boolean;
  status: Status;
  error: string | null;
  httpError: string | null;
  topmost: ReturnType<typeof setInterval> | null;
  retry: ReturnType<typeof setTimeout> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  crashes: number[];
}

interface Preview {
  win: BrowserWindow;
  status: Status;
  httpError: string | null;
}

export interface OverlayManagerDeps {
  /** GET /api/v1/hud/library on the local engine. */
  library(): Promise<Library>;
  /** POST /api/v1/hud/library/:id/start (clears "stopped", records last used). */
  start(hudId: string): Promise<void>;
  store: OverlayStore;
  /** Sends overlay state to the manager window (`mf:hud-overlays`). */
  push(states: OverlayState[]): void;
  /** Something changed (tray menu labels). */
  onChange(): void;
  /** Window icon for preview windows (development runs; packaged builds use the .exe icon). */
  icon?: string;
  devTools: boolean;
  log(msg: string): void;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The output page URL for a variant and mode (`urls[variant]` + `&mode=…`). */
export function outputUrl(hud: LibraryHud, variant: HudVariant, mode: "desktop" | "preview", checker = false): string {
  const raw = hud.urls[variant];
  if (!raw) throw new Error(`${hud.name} has no ${variant} output.`);
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The HUD server returned an unexpected address.");
  u.searchParams.set("mode", mode);
  if (checker) u.searchParams.set("checker", "1");
  return u.toString();
}

function lockNavigation(wc: WebContents, allowedOrigin: () => string): void {
  const guard = (e: ElectronEvent<{ url: string; isMainFrame: boolean }>) => {
    if (e.isMainFrame && originOf(e.url) !== allowedOrigin()) e.preventDefault();
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-attach-webview", (e) => e.preventDefault());
}

const snapshot = (displays: Display[]): DisplayLike[] => displays.map((d) => ({ id: d.id, bounds: { ...d.bounds }, scaleFactor: d.scaleFactor, nativeOrigin: { ...d.nativeOrigin } }));
const tagOf = (w: BrowserWindow): HudWindowTag | undefined => (w as unknown as Record<symbol, HudWindowTag | undefined>)[HUD_WINDOW_TAG];
const setTag = (w: BrowserWindow, t: HudWindowTag) => ((w as unknown as Record<symbol, HudWindowTag>)[HUD_WINDOW_TAG] = t);

export class OverlayManager {
  private readonly overlays = new Map<string, Overlay>();
  private readonly previews = new Map<string, Set<Preview>>();
  private readonly huds = new Map<string, LibraryHud>();
  private readonly pending = new Map<string, Promise<OverlayState>>();
  private lastDisplays: DisplayLike[] = [];
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private pushQueued = false;
  private disabled: string | null = null;
  private started = false;

  constructor(private readonly d: OverlayManagerDeps) {}

  /** After app ready: session hardening and display tracking. */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = session.fromPartition(HUD_PARTITION);
    s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    this.lastDisplays = snapshot(this.displayList());
    screen.on("display-added", this.onDisplays);
    screen.on("display-removed", this.onDisplays);
    screen.on("display-metrics-changed", this.onDisplays);
  }

  dispose(): void {
    this.stopAll();
    if (this.displayTimer) clearTimeout(this.displayTimer);
    if (!this.started) return;
    screen.off("display-added", this.onDisplays);
    screen.off("display-removed", this.onDisplays);
    screen.off("display-metrics-changed", this.onDisplays);
  }

  /** Remote mode: desktop outputs are unavailable (null re-enables them). Closes open outputs. */
  setDisabled(reason: string | null): void {
    this.disabled = reason;
    if (reason) this.stopAll();
  }

  get unavailableReason(): string | null {
    return this.disabled;
  }

  // ---------------------------------------------------------------- queries

  displays(): DisplayInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => {
      let physical: Size | undefined;
      if (process.platform === "win32") {
        try {
          const r = screen.dipToScreenRect(null, d.bounds);
          physical = { width: r.width, height: r.height };
        } catch {
          // Estimated from the scale factor.
        }
      }
      return toDisplayInfo(d, primaryId, i, physical);
    });
  }

  /** Every HUD with an open overlay or preview. */
  list(): OverlayState[] {
    const ids = new Set([...this.overlays.keys(), ...[...this.previews].filter(([, s]) => s.size > 0).map(([id]) => id)]);
    return [...ids].sort().map((id) => this.stateOf(id));
  }

  hasOpenOverlays(): boolean {
    return this.overlays.size > 0;
  }

  hasOutputs(): boolean {
    return this.overlays.size > 0 || [...this.previews.values()].some((s) => s.size > 0);
  }

  anyVisible(): boolean {
    return [...this.overlays.values()].some((o) => o.visible);
  }

  // ---------------------------------------------------------------- overlay windows

  launch(hudId: string, variant?: HudVariant): Promise<OverlayState> {
    this.assertEnabled();
    const pending = this.pending.get(hudId);
    if (pending) return pending;
    const p = this.doLaunch(hudId, variant).finally(() => this.pending.delete(hudId));
    this.pending.set(hudId, p);
    return p;
  }

  private async doLaunch(hudId: string, requested: HudVariant | undefined): Promise<OverlayState> {
    const hud = await this.hud(hudId);
    if (hud.status === "error") throw new Error(hud.error ? `${hud.name} cannot run: ${hud.error}` : `${hud.name} failed verification and cannot run.`);
    const saved = this.d.store.placement(hudId);
    const variant = this.pickVariant(hud, requested, saved?.variant);
    const existing = this.overlays.get(hudId);
    if (existing && !existing.win.isDestroyed()) {
      if (existing.placement.variant !== variant) {
        existing.placement = { ...existing.placement, variant };
        this.d.store.setPlacement(hudId, existing.placement);
        this.load(existing, outputUrl(hud, variant, "desktop"));
      }
      if (!existing.visible) this.setShown(existing, true);
      this.changed();
      return this.stateOf(hudId);
    }
    await this.d.start(hudId).catch((e) => this.d.log(`could not mark ${hudId} as started: ${e instanceof Error ? e.message : String(e)}`));
    const url = outputUrl(hud, variant, "desktop");
    const design = hud.designResolution;
    const where = resolvePlacement(saved, design, this.displayList(), screen.getPrimaryDisplay().id);
    const placement: OverlayPlacement = { displayId: where.displayId, bounds: where.bounds, scale: where.scale, locked: saved?.locked ?? false, variant };
    const win = new BrowserWindow({
      ...placement.bounds,
      transparent: true,
      backgroundColor: TRANSPARENT,
      frame: false,
      thickFrame: false,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: `${hud.name} — Matchframe HUD`,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        partition: HUD_PARTITION,
        devTools: this.d.devTools,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    const o: Overlay = { hudId, name: hud.name, design, url, origin: originOf(url) ?? "", win, placement, visible: true, editing: false, status: "starting", error: null, httpError: null, topmost: null, retry: null, saveTimer: null, crashes: [] };
    this.overlays.set(hudId, o);
    setTag(win, { kind: "overlay", hudId, ignoringMouse: false, transparent: true, backgroundColor: TRANSPARENT });
    win.removeMenu();
    win.setAlwaysOnTop(true, "screen-saver");
    this.setIgnoreMouse(o, true);
    this.wire(o);
    this.applyBounds(o, placement.bounds, true);
    this.d.store.setPlacement(hudId, placement);
    this.load(o, url);
    this.changed();
    return this.stateOf(hudId);
  }

  private wire(o: Overlay): void {
    const { win } = o;
    const wc = win.webContents;
    lockNavigation(wc, () => o.origin);
    win.on("page-title-updated", (e) => e.preventDefault());
    win.once("ready-to-show", () => this.showIfWanted(o));
    wc.on("did-navigate", (_e, _url, code, text) => {
      o.httpError = code >= 400 ? `The HUD server answered HTTP ${code}${text ? ` ${text}` : ""}.` : null;
    });
    wc.on("did-finish-load", () => {
      if (o.httpError) return this.fail(o, o.httpError, true);
      o.status = "running";
      o.error = null;
      this.showIfWanted(o);
      this.applyEdit(o);
      this.changed();
    });
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: superseded by another navigation
      this.fail(o, `The HUD did not load (${description || `error ${code}`}). Retrying…`, true);
    });
    wc.on("render-process-gone", (_e, details) => {
      if (win.isDestroyed()) return;
      const now = Date.now();
      o.crashes = [...o.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      const again = o.crashes.length <= MAX_CRASH_RELOADS;
      this.fail(o, again ? `The HUD stopped (${details.reason}); reloading.` : `The HUD keeps stopping (${details.reason}). Close it and launch it again.`, false);
      if (again) this.scheduleRetry(o, 1000, false);
    });
    wc.on("unresponsive", () => this.d.log(`HUD overlay ${o.hudId} is not responding`));
    const onMove = () => this.onMoved(o);
    win.on("move", onMove);
    win.on("moved", onMove);
    win.on("closed", () => {
      for (const t of [o.retry, o.saveTimer]) if (t) clearTimeout(t);
      if (o.topmost) clearInterval(o.topmost);
      if (this.overlays.get(o.hudId) === o) this.overlays.delete(o.hudId);
      this.changed();
    });
  }

  private load(o: Overlay, url: string): void {
    o.url = url;
    o.origin = originOf(url) ?? "";
    o.status = "starting";
    o.error = null;
    o.httpError = null;
    if (o.retry) clearTimeout(o.retry);
    o.retry = null;
    o.win.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
  }

  private fail(o: Overlay, message: string, retry: boolean): void {
    o.status = "error";
    o.error = message;
    this.changed();
    if (retry) this.scheduleRetry(o, RETRY_MS, true);
  }

  /** Reloads after a failure; a fresh library URL picks up a rotated token or a restarted engine. */
  private scheduleRetry(o: Overlay, ms: number, refreshUrl: boolean): void {
    if (o.retry) clearTimeout(o.retry);
    o.retry = setTimeout(async () => {
      o.retry = null;
      if (o.win.isDestroyed()) return;
      let url = o.url;
      if (refreshUrl) {
        try {
          url = outputUrl(await this.hud(o.hudId), o.placement.variant, "desktop");
        } catch (e) {
          return this.fail(o, `The HUD did not load (${e instanceof Error ? e.message : String(e)}). Retrying…`, true);
        }
      }
      if (o.win.isDestroyed()) return;
      this.load(o, url);
      this.changed();
    }, ms);
  }

  private showIfWanted(o: Overlay): void {
    if (o.win.isDestroyed() || !o.visible) return;
    if (!o.win.isVisible()) o.win.showInactive();
    this.setIgnoreMouse(o, !o.editing);
    this.reassertTopmost(o);
    if (!o.topmost) o.topmost = setInterval(() => this.reassertTopmost(o), TOPMOST_MS);
  }

  private setShown(o: Overlay, visible: boolean): void {
    o.visible = visible;
    if (o.win.isDestroyed()) return;
    if (visible) this.showIfWanted(o);
    else {
      if (o.topmost) clearInterval(o.topmost);
      o.topmost = null;
      o.win.hide();
    }
  }

  /** Keeps the overlay above the game without ever activating it. */
  private reassertTopmost(o: Overlay): void {
    if (o.win.isDestroyed() || !o.visible) return;
    const before = o.win.getBounds();
    o.win.setAlwaysOnTop(true, "screen-saver");
    o.win.moveTop();
    if (!sameRect(before, o.win.getBounds())) o.win.setBounds(before);
  }

  private setIgnoreMouse(o: Overlay, ignore: boolean): void {
    if (o.win.isDestroyed()) return;
    o.win.setIgnoreMouseEvents(ignore);
    const tag = tagOf(o.win);
    if (tag) tag.ignoringMouse = ignore;
  }

  /** Sets bounds, twice when the window crosses to a display with another scale factor. */
  private applyBounds(o: Overlay, bounds: Rect, first = false): void {
    if (o.win.isDestroyed()) return;
    const from = first ? null : screen.getDisplayMatching(o.win.getBounds());
    const to = screen.getDisplayMatching(bounds);
    o.win.setBounds(bounds);
    if (boundsPasses(from, to) === 2) o.win.setBounds(bounds);
  }

  private applyEdit(o: Overlay): void {
    if (o.win.isDestroyed()) return;
    const js = `(() => { const m = window.__mfOverlay; return !!(m && typeof m.setEdit === "function" && m.setEdit(${o.editing ? "true" : "false"}) !== false); })()`;
    o.win.webContents.executeJavaScript(js, false).catch(() => false);
  }

  /** Edit mode: bounds dragged by the user are saved once the window stops moving. */
  private onMoved(o: Overlay): void {
    if (!o.editing) return;
    if (o.saveTimer) clearTimeout(o.saveTimer);
    o.saveTimer = setTimeout(() => {
      o.saveTimer = null;
      this.capturePlacement(o);
    }, 300);
  }

  private capturePlacement(o: Overlay): void {
    if (o.win.isDestroyed()) return;
    const bounds = o.win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    o.placement = { ...o.placement, bounds, displayId: display.id, scale: bounds.width / o.design.width };
    this.d.store.setPlacement(o.hudId, o.placement);
    this.changed();
  }

  async close(hudId: string): Promise<void> {
    const o = this.overlays.get(hudId);
    if (!o) return;
    this.overlays.delete(hudId);
    if (!o.win.isDestroyed()) o.win.destroy();
    this.changed();
  }

  setVisible(hudId: string, visible: boolean): void {
    this.assertEnabled();
    const o = this.require(hudId);
    this.setShown(o, visible);
    this.changed();
  }

  async setEditing(hudId: string, editing: boolean): Promise<void> {
    this.assertEnabled();
    const o = this.require(hudId);
    if (editing && o.placement.locked) throw new Error(`${o.name}'s position is locked. Unlock it to move it.`);
    if (o.editing === editing) return;
    o.editing = editing;
    if (editing && !o.visible) this.setShown(o, true);
    o.win.setFocusable(editing);
    this.setIgnoreMouse(o, !editing);
    this.applyEdit(o);
    if (!editing) {
      if (o.win.isFocused()) o.win.blur();
      if (o.saveTimer) clearTimeout(o.saveTimer);
      o.saveTimer = null;
      this.capturePlacement(o);
    }
    this.changed();
  }

  async configure(hudId: string, patch: OverlayConfigPatch): Promise<OverlayState> {
    this.assertEnabled();
    const o = this.overlays.get(hudId);
    const needHud = !o || (patch.variant !== undefined && patch.variant !== o.placement.variant);
    const hud = needHud ? await this.hud(hudId) : null;
    const design = o?.design ?? hud?.designResolution ?? DEFAULT_DESIGN;
    const cur = o?.placement ?? this.d.store.placement(hudId) ?? this.defaultPlacement(design, hud);
    let next: OverlayPlacement = { ...cur, bounds: { ...cur.bounds } };
    if (patch.locked !== undefined) next.locked = patch.locked;
    const geometry = patch.displayId !== undefined || patch.bounds !== undefined || patch.scale !== undefined || patch.fit !== undefined;
    if (geometry) next = { ...next, ...applyPlacementPatch(cur, patch, design, this.displayList(), screen.getPrimaryDisplay().id) };
    const variantChanged = patch.variant !== undefined && patch.variant !== cur.variant;
    if (variantChanged && hud) {
      if (!hud.variants.includes(patch.variant!) || !hud.urls[patch.variant!]) throw new Error(`${hud.name} has no ${patch.variant} variant.`);
      next.variant = patch.variant!;
    }
    if (o && !o.win.isDestroyed()) {
      o.placement = next;
      if (geometry) this.applyBounds(o, next.bounds);
      if (variantChanged && hud) this.load(o, outputUrl(hud, next.variant, "desktop"));
      if (next.locked && o.editing) await this.setEditing(hudId, false);
    }
    this.d.store.setPlacement(hudId, next);
    this.changed();
    return this.stateOf(hudId);
  }

  hideAll(): string[] {
    const shown = [...this.overlays.values()].filter((o) => o.visible);
    for (const o of shown) this.setShown(o, false);
    this.changed();
    return shown.map((o) => o.hudId);
  }

  showAll(ids?: string[]): void {
    for (const o of this.overlays.values()) if (!ids || ids.includes(o.hudId)) this.setShown(o, true);
    this.changed();
  }

  /** Toggle hotkey and tray: hide when any overlay is visible, else show them all. */
  toggleAll(): void {
    if (this.anyVisible()) this.hideAll();
    else this.showAll();
  }

  /** Closes every desktop overlay and preview (OBS sources are not affected). */
  stopAll(): void {
    for (const o of [...this.overlays.values()]) if (!o.win.isDestroyed()) o.win.destroy();
    this.overlays.clear();
    for (const set of this.previews.values()) for (const p of [...set]) if (!p.win.isDestroyed()) p.win.destroy();
    this.previews.clear();
    this.changed();
  }

  // ---------------------------------------------------------------- preview windows

  async openPreview(hudId: string, opts: { variant: HudVariant; checker: boolean }): Promise<void> {
    this.assertEnabled();
    const hud = await this.hud(hudId);
    if (!hud.variants.includes(opts.variant)) throw new Error(`${hud.name} has no ${opts.variant} variant.`);
    const url = outputUrl(hud, opts.variant, "preview", opts.checker);
    const allowed = originOf(url) ?? "";
    const area = screen.getPrimaryDisplay().workArea;
    const k = Math.min(1, (area.width * 0.7) / hud.designResolution.width, (area.height * 0.7) / hud.designResolution.height, 1280 / hud.designResolution.width);
    const background = "#11141b";
    const win = new BrowserWindow({
      width: Math.max(320, Math.round(hud.designResolution.width * k)),
      height: Math.max(180, Math.round(hud.designResolution.height * k)),
      useContentSize: true,
      minWidth: 320,
      minHeight: 180,
      title: `Preview — ${hud.name}`,
      backgroundColor: background,
      autoHideMenuBar: true,
      ...(this.d.icon ? { icon: this.d.icon } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false, partition: HUD_PARTITION, devTools: this.d.devTools, autoplayPolicy: "no-user-gesture-required" },
    });
    const p: Preview = { win, status: "starting", httpError: null };
    setTag(win, { kind: "preview", hudId, ignoringMouse: false, transparent: false, backgroundColor: background });
    win.removeMenu();
    win.on("page-title-updated", (e) => e.preventDefault());
    lockNavigation(win.webContents, () => allowed);
    const set = this.previews.get(hudId) ?? new Set<Preview>();
    this.previews.set(hudId, set);
    set.add(p);
    win.webContents.on("did-navigate", (_e, _url, code) => (p.httpError = code >= 400 ? `HTTP ${code}` : null));
    win.webContents.on("did-finish-load", () => {
      p.status = p.httpError ? "error" : "running";
      this.changed();
    });
    win.webContents.on("did-fail-load", (_e, code, _d, _u, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      p.status = "error";
      this.changed();
    });
    win.webContents.on("render-process-gone", () => {
      p.status = "error";
      this.changed();
      setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 1000);
    });
    win.on("closed", () => {
      set.delete(p);
      if (!set.size && this.previews.get(hudId) === set) this.previews.delete(hudId);
      this.changed();
    });
    win.loadURL(url).catch(() => undefined);
    this.changed();
  }

  async closePreviews(hudId: string): Promise<void> {
    const set = this.previews.get(hudId);
    if (!set) return;
    for (const p of [...set]) if (!p.win.isDestroyed()) p.win.destroy();
    this.previews.delete(hudId);
    this.changed();
  }

  // ---------------------------------------------------------------- helpers

  private stateOf(hudId: string): OverlayState {
    const o = this.overlays.get(hudId);
    const previews = [...(this.previews.get(hudId) ?? [])];
    const hud = this.huds.get(hudId);
    const placement = o?.placement ?? this.d.store.placement(hudId) ?? this.defaultPlacement(hud?.designResolution ?? DEFAULT_DESIGN, hud ?? null);
    // A closed overlay reports its previews' status (or "running" when nothing is open: there is nothing to wait for).
    const previewStatus: Status = previews.some((p) => p.status === "error") ? "error" : previews.some((p) => p.status === "starting") ? "starting" : "running";
    return {
      hudId,
      displayId: placement.displayId,
      bounds: { ...placement.bounds },
      scale: placement.scale,
      locked: placement.locked,
      variant: placement.variant,
      open: !!o,
      visible: o?.visible ?? false,
      editing: o?.editing ?? false,
      status: o?.status ?? previewStatus,
      error: o ? o.error : previewStatus === "error" ? "The preview did not load." : null,
      previews: previews.length,
    };
  }

  private defaultPlacement(design: Size, hud: LibraryHud | null): OverlayPlacement {
    const where = resolvePlacement(null, design, this.displayList(), screen.getPrimaryDisplay().id);
    return { displayId: where.displayId, bounds: where.bounds, scale: where.scale, locked: false, variant: hud ? this.pickVariant(hud, undefined, undefined) : "live" };
  }

  private pickVariant(hud: LibraryHud, requested: HudVariant | undefined, saved: HudVariant | undefined): HudVariant {
    const usable = (v: HudVariant | undefined): v is HudVariant => !!v && hud.variants.includes(v) && !!hud.urls[v];
    if (requested !== undefined) {
      if (!usable(requested)) throw new Error(`${hud.name} has no ${requested} variant.`);
      return requested;
    }
    if (usable(saved)) return saved;
    if (usable("live")) return "live";
    const first = hud.variants.find((v) => usable(v));
    if (!first) throw new Error(`${hud.name} has no outputs to show.`);
    return first;
  }

  /** The HUD's library entry, fresh from the engine. */
  private async hud(hudId: string): Promise<LibraryHud> {
    let lib: Library;
    try {
      lib = await this.d.library();
    } catch (e) {
      throw new Error(`The HUD library is not available: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    for (const h of lib.huds) this.huds.set(h.id, h);
    const hud = lib.huds.find((h) => h.id === hudId);
    if (!hud) throw new Error(`No HUD with the id ${hudId} is installed.`);
    return hud;
  }

  private require(hudId: string): Overlay {
    const o = this.overlays.get(hudId);
    if (!o || o.win.isDestroyed()) throw new Error("That HUD is not open on the desktop. Launch it first.");
    return o;
  }

  private assertEnabled(): void {
    if (this.disabled) throw new Error(this.disabled);
  }

  private displayList(): Display[] {
    return screen.getAllDisplays();
  }

  /** Display changes arrive in bursts; re-place once they settle (move off a removed display). */
  private readonly onDisplays = (): void => {
    if (this.displayTimer) clearTimeout(this.displayTimer);
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null;
      const displays = this.displayList();
      const primaryId = screen.getPrimaryDisplay().id;
      for (const o of this.overlays.values()) {
        if (o.win.isDestroyed()) continue;
        const next = placementAfterDisplayChange(o.placement, this.lastDisplays, displays, primaryId, o.design);
        if (next) {
          o.placement = { ...o.placement, ...next };
          this.applyBounds(o, next.bounds);
          this.d.store.setPlacement(o.hudId, o.placement);
        }
        this.reassertTopmost(o);
      }
      // Saved placements of closed overlays fall back to the primary display when they are launched.
      this.lastDisplays = snapshot(displays);
      this.changed();
    }, 250);
  };

  private changed(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    queueMicrotask(() => {
      this.pushQueued = false;
      try {
        this.d.push(this.list());
        this.d.onChange();
      } catch (e) {
        this.d.log(`overlay state push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }
}
