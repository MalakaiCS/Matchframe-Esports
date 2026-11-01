import { COUNTRY_CODES } from "@matchframe/contracts/countries";

/**
 * Country flags as SVG files (country-flag-icons, MIT; Windows' Chromium does not draw flag
 * emoji). Each flag is its own small file in the console bundle, loaded only when shown.
 */
const files = import.meta.glob<string>("../../node_modules/country-flag-icons/flags/3x2/*.svg", { query: "?no-inline", import: "default", eager: true });

const byCode = new Map<string, string>();
for (const [path, url] of Object.entries(files)) {
  const code = /([A-Z]{2})\.svg$/.exec(path)?.[1];
  if (code) byCode.set(code, url);
}

export function flagUrl(code: string | null | undefined): string | null {
  return code ? (byCode.get(code.toUpperCase()) ?? null) : null;
}

let names: Intl.DisplayNames | null = null;
/** The country's name in the console's language (codes are ISO 3166-1 alpha-2). */
export function countryLabel(code: string | null | undefined): string {
  if (!code) return "";
  try {
    names ??= new Intl.DisplayNames([typeof navigator !== "undefined" ? navigator.language : "en", "en"], { type: "region", fallback: "code" });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export interface CountryOption {
  code: string;
  name: string;
}

let options: CountryOption[] | null = null;
/** Every country, sorted by name in the console's language. */
export function countryOptions(): CountryOption[] {
  options ??= COUNTRY_CODES.map((code) => ({ code, name: countryLabel(code) })).sort((a, b) => a.name.localeCompare(b.name));
  return options;
}
