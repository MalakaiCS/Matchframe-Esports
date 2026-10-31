import { useEffect, useRef, useState } from "react";
import type { HudKillfeedEntry, HudState } from "@matchframe/hud-sdk";
import { BlindIcon, HeadshotIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { sideColor, teamVars, type Settings } from "./util.ts";

/** How long a kill stays (its last 400 ms fade out in CSS), and how many rows at most. */
const LIFETIME_MS = 7000;
const MAX_ROWS = 6;
const DEMO = new URLSearchParams(location.search).has("demo");

/** Sponsor slot: the sponsor scheduled for the scoreboard slot (or top bar), else the sponsor text setting. */
export function SponsorSlot({ state, settings }: { state: HudState; settings: Settings }) {
  const s = state.sponsors.scoreboard_slot ?? state.sponsors.top_bar ?? null;
  const name = s?.name ?? (settings.sponsorText || (DEMO ? "Your sponsor" : ""));
  if (!s && !name) return null;
  return (
    <div className="lu-sponsor" key={s?.sponsorId ?? name}>
      <span className="lu-sponsor-tile">{s?.assetUrl ? <img src={s.assetUrl} alt="" /> : <span className="lu-sponsor-mono">{name.slice(0, 1).toUpperCase()}</span>}</span>
      <span className="lu-sponsor-text">
        <span className="lu-sponsor-label">PRESENTED BY</span>
        <span className="lu-sponsor-name">{name}</span>
      </span>
    </div>
  );
}

function Kill({ k, state, settings }: { k: HudKillfeedEntry; state: HudState; settings: Settings }) {
  const suicide = !!k.killer && k.killer.steamId === k.victim.steamId;
  const killer = k.killer && !suicide ? k.killer : null;
  return (
    <div className={`lu-kill lu-kill-${k.kind}`} style={teamVars(killer ? sideColor(state, settings, killer.side) : "#5d6575")}>
      {killer ? (
        <span className="lu-kill-name" style={{ color: sideColor(state, settings, killer.side) }}>
          {killer.name}
        </span>
      ) : null}
      {killer && k.assister ? (
        <span className="lu-kill-assist" style={{ color: sideColor(state, settings, k.assister.side) }}>
          <i>+</i>
          {k.assister.name}
        </span>
      ) : null}
      <span className="lu-kill-way">
        {k.attackerBlind ? <BlindIcon size={17} /> : null}
        {k.weapon && killer ? <WeaponIcon weapon={k.weapon} className="lu-kill-weapon" /> : <SkullIcon size={18} className="lu-kill-skull" />}
        {k.headshot ? <HeadshotIcon size={16} /> : null}
      </span>
      <span className="lu-kill-name lu-kill-victim" style={{ color: sideColor(state, settings, k.victim.side) }}>
        {k.victim.name}
      </span>
    </div>
  );
}

/**
 * The round's kills under the sponsor slot, newest at the bottom. A row slides in from the right
 * just after the victim's card turns dead, and fades after ~7 s (a timer drops it, no clock tick).
 */
export function Killfeed({ state, settings }: { state: HudState; settings: Settings }) {
  const firstSeen = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const now = performance.now();
  const seen = firstSeen.current;
  const entries = state.killfeed.entries;
  for (const e of entries) if (!seen.has(e.id)) seen.set(e.id, now);
  for (const id of [...seen.keys()]) if (!entries.some((e) => e.id === id)) seen.delete(id);
  const rows = entries.filter((e) => now - (seen.get(e.id) ?? now) < LIFETIME_MS).slice(-MAX_ROWS);
  const nextExpiry = rows.length ? Math.min(...rows.map((e) => (seen.get(e.id) ?? now) + LIFETIME_MS)) : null;
  useEffect(() => {
    if (nextExpiry === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, nextExpiry - performance.now()) + 30);
    return () => clearTimeout(t);
  }, [nextExpiry]);
  return (
    <div className="lu-killfeed" data-mode={state.killfeed.mode}>
      {rows.map((e) => (
        <Kill key={e.id} k={e} state={state} settings={settings} />
      ))}
    </div>
  );
}
