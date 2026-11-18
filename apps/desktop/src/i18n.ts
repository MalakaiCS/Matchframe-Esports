// The translation core is shared with the console (ADR-082); it has no DOM or React code.
import { isLanguagePref, resolveLanguage, translate, type Catalog, type LanguagePref, type Locale, type Vars } from "../../operator-web/src/i18n/core.ts";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import pl from "./locales/pl.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";

/**
 * The desktop shell's text (tray, dialogs, notifications, the connection page and the messages it
 * hands the console) in the language chosen in the console's Settings → General → Language. The
 * setting is kept in program-settings.json; "system" follows the computer's language.
 */

const CATALOGS: Record<Locale, Catalog> = { en, "pt-BR": ptBR, es, de, fr, pl, ru };

let current: Locale = "en";

export function parseLanguagePref(v: unknown): LanguagePref {
  return isLanguagePref(v) ? v : "system";
}

/** Applies the setting; `system` is the computer's preferred languages (app.getPreferredSystemLanguages()). */
export function setDesktopLanguage(pref: LanguagePref, system: readonly string[]): Locale {
  current = resolveLanguage(pref, system);
  return current;
}

export function desktopLocale(): Locale {
  return current;
}

export function t(key: string, vars?: Vars): string {
  return translate({ locale: current, catalog: CATALOGS[current], fallback: en }, key, vars);
}

/** A whole section of the catalog as plain strings (the connection page takes its text this way). */
export function section(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = (en as Catalog)[name];
  if (src && typeof src === "object") for (const k of Object.keys(src)) out[k] = t(`${name}.${k}`);
  return out;
}

/** A date and time in the current language. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(current === "en" ? "en-GB" : current, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
