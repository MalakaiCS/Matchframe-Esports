import { mkdirSync, realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { app, dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from "electron";
import { t } from "../i18n.ts";
import type { HotkeyManager } from "./hotkeys.ts";
import type { OverlayManager } from "./overlays.ts";
import type { HudReply, Library } from "./types.ts";
import { booleanArg, bytesArg, configPatchArg, hotkeyPatchArg, hudIdArg, launchOptsArg, MAX_SAVE_BYTES, MAX_ZIP_BYTES, previewOptsArg, sanitizeFileName } from "./validate.ts";

/**
 * `mf:hud-*` IPC for the desktop HUD bridge (`window.matchframe.hud`, apps/desktop/src/preload.ts).
 * Only the console frame (app://matchframe, not the connection page) is answered; every argument is
 * checked. Replies are `{ ok, value | error }` so the console shows plain error messages.
 */

export interface HudIpcDeps {
  overlays: OverlayManager;
  hotkeys: HotkeyManager;
  /** True for the console frame (app://matchframe, not /connect). */
  allowed(e: IpcMainInvokeEvent): boolean;
  /** Parent window for dialogs. */
  window(): BrowserWindow | null;
  dataDir(): string;
  /** Why desktop HUDs are unavailable (remote mode), or null. */
  unavailableReason(): string | null;
  library(): Promise<Library>;
  hideAll(): void;
  showAll(): void;
  stopAll(): void;
}

const sameOrInside = (root: string, target: string): boolean => {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
};

export function registerHudIpc(d: HudIpcDeps): void {
  const handle = <T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<HudReply<T>> => {
      if (!d.allowed(event)) return { ok: false, error: t("hud.managerOnly") };
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  };
  const localOnly = (what: string) => {
    if (d.unavailableReason()) throw new Error(t("hud.productionOnly", { what: t(what) }));
  };
  const openDialog = (opts: OpenDialogOptions) => {
    const parent = d.window();
    return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts);
  };

  handle("mf:hud-displays", () => d.overlays.displays());
  handle("mf:hud-overlay-list", () => d.overlays.list());
  handle("mf:hud-launch", (id, opts) => d.overlays.launch(hudIdArg(id), launchOptsArg(opts).variant));
  handle("mf:hud-close", (id) => d.overlays.close(hudIdArg(id)));
  handle("mf:hud-set-visible", (id, visible) => d.overlays.setVisible(hudIdArg(id), booleanArg(visible, "visible")));
  handle("mf:hud-configure", (id, patch) => d.overlays.configure(hudIdArg(id), configPatchArg(patch)));
  handle("mf:hud-set-editing", (id, editing) => d.overlays.setEditing(hudIdArg(id), booleanArg(editing, "editing")));
  handle("mf:hud-open-preview", (id, opts) => d.overlays.openPreview(hudIdArg(id), previewOptsArg(opts)));
  handle("mf:hud-close-previews", (id) => d.overlays.closePreviews(hudIdArg(id)));
  handle("mf:hud-hide-all", () => d.hideAll());
  handle("mf:hud-show-all", () => d.showAll());
  handle("mf:hud-stop-all", () => d.stopAll());
  handle("mf:hud-hotkeys", () => d.hotkeys.state());
  handle("mf:hud-set-hotkeys", (patch) => d.hotkeys.set(hotkeyPatchArg(patch)));

  handle("mf:hud-pick-zip", async () => {
    const r = await openDialog({ title: t("hud.importPackage"), buttonLabel: t("hud.import"), filters: [{ name: t("hud.packageFilter"), extensions: ["zip"] }], properties: ["openFile"] });
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    if (extname(file).toLowerCase() !== ".zip") throw new Error(t("hud.chooseZip"));
    const st = await stat(file);
    if (!st.isFile()) throw new Error(t("hud.chooseZip"));
    if (st.size > MAX_ZIP_BYTES) throw new Error(t("hud.zipTooLarge", { mb: MAX_ZIP_BYTES / 1024 / 1024 }));
    return { name: basename(file), bytes: await readFile(file) };
  });

  handle("mf:hud-pick-folder", async () => {
    localOnly("hud.importFolderWhat");
    const r = await openDialog({ title: t("hud.importFolder"), buttonLabel: t("hud.importFolderButton"), properties: ["openDirectory"] });
    return (r.canceled ? undefined : r.filePaths[0]) ?? null;
  });

  handle("mf:hud-open-huds-folder", async () => {
    localOnly("hud.openFolderWhat");
    const dir = join(d.dataDir(), "huds");
    mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  handle("mf:hud-open-hud-folder", async (id) => {
    localOnly("hud.openHudFolderWhat");
    const hudId = hudIdArg(id);
    const hud = (await d.library()).huds.find((h) => h.id === hudId);
    if (!hud) throw new Error(t("hud.notInstalled", { id: hudId }));
    if (!hud.folder) throw new Error(t("hud.builtIn", { name: hud.name }));
    const root = join(d.dataDir(), "huds");
    mkdirSync(root, { recursive: true });
    let target: string;
    try {
      target = realpathSync.native(hud.folder);
    } catch {
      throw new Error(t("hud.folderMissing", { name: hud.name }));
    }
    if (!sameOrInside(realpathSync.native(root), target)) throw new Error(t("hud.folderOutside", { name: hud.name }));
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });

  handle("mf:hud-save-file", async (name, bytes) => {
    const data = bytesArg(bytes, MAX_SAVE_BYTES);
    const safe = sanitizeFileName(name);
    const ext = extname(safe).slice(1).toLowerCase();
    const opts: SaveDialogOptions = {
      title: t("hud.save"),
      defaultPath: join(app.getPath("downloads"), safe),
      filters: ext ? [{ name: t("hud.fileFilter", { ext: ext.toUpperCase() }), extensions: [ext] }, { name: t("hud.allFiles"), extensions: ["*"] }] : [],
    };
    const parent = d.window();
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return false;
    await writeFile(r.filePath, data);
    return true;
  });
}
