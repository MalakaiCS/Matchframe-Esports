import type { HudKillfeedEntry, HudState } from "@matchframe/hud-sdk";
import { Headshot, Skull, Suicide } from "../icons.tsx";
import { sideClass } from "../util.ts";
import "../styles/killfeed.scss";
import Weapon from "./Weapon.tsx";

/**
 * One kill. "exact": the kill as the game reported it. "elimination": the player died but the game
 * did not say who killed them (skull only). "probable": an estimated pairing, marked with "≈".
 */
function Kill({ e }: { e: HudKillfeedEntry }) {
  const suicide = !!e.killer && e.killer.steamId === e.victim.steamId;
  let way;
  if (suicide) way = <Suicide />;
  else if (e.kind === "elimination" || !e.weapon) way = <Skull className="weapon" />;
  else way = <Weapon weapon={e.weapon === "planted_c4" ? "c4" : e.weapon} active={false} />;
  return (
    <div className={`single_kill_container kind-${e.kind}`}>
      <div className="single_kill">
        {e.killer && !suicide ? <div className={`killer_name ${sideClass(e.killer.side)}`}>{e.killer.name}</div> : null}
        <div className="way">
          {e.kind === "probable" ? <span className="probable" title="Estimated">≈</span> : null}
          {way}
          {e.headshot ? <Headshot /> : null}
        </div>
        <div className={`victim_name ${sideClass(e.victim.side)}`}>{e.victim.name}</div>
      </div>
    </div>
  );
}

/** Kills of the current round (top right). */
export default function Killfeed({ state }: { state: HudState }) {
  return (
    <div className="killfeed">
      {state.killfeed.entries.slice(-6).map((e) => (
        <Kill key={e.id} e={e} />
      ))}
    </div>
  );
}
