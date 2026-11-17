import { memo, useRef } from "react";
import type { HudKillfeedEntry, HudState } from "@matchframe/hud-sdk";
import { useNow } from "../shared/useHud.ts";
import { FitText } from "./bits.tsx";
import { Blinded, DeadMark, Headshot, Weapon } from "./icons.tsx";
import { DEMO, DEMO_NO_SPONSOR, type Settings } from "./util.ts";

type Placement = NonNullable<HudState["sponsors"][string]>;

/**
 * A sponsor spot: the operator's sponsor scheduled for `zone` (its image, else its name), or
 * nothing. Demo pages show where the slot is.
 */
export function SponsorSpot({ sponsor, className }: { sponsor: Placement | null | undefined; className: string }) {
  if (!sponsor) {
    // Demo pages show where the sponsor goes (`?sponsor=none`: nothing, as live with none scheduled).
    if (!DEMO || DEMO_NO_SPONSOR) return null;
    return (
      <div className={`st-sponsor ${className} is-demo`}>
        <span className="st-sponsor-name">YOUR SPONSOR</span>
      </div>
    );
  }
  return (
    <div key={sponsor.sponsorId} className={`st-sponsor ${className}`}>
      {sponsor.assetUrl ? <img src={sponsor.assetUrl} alt={sponsor.name} /> : <span className="st-sponsor-name">{sponsor.name}</span>}
    </div>
  );
}

/** How long a kill stays on screen (the last half second fades out). */
const LIFETIME_MS = 7000;

function Kill({ k, leaving }: { k: HudKillfeedEntry; leaving: boolean }) {
  const suicide = !!k.killer && k.killer.steamId === k.victim.steamId;
  const killer = k.killer && !suicide ? k.killer : null;
  return (
    <div className={`mf-kill mf-kill-${k.kind} ${killer ? `by-${killer.side ?? "none"}` : ""} ${leaving ? "is-leaving" : ""}`} data-kill={k.kind}>
      {killer ? (
        <span className="mf-kill-killer">
          <FitText text={killer.name} className={`mf-kill-name mf-side-${killer.side ?? "none"}`} />
          {k.assister ? (
            <span className={`mf-kill-assist mf-side-${k.assister.side ?? "none"}`}>
              <span aria-hidden>+</span>
              {k.assister.name}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="mf-kill-way">
        {k.attackerBlind ? <Blinded size={18} className="mf-kill-mod" /> : null}
        {k.weapon && killer && k.kind !== "elimination" ? <Weapon weapon={k.weapon} kill className="mf-kill-weapon" /> : <DeadMark size={18} />}
        {k.headshot ? <Headshot size={18} className="mf-kill-mod" /> : null}
      </span>
      <FitText text={k.victim.name} className={`mf-kill-name mf-kill-victim mf-side-${k.victim.side ?? "none"}`} />
    </div>
  );
}

/**
 * The killfeed, newest at the bottom: killer (+ assister), weapon, headshot and blind marks, victim,
 * each kill for seven seconds, in the shared killfeed's markup and timing, with the icon pack's
 * icons when loaded. Re-renders four times a second so rows expire; nothing else re-renders with it.
 */
const Killfeed = memo(function Killfeed({ state, rows }: { state: HudState; rows: number }) {
  const now = useNow(250);
  const firstSeen = useRef(new Map<string, number>());
  const seen = firstSeen.current;
  const entries = state.killfeed.entries;
  for (const e of entries) if (!seen.has(e.id)) seen.set(e.id, now);
  for (const id of seen.keys()) if (!entries.some((e) => e.id === id)) seen.delete(id);
  const shown = entries
    .map((entry) => ({ entry, age: now - (seen.get(entry.id) ?? now) }))
    .filter((x) => x.age < LIFETIME_MS)
    .slice(-rows);
  if (shown.length === 0) return null;
  return (
    <div className="mf-killfeed" data-mode={state.killfeed.mode}>
      {shown.map(({ entry, age }) => (
        <Kill key={entry.id} k={entry} leaving={age > LIFETIME_MS - 500} />
      ))}
    </div>
  );
});

/**
 * Top right: the sponsor slot (top bar placement), and the killfeed at its own place under it, which
 * stays put whether a sponsor is on, scheduled later or none (the compact page has no sponsor: its
 * killfeed sits at the top).
 */
export function TopRight({ state, settings, compact }: { state: HudState; settings: Settings; compact: boolean }) {
  const sponsor = !compact && settings.showSponsors ? <SponsorSpot sponsor={state.sponsors.top_bar} className="st-sponsor-top" /> : null;
  return (
    <div className="st-topright">
      {sponsor}
      {settings.showKillfeed ? (
        <div className="st-feed">
          <Killfeed state={state} rows={settings.killfeedRows} />
        </div>
      ) : null}
    </div>
  );
}
