import { afterEach, describe, expect, it } from "vitest";
import { desktopLocale, parseLanguagePref, section, setDesktopLanguage, t } from "./i18n.ts";
import { confirmation } from "./rollback.ts";
import { trayMenuItems } from "./tray-menu.ts";

const noop = { showManager: () => undefined, toggleHud: () => undefined, stopHud: () => undefined, quit: () => undefined };
const labels = (s: { open: boolean; visible: boolean; outputs: boolean }) => trayMenuItems(s, noop).flatMap((i) => (i.label ? [i.label] : []));

describe("desktop shell language (ADR-082)", () => {
  afterEach(() => setDesktopLanguage("en", []));

  it("reads the Language setting from program-settings.json, System when missing or unknown", () => {
    expect(parseLanguagePref("de")).toBe("de");
    expect(parseLanguagePref("pt-BR")).toBe("pt-BR");
    expect(parseLanguagePref(undefined)).toBe("system");
    expect(parseLanguagePref("klingon")).toBe("system");
    expect(parseLanguagePref(42)).toBe("system");
  });

  it("follows the computer's language for System, English when it isn't one of ours", () => {
    expect(setDesktopLanguage("system", ["ru-RU", "en-US"])).toBe("ru");
    expect(setDesktopLanguage("system", ["pt-PT"])).toBe("pt-BR");
    expect(setDesktopLanguage("system", ["ja-JP", "pl-PL"])).toBe("pl");
    expect(setDesktopLanguage("system", ["ja-JP"])).toBe("en");
    expect(setDesktopLanguage("fr", ["de-DE"])).toBe("fr");
    expect(desktopLocale()).toBe("fr");
  });

  it("builds the tray menu in the chosen language", () => {
    expect(labels({ open: true, visible: true, outputs: true })).toEqual(["Show Manager", "Hide HUD", "Stop HUD", "Quit MatchFrame"]);
    setDesktopLanguage("de", []);
    expect(labels({ open: true, visible: false, outputs: true })).toEqual(["Manager anzeigen", "HUD einblenden", "HUD beenden", "MatchFrame beenden"]);
    setDesktopLanguage("ru", []);
    expect(labels({ open: true, visible: true, outputs: true })[0]).toBe("Показать менеджер");
  });

  it("uses the language's plural forms in dialogs", () => {
    setDesktopLanguage("ru", []);
    expect(t("crash.noted", { count: 2 })).toBe("Зафиксировано 2 сбоя.");
    expect(t("crash.noted", { count: 5 })).toBe("Зафиксировано 5 сбоев.");
    expect(t("crash.noted", { count: 21 })).toBe("Зафиксирован 21 сбой.");
    setDesktopLanguage("pl", []);
    expect(t("crash.noted", { count: 3 })).toBe("Odnotowano 3 awarie.");
    expect(t("crash.noted", { count: 12 })).toBe("Odnotowano 12 awarii.");
  });

  it("asks before going back to a version in the chosen language", () => {
    setDesktopLanguage("es", []);
    const c = confirmation("0.12.4", "0.13.0", { kind: "keep", schema: 1 }, false);
    expect(c.title).toBe("Volver a una versión anterior");
    expect(c.ok).toBe("Volver a 0.12.4");
    expect(c.detail).toContain("Tienes la versión 0.13.0.");
  });

  it("hands the connection page its text in the chosen language", () => {
    setDesktopLanguage("fr", []);
    const s = section("connect");
    expect(s.title).toBe("Paramètres de connexion");
    expect(Object.keys(s)).toContain("tokenNote");
  });
});
