import { existsSync } from "node:fs";
import { Menu, nativeImage, Tray } from "electron";

/**
 * Notification-area (tray) icon: Show Manager, Show/Hide HUD (desktop overlays), Stop HUD (closes
 * desktop overlays and previews; OBS sources are not affected) and Quit. The manager can be closed to
 * the tray while desktop HUDs run.
 */
export interface ProgramTray {
  refresh(): void;
  destroy(): void;
}

export function createTray(opts: {
  iconPath: string;
  showManager(): void;
  toggleHud(): void;
  stopHud(): void;
  quit(): void;
  /** Any desktop overlay open / visible, any overlay or preview open. */
  state(): { open: boolean; visible: boolean; outputs: boolean };
  log(msg: string): void;
}): ProgramTray | null {
  let tray: Tray;
  try {
    const raw = existsSync(opts.iconPath) ? nativeImage.createFromPath(opts.iconPath) : nativeImage.createEmpty();
    const icon = raw.isEmpty() ? raw : raw.resize({ width: process.platform === "darwin" ? 18 : 32, height: process.platform === "darwin" ? 18 : 32, quality: "best" });
    tray = new Tray(icon);
  } catch (e) {
    opts.log(`tray icon unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  tray.setToolTip("Matchframe Esports");
  // Windows: a click on the icon opens the manager; the menu is on right-click.
  tray.on("click", () => opts.showManager());
  tray.on("double-click", () => opts.showManager());

  const refresh = () => {
    if (tray.isDestroyed()) return;
    const s = opts.state();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show Manager", click: () => opts.showManager() },
        { type: "separator" },
        { label: s.visible ? "Hide HUD" : "Show HUD", enabled: s.open, click: () => opts.toggleHud() },
        { label: "Stop HUD", enabled: s.outputs, click: () => opts.stopHud() },
        { type: "separator" },
        { label: "Quit Matchframe", click: () => opts.quit() },
      ]),
    );
  };
  refresh();
  return {
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
