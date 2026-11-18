import { useSyncExternalStore } from "react";
import { template, translate, type Catalog, type Locale, type Vars } from "./core.ts";
import EN_JSON from "./locales/en.json";

export { LANGUAGE_NAMES, LOCALES, isLanguagePref, isLocale, resolveLanguage, type LanguagePref, type Locale, type Vars } from "./core.ts";

/**
 * The console's translations (ADR-082). One JSON catalog per language in ./locales/, its top-level
 * keys one per screen or area ("namespace": settings, hudlib, live, …). English is bundled; the
 * other languages load when chosen. `t()` is a plain function usable anywhere; the App subscribes to
 * the language (useLocale), so the whole console renders again, without a restart, when it changes.
 */

const EN: Catalog = EN_JSON as Catalog;
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: unknown }>> = {
  "pt-BR": () => import("./locales/pt-BR.json"),
  es: () => import("./locales/es.json"),
  de: () => import("./locales/de.json"),
  fr: () => import("./locales/fr.json"),
  pl: () => import("./locales/pl.json"),
  ru: () => import("./locales/ru.json"),
};

let current: { locale: Locale; catalog: Catalog | undefined } = { locale: "en", catalog: EN };
const cache = new Map<Locale, Catalog>([["en", EN]]);
const listeners = new Set<() => void>();

export async function loadCatalog(locale: Locale): Promise<Catalog> {
  const hit = cache.get(locale);
  if (hit) return hit;
  const catalog = (await LOADERS[locale as Exclude<Locale, "en">]()).default as Catalog;
  cache.set(locale, catalog);
  return catalog;
}

/** Switches the console's language (loads its catalog first); every subscriber renders again. */
export async function setLocale(locale: Locale): Promise<void> {
  const catalog = await loadCatalog(locale);
  if (current.locale === locale && current.catalog === catalog) return;
  current = { locale, catalog };
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const fn of listeners) fn();
}

export function locale(): Locale {
  return current.locale;
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current language; a component using it renders again when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, locale, locale);
}

const chain = () => ({ locale: current.locale, catalog: current.catalog, fallback: EN });

/** Translated plain text for a key (rich-text tags stripped); the key itself when it is missing. */
export function t(key: string, vars?: Vars): string {
  return translate(chain(), key, vars);
}

/** The raw template (plural form chosen) for <T>; null when missing. */
export function rawTemplate(key: string, vars?: Vars): { text: string; locale: Locale } | null {
  return template(chain(), key, vars);
}

/** True when the key exists (in the language or in English). */
export function hasKey(key: string): boolean {
  return template(chain(), key) !== null;
}

/**
 * A module-level table of labels (a map or a list) built in the current language: `make` runs again
 * after the language changes, so `MODE_INFO[mode].label` and `NAV.map(…)` keep working unchanged.
 */
export function perLocale<T extends object>(make: () => T): T {
  let cache: { locale: Locale; catalog: Catalog | undefined; value: T } | null = null;
  const get = (): T => {
    if (!cache || cache.locale !== current.locale || cache.catalog !== current.catalog) cache = { locale: current.locale, catalog: current.catalog, value: make() };
    return cache.value;
  };
  const probe = make();
  const target = (Array.isArray(probe) ? [] : {}) as T;
  return new Proxy(target, {
    get: (_, p) => {
      const v = get();
      const out = Reflect.get(v, p);
      return typeof out === "function" && Array.isArray(v) ? out.bind(v) : out;
    },
    has: (_, p) => Reflect.has(get(), p),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_, p) => {
      const d = Reflect.getOwnPropertyDescriptor(get(), p);
      if (d && p === "length" && Array.isArray(target)) return { ...d, configurable: false };
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

// ------------------------------------------------------------------ numbers, dates and money

const cached = <K, V>(make: (k: K) => V) => {
  const m = new Map<string, V>();
  return (k: K) => {
    const id = JSON.stringify(k);
    let v = m.get(id);
    if (!v) {
      v = make(k);
      m.set(id, v);
    }
    return v;
  };
};
const numberFmt = cached(([l, o]: [Locale, Intl.NumberFormatOptions]) => new Intl.NumberFormat(l, o));
const dateFmt = cached(([l, o]: [Locale, Intl.DateTimeFormatOptions]) => new Intl.DateTimeFormat(l, o));

/** A number in the console's language (1,234.5 / 1.234,5 / 1 234,5). */
export function formatNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return numberFmt([current.locale, opts]).format(n);
}

/** A date and/or time in the console's language. */
export function formatDate(d: Date | number | string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return dateFmt([current.locale, opts]).format(date);
}

/** An amount of money in the console's language ($1,200 / 1.200 US$ / 1 200 $US). */
export function formatMoney(amount: number, currency = "USD", opts: Intl.NumberFormatOptions = {}): string {
  return numberFmt([current.locale, { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2, ...opts }]).format(amount);
}
