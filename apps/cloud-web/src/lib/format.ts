/**
 * Display formatting. Auto-director time is shown as "h mm" (e.g. "12 h 05"), always truncated
 * toward zero so the site never shows more time than there is; the exact value (seconds) is
 * available alongside for tooltips and detail rows. Dates use the viewer's locale.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 5400 → "1 h 30"; -800 → "−0 h 13"; 59 → "0 h 00". */
export function formatHours(seconds: number, locale?: string): string {
  if (!Number.isFinite(seconds)) return "—";
  const neg = seconds < 0;
  const abs = Math.floor(Math.abs(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const hours = h >= 1000 ? h.toLocaleString(locale) : String(h);
  return `${neg && abs >= 60 ? "−" : ""}${hours} h ${pad2(m)}`;
}

/** Exact value for detail rows and tooltips: "5,415 s (1.504 h)". */
export function formatExactSeconds(seconds: number, locale?: string): string {
  const s = Math.round(seconds);
  const hours = (s / 3600).toLocaleString(locale, { maximumFractionDigits: 3 });
  return `${s.toLocaleString(locale)} s (${hours} h)`;
}

/** ISO 8601 duration for <time dateTime>: 5415 → "PT1H30M15S". */
export function isoDuration(seconds: number): string {
  const abs = Math.floor(Math.abs(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${seconds < 0 ? "-" : ""}PT${h}H${m}M${s}S`;
}

/** Short duration for a single session: 1215 → "20 min 15 s", 4000 → "1 h 06". */
export function formatSessionLength(seconds: number): string {
  if (seconds >= 3600) return formatHours(seconds);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
}

function currencyDigits(currency: string, locale?: string): number {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Amount in the currency's minor unit (Stripe convention: cents for USD/EUR, yen for JPY).
 * Whole amounts drop the decimals ("$49"), others keep them ("$15.50").
 */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  const digits = currencyDigits(currency, locale);
  const major = minor / 10 ** digits;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : digits, maximumFractionDigits: digits }).format(major);
  } catch {
    return `${major.toFixed(whole ? 0 : digits)} ${currency.toUpperCase()}`;
  }
}

export function formatDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "3 minutes ago", "in 2 days" (viewer's locale). */
export function formatRelative(iso: string | null | undefined, now: number = Date.now(), locale?: string): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 30 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(iso, locale);
}

/** mm:ss countdown to an instant ("9:05"); "0:00" once passed. */
export function formatCountdown(untilIso: string, now: number = Date.now()): string {
  const left = Math.max(0, Math.floor((new Date(untilIso).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${pad2(left % 60)}`;
}

const PLATFORMS: Record<string, string> = { win32: "Windows", windows: "Windows", darwin: "macOS", linux: "Linux" };
export const platformLabel = (p: string) => PLATFORMS[p.toLowerCase()] ?? p;

/** Local calendar date (yyyy-mm-dd) of an instant, for <input type="date">. */
export function toDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Start of a local calendar date (yyyy-mm-dd) as an ISO instant. */
export function fromDateInput(date: string, endOfDay = false): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (endOfDay ? 1 : 0));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
