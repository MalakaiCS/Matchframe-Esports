import { useRef } from "react";
import type { HudKillfeedEntry, HudState } from "@matchframe/hud-sdk";
import { BlindIcon, HeadshotIcon, SkullIcon } from "./Icons.tsx";
import { WeaponIcon } from "./WeaponIcon.tsx";

/** How long a kill stays on screen, and how many at most. */
const LIFETIME_MS = 7000;
const MAX_ROWS = 5;

/** Rows appear when first seen and leave after LIFETIME_MS (the last half second fades out). */
function useLifetimes(entries: HudKillfeedEntry[], now: number): { entry: HudKillfeedEntry; leaving: boolean }[] {
  const firstSeen = useRef(new Map<string, number>());
  const seen = firstSeen.current;
  for (const e of entries) if (!seen.has(e.id)) seen.set(e.id, now);
  for (const id of seen.keys()) if (!entries.some((e) => e.id === id)) seen.delete(id);
  return entries
    .map((entry) => ({ entry, age: now - (seen.get(entry.id) ?? now) }))
    .filter((x) => x.age < LIFETIME_MS)
    .slice(-MAX_ROWS)
    .map(({ entry, age }) => ({ entry, leaving: age > LIFETIME_MS - 500 }));
}

function Kill({ k, leaving }: { k: HudKillfeedEntry; leaving: boolean }) {
  const suicide = !!k.killer && k.killer.steamId === k.victim.steamId;
  return (
    <div className={`mf-kill mf-kill-${k.kind} ${k.killer && !suicide ? `by-${k.killer.side ?? "none"}` : ""} ${leaving ? "is-leaving" : ""}`} data-kill={k.kind}>
      {k.killer && !suicide ? (
        <span className="mf-kill-killer">
          <span className={`mf-kill-name mf-side-${k.killer.side ?? "none"}`}>{k.killer.name}</span>
          {k.assister ? (
            <span className={`mf-kill-assist mf-side-${k.assister.side ?? "none"}`}>
              <span aria-hidden>+</span>
              {k.assister.name}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="mf-kill-way">
        {k.attackerBlind ? <BlindIcon size={18} className="mf-kill-mod" /> : null}
        {k.weapon && !suicide ? <WeaponIcon weapon={k.weapon} className="mf-kill-weapon" /> : <SkullIcon size={20} className="mf-kill-skull" />}
        {k.headshot ? <HeadshotIcon size={18} className="mf-kill-mod" /> : null}
      </span>
      <span className={`mf-kill-name mf-kill-victim mf-side-${k.victim.side ?? "none"}`}>{k.victim.name}</span>
    </div>
  );
}

/**
 * Kills of the round, newest at the bottom. Game data (GSI) reports no kill events: kills are paired
 * from counter changes (kind "probable") and the weapon is the killer's weapon in hand. A death that
 * could not be paired shows the victim only (skull); nothing is invented.
 */
export function Killfeed({ state, now }: { state: HudState; now: number }) {
  const rows = useLifetimes(state.killfeed.entries, now);
  if (rows.length === 0) return null;
  return (
    <div className="mf-killfeed" data-mode={state.killfeed.mode}>
      {rows.map(({ entry, leaving }) => (
        <Kill key={entry.id} k={entry} leaving={leaving} />
      ))}
    </div>
  );
}
