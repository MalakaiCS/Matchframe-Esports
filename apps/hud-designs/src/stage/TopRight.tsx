import { memo } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { Killfeed as SharedKillfeed } from "../../../hud-renderer/src/components/Killfeed.tsx";
import { useNow } from "../shared/useHud.ts";
import { DEMO, type Settings } from "./util.ts";

type Placement = NonNullable<HudState["sponsors"][string]>;

/**
 * A sponsor spot: the operator's sponsor scheduled for `zone` (its image, else its name), or
 * nothing. Demo pages show where the slot is.
 */
export function SponsorSpot({ sponsor, className }: { sponsor: Placement | null | undefined; className: string }) {
  if (!sponsor) {
    if (!DEMO) return null;
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

/**
 * The shared killfeed (the HUD renderer's: killer, assister, weapon, headshot and blind marks,
 * victim; each kill for seven seconds), restyled by stage.css. Re-renders four times a second so
 * rows expire; nothing else on the page re-renders with it.
 */
const Killfeed = memo(function Killfeed({ state, rows }: { state: HudState; rows: number }) {
  const now = useNow(250);
  return <SharedKillfeed state={{ ...state, killfeed: { ...state.killfeed, entries: state.killfeed.entries.slice(-rows) } }} now={now} />;
});

/** Top right: the sponsor slot (top bar placement), and the killfeed under it. */
export function TopRight({ state, settings, compact }: { state: HudState; settings: Settings; compact: boolean }) {
  const sponsor = !compact && settings.showSponsors ? <SponsorSpot sponsor={state.sponsors.top_bar} className="st-sponsor-top" /> : null;
  return (
    <div className="st-topright">
      {sponsor}
      {settings.showKillfeed ? <Killfeed state={state} rows={settings.killfeedRows} /> : null}
    </div>
  );
}
