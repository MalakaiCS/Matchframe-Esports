// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "../components/Sidebar.tsx";
import { fmtMs, fmtMoney } from "../lib/format.ts";
import { NAV } from "../routes.tsx";
import { LanguagePanel } from "../screens/Settings.tsx";
import { liveStore } from "../state/live.ts";
import { locale, setLocale, t, useLocale } from "./index.ts";
import { languagePref, setLanguagePref } from "./language.ts";

/** The console as the App renders it: everything below the subscription renders again when the language changes. */
function Console() {
  useLocale();
  return (
    <>
      <Sidebar collapsed={false} onToggle={() => undefined} activeId="settings" />
      <LanguagePanel />
    </>
  );
}

const select = () => screen.getByRole("combobox", { name: /Language|Sprache|Язык|Idioma|Langue|Język/ }) as HTMLSelectElement;

afterEach(async () => {
  cleanup();
  delete (window as { matchframe?: unknown }).matchframe;
  await act(() => setLanguagePref("en"));
  liveStore.reset();
  window.localStorage.clear();
});

describe("Settings → General → Language (ADR-082)", () => {
  it("renders in English by default and lists every language in its own name", () => {
    render(<Console />);
    expect(locale()).toBe("en");
    expect(screen.getByText("Settings")).toBeTruthy();
    const options = [...select().options].map((o) => o.textContent);
    expect(options).toEqual(["System (English)", "English", "Português (Brasil)", "Español", "Deutsch", "Français", "Polski", "Русский"]);
    expect(screen.getByText(/Translations may contain mistakes; report them to support/)).toBeTruthy();
  });

  it("switches the whole console at once, without a restart, and keeps the choice", async () => {
    render(<Console />);
    fireEvent.change(select(), { target: { value: "de" } });
    await waitFor(() => expect(screen.getByText("Einstellungen")).toBeTruthy());
    expect(screen.getByText("HUD-Bibliothek")).toBeTruthy();
    expect(screen.getByText("Live-Steuerung")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sprache" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem("matchframe.ui.language")).toBe("de");
    // Module-level label tables follow too.
    expect(NAV.find((n) => n.id === "live")!.label).toBe("Live-Steuerung");

    fireEvent.change(select(), { target: { value: "ru" } });
    await waitFor(() => expect(screen.getByText("Настройки")).toBeTruthy());
    expect(screen.getByText("Управление эфиром")).toBeTruthy();

    fireEvent.change(select(), { target: { value: "en" } });
    await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
  });

  it("follows the system language for System, through the program when it runs there", async () => {
    const set = vi.fn(async () => ({ language: "system", locale: "pl" }));
    (window as { matchframe?: unknown }).matchframe = { language: { pref: "system", system: ["pl-PL", "en-US"], set } };
    render(<Console />);
    expect(select().options[0]!.textContent).toBe("System (Polski)");
    fireEvent.change(select(), { target: { value: "system" } });
    await waitFor(() => expect(screen.getByText("Ustawienia")).toBeTruthy());
    expect(set).toHaveBeenCalledWith("system");
    // The program's tray, dialogs and notifications follow the same setting.
    fireEvent.change(select(), { target: { value: "fr" } });
    await waitFor(() => expect(screen.getByText("Paramètres")).toBeTruthy());
    expect(set).toHaveBeenLastCalledWith("fr");
    expect(languagePref()).toBe("fr");
  });

  it("uses each language's plural forms and number formats", async () => {
    await act(() => setLocale("ru"));
    expect([1, 2, 5, 21].map((count) => t("hudlib.count.here", { count }))).toEqual(["1 HUD на этом компьютере", "2 HUD на этом компьютере", "5 HUD на этом компьютере", "21 HUD на этом компьютере"]);
    expect([1, 3, 5, 22].map((count) => t("settings.crash.waiting", { count }))).toEqual([
      "1 отчёт о сбое ждёт отправки.",
      "3 отчёта о сбоях ждут отправки.",
      "5 отчётов о сбоях ждут отправки.",
      "22 отчёта о сбоях ждут отправки.",
    ]);
    expect(fmtMs(1500)).toBe("1,5 с");
    await act(() => setLocale("pl"));
    expect([1, 2, 5, 12, 22].map((count) => t("settings.backup.collisions", { count }).split(" — ")[0])).toEqual(["1 konflikt id", "2 konflikty id", "5 konfliktów id", "12 konfliktów id", "22 konflikty id"]);
    await act(() => setLocale("de"));
    expect(t("settings.report.windowValue", { count: 1200, minutes: 30 })).toBe("1.200 Entscheidungen · 30 min");
    expect(fmtMoney(1200).replace(/\s/g, " ")).toBe("1.200 $");
    await act(() => setLocale("en"));
    expect(fmtMs(1500)).toBe("1.5 s");
    expect(fmtMoney(1200)).toBe("$1,200");
  });

  it("falls back to English for a key a language lacks, and shows the key when English lacks it too", async () => {
    await act(() => setLocale("es"));
    expect(t("nav.settings")).toBe("Ajustes");
    expect(t("no.such.key")).toBe("no.such.key");
  });
});
