import { useLayoutEffect, useRef, useState } from "react";
import type { HudTeam } from "@matchframe/hud-sdk";

/**
 * Text that keeps its whole: it takes the width its box allows and, when longer, its font shrinks to
 * fit, down to `min` of its size; only beyond that does it end in an ellipsis. Measured when the text
 * or its box size changes and again once the web fonts are in (only this element re-lays out).
 */
export function FitText({ text, className = "", min = 0.7 }: { text: string; className?: string; min?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Widths in the page's own pixels (the stage may be scaled): the box, then the text at its natural width.
    const fit = () => {
      el.style.fontSize = "";
      const box = el.getBoundingClientRect().width;
      if (box === 0) return;
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const k = el.offsetWidth ? box / el.offsetWidth : 1;
      el.style.cssText = "flex: none; width: max-content; max-width: none";
      const need = el.getBoundingClientRect().width / k - pad;
      el.style.cssText = "";
      const room = box / k - pad;
      if (need > room + 0.1) el.style.fontSize = `${Math.max(min, (room / need) * 0.985) * parseFloat(cs.fontSize)}px`;
    };
    fit();
    let live = true;
    const again = () => live && fit();
    void document.fonts?.ready.then(again);
    document.fonts?.addEventListener?.("loadingdone", again);
    return () => {
      live = false;
      document.fonts?.removeEventListener?.("loadingdone", again);
    };
  }, [text, min]);
  return (
    <span ref={ref} className={`st-fit ${className}`}>
      {text}
    </span>
  );
}

/** A neutral mark for a team with neither a logo nor a usable tag (MatchFrame's own shield). */
export function NeutralMark() {
  return (
    <svg className="st-logo-mark" viewBox="0 0 24 28" aria-hidden>
      <path d="M12 1.5l9.5 3.5v8.5c0 6.2-4 10.6-9.5 13-5.5-2.4-9.5-6.8-9.5-13V5z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M7 14.5h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** The team's tag in capitals (its short name, else its name), at most `max` characters; null when it has no letters or digits (a placeholder such as "?"). */
export function teamTag(team: Pick<HudTeam, "shortName" | "name">, max: number): string | null {
  const tag = (team.shortName || team.name || "").trim().slice(0, max).toUpperCase();
  return /[\p{L}\p{N}]/u.test(tag) ? tag : null;
}

/**
 * The team's logo; without one (or when it fails to load) its tag as a wordmark in Antonio, and a
 * neutral shield when the tag has no letters or digits (a placeholder such as "?").
 */
export function TeamLogo({ team, className = "" }: { team: HudTeam; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (team.logoUrl && broken !== team.logoUrl) {
    return (
      <span className={`st-logo has-img ${className}`}>
        <img src={team.logoUrl} alt="" onError={() => setBroken(team.logoUrl)} />
      </span>
    );
  }
  const mark = teamTag(team, 4);
  if (!mark) {
    return (
      <span className={`st-logo is-neutral ${className}`}>
        <NeutralMark />
      </span>
    );
  }
  return (
    <span className={`st-logo ${className}`} data-len={Math.min(4, mark.length)}>
      {mark}
    </span>
  );
}

/** A neutral head-and-shoulders figure for players without a picture (MatchFrame's own drawing). */
function Figure() {
  return (
    <svg className="st-figure" viewBox="0 0 64 72" preserveAspectRatio="xMidYMax meet" aria-hidden>
      <path d="M4 72c1-13 8-19 18-21l5-2h10l5 2c10 2 17 8 18 21z" fill="#58647a" />
      <path d="M26 40h12v9c-3 3-9 3-12 0z" fill="#46516a" />
      <ellipse cx="32" cy="27" rx="11" ry="13.5" fill="#7a869c" />
    </svg>
  );
}

/** A player's picture filling its slot (bottom-aligned), or the neutral figure. */
export function Photo({ url, className = "" }: { url: string | null; className?: string }) {
  return <span className={`st-photo ${className}`}>{url ? <img src={url} alt="" /> : <Figure />}</span>;
}

/** Kills: a small four-tick sight (MatchFrame's own mark). */
export function KillsMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="mf-icon st-mark" width={size} height={size} viewBox="0 0 16 16" aria-label="kills">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 0v4.5M8 11.5V16M0 8h4.5M11.5 8H16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** A round kill: a small outlined diamond on the card's top edge (MatchFrame's own mark). */
export function RoundKill() {
  return (
    <svg className="st-rk" viewBox="0 0 14 14" aria-hidden>
      <path d="M7 0.8L13.2 7 7 13.2 0.8 7z" fill="currentColor" stroke="#0a0f18" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Timeouts remaining as pips: filled for each left, outlined for each used (CS2 gives three). */
export function TimeoutPips({ left, className = "" }: { left: number | null; className?: string }) {
  if (left === null) return <span className={`st-pips ${className}`}>–</span>;
  const total = Math.max(3, left);
  return (
    <span className={`st-pips ${className}`} aria-label={`${left} timeouts left`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < left ? "is-left" : ""} />
      ))}
    </span>
  );
}
