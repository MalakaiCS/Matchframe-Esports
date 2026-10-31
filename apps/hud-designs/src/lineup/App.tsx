import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { isLive } from "../shared/format.ts";
import { VARIANT, useHud } from "../shared/useHud.ts";
import { TeamCards } from "./Cards.tsx";
import { BuyPanel, ObservedPanel } from "./Centre.tsx";
import { ScoreBar } from "./ScoreBar.tsx";
import { TopLeft } from "./TopLeft.tsx";
import { Killfeed, SponsorSlot } from "./TopRight.tsx";
import { colorOf, readSettings, sideColor } from "./util.ts";

/** The 1920×1080 design stage scaled to the browser source's size. */
function useStageScale(): number {
  const fit = () => Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
  const [scale, setScale] = useState(fit);
  useEffect(() => {
    const on = () => setScale(fit());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return scale;
}

/**
 * Lineup HUD: series, event title and radar top left; the score bar top centre (the round winner's
 * banner, the bomb bar); sponsor slot and killfeed top right; all ten players along the bottom with
 * the observed player (or the freeze-time economy) in the middle. The `compact` entry point keeps
 * the score bar, killfeed and observed player.
 */
export default function App() {
  const { state, receivedAt } = useHud();
  const scale = useStageScale();
  // Nothing until the first state arrives: the page stays transparent.
  if (!state) return null;
  const settings = readSettings(state.settings);
  const compact = (state.variant || VARIANT) === "compact";
  const phase = state.match.phase;
  const live = isLive(phase) || phase === "over";
  const vars = { transform: `scale(${scale})`, "--lu-ct": settings.ctColor, "--lu-t": settings.tColor, "--radar-ct": sideColor(state, settings, "CT"), "--radar-t": sideColor(state, settings, "T") } as CSSProperties;
  return (
    <div className={`lu-stage ${live ? "is-live" : "is-freeze"} ${compact ? "is-compact" : ""} ${state.stale ? "is-stale" : ""}`} style={vars} data-phase={phase}>
      {compact ? null : <TopLeft state={state} settings={settings} />}
      <ScoreBar state={state} receivedAt={receivedAt} settings={settings} />
      <div className="lu-topright">
        {compact ? null : <SponsorSlot state={state} settings={settings} />}
        {settings.showKillfeed ? <Killfeed state={state} settings={settings} /> : null}
      </div>
      <div className="lu-bottom">
        {compact ? null : <TeamCards state={state} team={state.left} color={colorOf(state.left, settings)} align="left" live={live} showMoney={settings.showMoney} />}
        <div className="lu-centre">
          {compact ? null : <BuyPanel state={state} settings={settings} shown={!live} />}
          {settings.showObserved ? <ObservedPanel state={state} settings={settings} shown={live} /> : null}
        </div>
        {compact ? null : <TeamCards state={state} team={state.right} color={colorOf(state.right, settings)} align="right" live={live} showMoney={settings.showMoney} />}
      </div>
      {/* Honest labels: the test simulation, data that has stopped arriving, a replay on air. */}
      {state.simulated || state.stale || state.replay.active ? (
        <div className="lu-labels">
          {state.replay.active ? <span className="lu-label is-replay">{state.replay.label || "REPLAY"}</span> : null}
          {state.simulated ? <span className="lu-label is-sim">SIMULATION</span> : null}
          {state.stale ? <span className="lu-label is-stale">DATA PAUSED</span> : null}
        </div>
      ) : null}
    </div>
  );
}
