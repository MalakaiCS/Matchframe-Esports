import { describe, expect, it } from "vitest";
import { formatBytes, formatCountdown, formatExactSeconds, formatHours, formatMoney, formatRelative, formatSessionLength, fromDateInput, isoDuration, platformLabel, toDateInput } from "./format.ts";

describe("formatHours (h mm, truncated toward zero)", () => {
  it.each([
    [0, "0 h 00"],
    [59, "0 h 00"],
    [60, "0 h 01"],
    [3599, "0 h 59"],
    [3600, "1 h 00"],
    [5400, "1 h 30"],
    [5459, "1 h 30"],
    [36_000, "10 h 00"],
    [540_000, "150 h 00"],
    [-800, "−0 h 13"],
    [-3660, "−1 h 01"],
    [-30, "0 h 00"],
  ])("%d s → %s", (s, out) => expect(formatHours(s)).toBe(out));

  it("groups thousands of hours and survives bad input", () => {
    expect(formatHours(3_600_000, "en-US")).toBe("1,000 h 00");
    expect(formatHours(Number.NaN)).toBe("—");
  });
});

describe("exact values", () => {
  it("shows exact seconds and decimal hours", () => {
    expect(formatExactSeconds(5415, "en-US")).toBe("5,415 s (1.504 h)");
    expect(formatExactSeconds(7200, "en-US")).toBe("7,200 s (2 h)");
    expect(formatExactSeconds(-600, "en-US")).toBe("-600 s (-0.167 h)");
  });

  it("produces ISO 8601 durations for <time>", () => {
    expect(isoDuration(5415)).toBe("PT1H30M15S");
    expect(isoDuration(0)).toBe("PT0H0M0S");
    expect(isoDuration(-61)).toBe("-PT0H1M1S");
  });

  it("formats single sessions", () => {
    expect(formatSessionLength(45)).toBe("45 s");
    expect(formatSessionLength(1215)).toBe("20 min 15 s");
    expect(formatSessionLength(1200)).toBe("20 min");
    expect(formatSessionLength(4000)).toBe("1 h 06");
  });
});

describe("formatMoney (minor units)", () => {
  it("drops decimals for whole amounts and keeps them otherwise", () => {
    expect(formatMoney(4900, "usd", "en-US")).toBe("$49");
    expect(formatMoney(1550, "usd", "en-US")).toBe("$15.50");
    expect(formatMoney(0, "usd", "en-US")).toBe("$0");
  });

  it("respects zero-decimal currencies and the viewer's locale", () => {
    expect(formatMoney(1500, "jpy", "en-US")).toBe("¥1,500");
    expect(formatMoney(4900, "eur", "de-DE")).toMatch(/^49\s€$/);
  });

  it("falls back for unknown currency codes", () => {
    expect(formatMoney(1000, "zz", "en-US")).toBe("10 ZZ");
  });
});

describe("dates", () => {
  it("counts down to an instant", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(formatCountdown("2026-10-26T12:09:05Z", now)).toBe("9:05");
    expect(formatCountdown("2026-10-26T11:59:00Z", now)).toBe("0:00");
  });

  it("describes relative times", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(formatRelative(null, now)).toBe("never");
    expect(formatRelative("2026-10-26T11:59:50Z", now, "en-US")).toBe("now");
    expect(formatRelative("2026-10-26T11:57:00Z", now, "en-US")).toBe("3 minutes ago");
    expect(formatRelative("2026-10-24T12:00:00Z", now, "en-US")).toBe("2 days ago");
  });

  it("round-trips local calendar dates for <input type=date>", () => {
    const iso = fromDateInput("2026-10-05")!;
    expect(toDateInput(iso)).toBe("2026-10-05");
    const end = fromDateInput("2026-10-05", true)!;
    expect(new Date(end).getTime() - new Date(iso).getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(fromDateInput("05/10/2026")).toBeNull();
  });

  it("labels platforms", () => {
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("haiku")).toBe("haiku");
  });
});

describe("formatBytes (1024 steps)", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1023, "1023 bytes"],
    [1536, "1.5 KB"],
    [820 * 1024, "820 KB"],
    [140 * 1024 ** 2, "140 MB"],
    [1.5 * 1024 ** 3, "1.5 GB"],
    [2 * 1024 ** 3, "2 GB"],
  ])("%d → %s", (n, out) => expect(formatBytes(n, "en-GB")).toBe(out));

  it("survives bad input", () => expect(formatBytes(Number.NaN)).toBe("—"));
});
