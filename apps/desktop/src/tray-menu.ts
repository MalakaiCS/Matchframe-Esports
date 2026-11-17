import type { MenuItemConstructorOptions } from "electron";
import { t } from "./i18n.ts";

/** The tray menu in the current language (built again when the language or the HUD state changes). */
export function trayMenuItems(
  s: { open: boolean; visible: boolean; outputs: boolean },
  on: { showManager(): void; toggleHud(): void; stopHud(): void; quit(): void },
): MenuItemConstructorOptions[] {
  return [
    { label: t("tray.showManager"), click: () => on.showManager() },
    { type: "separator" },
    { label: s.visible ? t("tray.hideHud") : t("tray.showHud"), enabled: s.open, click: () => on.toggleHud() },
    { label: t("tray.stopHud"), enabled: s.outputs, click: () => on.stopHud() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => on.quit() },
  ];
}
