import { useSyncExternalStore } from "react";
import { isLanguagePref, resolveLanguage, type LanguagePref, type Locale } from "./core.ts";
import { setLocale } from "./index.ts";

/**
 * The Language setting (Settings → General). In the program the desktop shell keeps it (its
 * dialogs, notifications and tray follow it too); in a plain browser it is kept in localStorage.
 * "System" follows the computer's language; English when the system's isn't one of ours.
 */

export interface DesktopLanguageBridge {
  /** The setting as the program had it when the console loaded. */
  pref: LanguagePref;
  /** The computer's preferred languages, as the program sees them. */
  system: string[];
  set(pref: LanguagePref): Promise<unknown>;
}

const STORAGE_KEY = "matchframe.ui.language";

function bridge(): DesktopLanguageBridge | null {
  const b = (window as unknown as { matchframe?: { language?: DesktopLanguageBridge } }).matchframe?.language;
  return b && typeof b.set === "function" ? b : null;
}

function stored(): LanguagePref {
  const b = bridge();
  if (b && isLanguagePref(b.pref)) return b.pref;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isLanguagePref(v) ? v : "system";
  } catch {
    return "system";
  }
}

function systemTags(): string[] {
  const b = bridge();
  if (b?.system?.length) return b.system;
  return typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language].filter(Boolean) : [];
}

let pref: LanguagePref | null = null;
const listeners = new Set<() => void>();

export function languagePref(): LanguagePref {
  pref ??= stored();
  return pref;
}

/** The language "System" stands for on this computer. */
export function systemLocale(): Locale {
  return resolveLanguage("system", systemTags());
}

/** Applies a Language setting at once and keeps it (in the program, the desktop shell follows). */
export async function setLanguagePref(next: LanguagePref): Promise<void> {
  pref = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable; the setting then lasts until the console reloads (the program keeps its own).
  }
  await setLocale(resolveLanguage(next, systemTags()));
  for (const fn of listeners) fn();
  await bridge()?.set(next);
}

/** Loads the saved language before the console's first render. */
export async function initLanguage(): Promise<void> {
  try {
    await setLocale(resolveLanguage(languagePref(), systemTags()));
  } catch {
    // A catalog that fails to load leaves the console in English.
  }
}

export function useLanguagePref(): LanguagePref {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    languagePref,
    languagePref,
  );
}
