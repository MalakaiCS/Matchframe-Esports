/**
 * Translation core (ADR-082), shared by the console and the desktop shell's main process. No DOM, no
 * React, no dependencies: catalogs are plain JSON objects, English is the source and the fallback.
 *
 * - Keys are dotted paths ("settings.language.label"); a catalog nests them as objects.
 * - `{name}` is a placeholder; `<tag>text</tag>` marks rich text the console's <T> component renders.
 * - A plural is an object of CLDR categories ({ one, few, many, other }) chosen by `Intl.PluralRules`
 *   with the `count` value; `count` is formatted with the language's number format.
 */

export const LOCALES = ["en", "pt-BR", "es", "de", "fr", "pl", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export type LanguagePref = "system" | Locale;

/** Each language in its own name (the Language setting lists them this way). */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  pl: "Polski",
  ru: "Русский",
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return v === "system" || isLocale(v);
}

/** The first supported language among BCP 47 tags (the system's, in order); English when none is. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = raw.toLowerCase().replace("_", "-");
    const base = tag.split("-")[0];
    if (base === "en") return "en";
    // Portuguese from Portugal reads Brazilian Portuguese well enough; there is one Portuguese.
    if (base === "pt") return "pt-BR";
    const hit = LOCALES.find((l) => l === base);
    if (hit) return hit;
  }
  return "en";
}

export function resolveLanguage(pref: LanguagePref, systemTags: readonly string[]): Locale {
  return pref === "system" ? matchLocale(systemTags) : pref;
}

export interface Catalog {
  [key: string]: string | Catalog;
}

/** Values for placeholders. `count` picks the plural form. */
export type Vars = Record<string, string | number | null | undefined>;

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export function isPluralNode(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object") return false;
  const keys = Object.keys(v);
  return keys.includes("other") && keys.every((k) => (PLURAL_CATEGORIES as readonly string[]).includes(k) && typeof (v as Record<string, unknown>)[k] === "string");
}

export function lookup(catalog: Catalog | undefined, key: string): string | Catalog | undefined {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

const pluralRules = new Map<string, Intl.PluralRules>();
export function pluralCategory(locale: string, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function countFormat(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    numberFormats.set(locale, f);
  }
  return f;
}

/** A source of translations: the language's catalog first, then English. */
export interface CatalogChain {
  locale: Locale;
  catalog: Catalog | undefined;
  fallback: Catalog;
}

/**
 * The template for a key (plural form already chosen) and the language it is in; null when no
 * catalog has it. The plural form follows the rules of the catalog the template comes from.
 */
export function template(chain: CatalogChain, key: string, vars?: Vars): { text: string; locale: Locale } | null {
  for (const [cat, loc] of [
    [chain.catalog, chain.locale],
    [chain.fallback, "en"],
  ] as const) {
    const node = lookup(cat, key);
    if (typeof node === "string") return { text: node, locale: loc };
    if (isPluralNode(node)) {
      const n = Number(vars?.count ?? 0);
      const form = node[pluralCategory(loc, Number.isFinite(n) ? n : 0)] ?? node.other!;
      return { text: form, locale: loc };
    }
  }
  return null;
}

/** Replaces `{name}` placeholders; `count` uses the language's number format. Unknown names stay as they are. */
export function interpolate(text: string, vars: Vars | undefined, locale: Locale): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return whole;
    if (name === "count" && typeof v === "number") return countFormat(locale).format(v);
    return String(v);
  });
}

/** Strips rich-text tags (`<b>x</b>` → `x`) for places that take plain text (titles, tooltips, dialogs). */
export function stripTags(text: string): string {
  return text.replace(/<(\w+)>([\s\S]*?)<\/\1>/g, "$2");
}

/** The translated, interpolated plain text for a key; the key itself when no catalog has it. */
export function translate(chain: CatalogChain, key: string, vars?: Vars): string {
  const tpl = template(chain, key, vars);
  if (!tpl) return key;
  return stripTags(interpolate(tpl.text, vars, tpl.locale));
}

/** Rich-text pieces of a template: plain text, and `<tag>inner</tag>` spans (not nested). */
export type RichPiece = { kind: "text"; text: string } | { kind: "tag"; name: string; text: string };
export function richPieces(text: string): RichPiece[] {
  const out: RichPiece[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "tag", name: m[1]!, text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
