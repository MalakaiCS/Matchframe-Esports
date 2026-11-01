/**
 * How far ahead to run the website's clock in a test so that "a few hours ago" is still this month.
 * Usage is counted per calendar month (UTC), so usage recorded in the first hours of a month would
 * fall in the month before and the test would see none. Zero except in the first 12 hours of a month (tests record usage up to 8 hours back).
 */
export function monthSafeOffsetMs(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(0, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + 12 * 3_600_000 - now);
}
