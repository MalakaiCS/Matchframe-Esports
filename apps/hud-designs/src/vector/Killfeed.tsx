import { useEffect, useRef, useState } from "react";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import { BlindIcon, HeadshotIcon, SkullIcon, WeaponIcon } from "../shared/parts.ts";
import { Flip } from "./bits.tsx";

/** How long a kill stays, how long it takes to fade, how many rows at most, and the row pitch (px). */
const LIFETIME_MS = 7000;
const FADE_MS = 400;
const MAX_ROWS = 5;
const ROW = 34;

function Kill({ k }: { k: HudKillfeedEntry }) {
  const suicide = !!k.killer && k.killer.steamId === k.victim.steamId;
  const killer = k.killer && !suicide ? k.killer : null;
  return (
    <div className={`vx-kill kind-${k.kind} vx-side-${(killer ?? k.victim).side ?? "none"}`}>
      {killer ? (
        <span className={`vx-kill-name vx-side-${killer.side ?? "none"}`}>
          {killer.name}
          {k.assister ? (
            <span className={`vx-kill-assist vx-side-${k.assister.side ?? "none"}`}>
              <i>+</i>
              {k.assister.name}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="vx-kill-way">
        {k.attackerBlind ? <BlindIcon size={16} className="vx-kill-mod" /> : null}
        {k.weapon && killer && k.kind !== "elimination" ? <WeaponIcon weapon={k.weapon === "planted_c4" ? "c4" : k.weapon} className="vx-kill-gun" /> : <SkullIcon size={16} className="vx-kill-skull" />}
        {k.headshot ? <HeadshotIcon size={15} className="vx-kill-mod" /> : null}
      </span>
      <span className={`vx-kill-name is-victim vx-side-${k.victim.side ?? "none"}`}>{k.victim.name}</span>
    </div>
  );
}

/**
 * Kills of the round, newest at the bottom. A new row slides in from the right a beat after the
 * victim's card collapses; rows fade after seven seconds and the rest glide up (transform only).
 */
export function Killfeed({ entries, top }: { entries: HudKillfeedEntry[]; top: boolean }) {
  const seen = useRef(new Map<string, number>());
  const [, bump] = useState(0);
  const now = performance.now();
  const map = seen.current;
  for (const e of entries) if (!map.has(e.id)) map.set(e.id, now);
  for (const id of map.keys()) if (!entries.some((e) => e.id === id)) map.delete(id);
  const rows = entries
    .map((e) => ({ e, age: now - (map.get(e.id) ?? now) }))
    .filter((r) => r.age < LIFETIME_MS)
    .slice(-MAX_ROWS);
  // Re-render when the next row starts fading or is due to go.
  useEffect(() => {
    let next = Infinity;
    for (const r of rows) {
      const fade = LIFETIME_MS - FADE_MS - r.age;
      next = Math.min(next, fade > 0 ? fade : LIFETIME_MS - r.age);
    }
    if (next === Infinity) return;
    const t = setTimeout(() => bump((n) => n + 1), next + 16);
    return () => clearTimeout(t);
  });
  return (
    <div className={`vx-feed ${top ? "is-top" : ""}`}>
      {rows.map((r, i) => (
        <div key={r.e.id} className={`vx-feed-row ${r.age > LIFETIME_MS - FADE_MS ? "is-leaving" : ""}`} style={{ transform: `translateY(${i * ROW}px)` }}>
          <Kill k={r.e} />
        </div>
      ))}
    </div>
  );
}

/** "3 VS 2": slides in from the right edge when the round goes live, out when it ends. */
export function AliveBox({ left, right, on }: { left: number; right: number; on: boolean }) {
  return (
    <div className={`vx-alive ${on ? "is-on" : ""}`}>
      <span className="vx-alive-team vx-left">
        <Flip value={left} />
      </span>
      <span className="vx-alive-team vx-right">
        <Flip value={right} />
      </span>
      <span className="vx-alive-vs">VS</span>
    </div>
  );
}
