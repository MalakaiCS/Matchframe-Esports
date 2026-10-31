import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { HudSide, HudState, HudTeam } from "@matchframe/hud-sdk";
import { teamColor } from "../shared/format.ts";

/** The manifest's settings defaults (settingsSchema in package-files/lineup/manifest.json). */
export const DEFAULTS = {
  ctColor: "#3d8bff",
  tColor: "#ff3d6e",
  eventTitle: "",
  sponsorText: "",
  showRadar: true,
  showKillfeed: true,
  showObserved: true,
  showSeries: true,
  showMoney: true,
};
export type Settings = typeof DEFAULTS;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The HUD's settings from the HUD Library, each falling back to its manifest default. */
export function readSettings(s: Record<string, unknown>): Settings {
  const str = (k: "eventTitle" | "sponsorText") => (typeof s[k] === "string" ? (s[k] as string).trim() : DEFAULTS[k]);
  const color = (k: "ctColor" | "tColor") => (typeof s[k] === "string" && HEX.test(s[k] as string) ? (s[k] as string) : DEFAULTS[k]);
  const bool = (k: "showRadar" | "showKillfeed" | "showObserved" | "showSeries" | "showMoney") => (typeof s[k] === "boolean" ? (s[k] as boolean) : DEFAULTS[k]);
  return {
    ctColor: color("ctColor"),
    tColor: color("tColor"),
    eventTitle: str("eventTitle"),
    sponsorText: str("sponsorText"),
    showRadar: bool("showRadar"),
    showKillfeed: bool("showKillfeed"),
    showObserved: bool("showObserved"),
    showSeries: bool("showSeries"),
    showMoney: bool("showMoney"),
  };
}

/** A team's colour: its own, else the colour of the side it plays. */
export const colorOf = (team: HudTeam, settings: Settings): string => teamColor(team, settings as unknown as Record<string, unknown>, { ct: settings.ctColor, t: settings.tColor });

/** Colour for a side in the killfeed: the team playing it. */
export function sideColor(state: HudState, settings: Settings, side: HudSide | null): string {
  if (state.left.side === side) return colorOf(state.left, settings);
  if (state.right.side === side) return colorOf(state.right, settings);
  return side === "T" ? settings.tColor : side === "CT" ? settings.ctColor : "#9aa4b5";
}

/** Dark or white text on a colour (team colours can be light). */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0d1016" : "#ffffff";
}

/** Up to two letters for a player tile without an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_.-]+/).filter(Boolean);
  if (parts.length > 1 && /^[a-z]/i.test(parts[1]!)) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

export const shortMoney = (n: number): string => (n >= 10000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : `$${n.toLocaleString("en-US")}`);

export const teamVars = (color: string): CSSProperties => ({ "--lu-team": color, "--lu-team-ink": inkOn(color) }) as CSSProperties;

/**
 * A number that counts down quickly to a lower value (health taking damage) and jumps straight up
 * to a higher one. Only the component showing it re-renders while it counts.
 */
export function useCountdown(value: number, ms = 260): number {
  const [shown, setShown] = useState(value);
  const display = Math.max(shown, value);
  const last = useRef(display);
  last.current = display;
  useEffect(() => {
    const from = last.current;
    if (value >= from) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setShown(Math.round(from + (value - from) * (1 - (1 - k) * (1 - k))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return display;
}

/**
 * The content that was on screen under the previous key, for `ms` after the key changes (the
 * observed player switching: the old panel slides out while the new one comes in).
 */
export function useOutgoing<T>(key: string | null, value: T, ms: number): { key: string; value: T } | null {
  const [out, setOut] = useState<{ key: string; value: T } | null>(null);
  const last = useRef<{ key: string | null; value: T }>({ key, value });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { key, value };
    if (before.key === key || before.key === null || key === null) return;
    setOut({ key: before.key, value: before.value });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOut(null), ms);
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return out;
}
