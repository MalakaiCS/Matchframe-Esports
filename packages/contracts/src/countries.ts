/**
 * Countries for team and player records: ISO 3166-1 alpha-2 codes (the stored value is the code;
 * names come from Intl.DisplayNames in the viewer's language). XK (Kosovo) is included as the
 * widely used user-assigned code. Plain data, importable without the schemas
 * (`@matchframe/contracts/countries`).
 */
export const COUNTRY_CODES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE",
  "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD",
  "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME",
  "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI",
  "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK",
  "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
];

const CODES = new Set(COUNTRY_CODES);

/** Common alternative codes people type. */
const ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };

export function isCountryCode(code: string): boolean {
  return CODES.has(code);
}

/** Country name for a code in a language (falls back to the code). */
export function countryName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
let byName: Map<string, string> | null = null;

/**
 * The country code for what someone typed in a spreadsheet: a two-letter code (any case) or the
 * country's English name. Null when it is not a country.
 */
export function countryFromInput(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) {
    const up = ALIASES[v.toUpperCase()] ?? v.toUpperCase();
    return CODES.has(up) ? up : null;
  }
  if (!byName) {
    byName = new Map();
    for (const c of COUNTRY_CODES) byName.set(norm(countryName(c)), c);
  }
  return byName.get(norm(v)) ?? null;
}
