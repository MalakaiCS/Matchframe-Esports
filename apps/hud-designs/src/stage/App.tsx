import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { isReplayLayer } from "../../../hud-renderer/src/components/replay.ts";
import { VARIANT, useHud } from "../shared/useHud.ts";
import { TeamCards } from "./Cards.tsx";
import { IconPackProvider } from "./icons.tsx";
import { Observed } from "./Observed.tsx";
import { ReplayLayer } from "./Replay.tsx";
import { ScoreBar } from "./ScoreBar.tsx";
import { Scoreboard } from "./Scoreboard.tsx";
import { TopLeft } from "./TopLeft.tsx";
import { TopRight } from "./TopRight.tsx";
import { colorOf, mix, readSettings, scoreboardPhase, sideColor } from "./util.ts";

/** The `replay` entry point: the replay graphic only (for the replay scene). */
const REPLAY_LAYER = isReplayLayer();

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
 * Stage HUD: the series strip and minimap top left; the event line, score bar and players-alive
 * badge top centre; sponsor slot and killfeed top right; five player cards in each bottom corner
 * and the observed player's cam and name bar between them. In freeze time, timeouts and other
 * breaks the cards make way for a full-width scoreboard bar along the bottom. The `compact` entry
 * point keeps the score bar, killfeed and observed player.
 */
export default function App() {
  const { state, receivedAt } = useHud();
  const scale = useStageScale();
  // Nothing until the first state arrives: the page stays transparent.
  if (!state) return null;
  // CS2's icons when the operator loaded an icon pack (state.art.iconPack), else the HUD's own.
  if (REPLAY_LAYER)
    return (
      <IconPackProvider pack={state.art.iconPack}>
        <ReplayLayer state={state} scale={scale} />
      </IconPackProvider>
    );
  const settings = readSettings(state.settings);
  const compact = (state.variant || VARIANT) === "compact";
  const phase = state.match.phase;
  const board = scoreboardPhase(phase);
  const observedColor = state.observed ? colorOf(state.right.players.some((p) => p.steamId === state.observed!.steamId) ? state.right : state.left, settings) : settings.ctColor;
  const ct = sideColor(state, settings, "CT");
  const t = sideColor(state, settings, "T");
  // Killfeed names in light tints of their sides' colours.
  const vars = {
    transform: `scale(${scale})`,
    "--st-ct": settings.ctColor,
    "--st-t": settings.tColor,
    "--radar-ct": ct,
    "--radar-t": t,
    "--st-name-ct": mix(ct, "#ffffff", 0.55),
    "--st-name-t": mix(t, "#ffffff", 0.6),
  } as CSSProperties;
  return (
    <IconPackProvider pack={state.art.iconPack}>
      <div className={`st-stage panel-${settings.panelColor} ${board ? "is-board" : "is-live"} ${compact ? "is-compact" : ""} ${state.stale ? "is-stale" : ""}`} style={vars} data-phase={phase}>
        {compact ? null : <TopLeft state={state} settings={settings} />}
        <ScoreBar state={state} receivedAt={receivedAt} settings={settings} compact={compact} boardOn={board && settings.showScoreboard && !compact} />
        <TopRight state={state} settings={settings} compact={compact} />
        {compact ? null : (
          <>
            <TeamCards state={state} team={state.left} color={colorOf(state.left, settings)} align="left" settings={settings} shown={!board || !settings.showScoreboard} />
            <TeamCards state={state} team={state.right} color={colorOf(state.right, settings)} align="right" settings={settings} shown={!board || !settings.showScoreboard} />
            {settings.showScoreboard ? <Scoreboard state={state} receivedAt={receivedAt} settings={settings} shown={board} /> : null}
          </>
        )}
        {settings.showObserved ? <Observed state={state} color={observedColor} shown={!board || compact} /> : null}
        {/* Honest labels: the test simulation, data that has stopped arriving, a replay on air. */}
        {state.simulated || state.stale || state.replay.active ? (
          <div className="st-labels">
            {state.replay.active ? <span className="st-label is-replay">{state.replay.label || "REPLAY"}</span> : null}
            {state.simulated ? <span className="st-label is-sim">SIMULATION</span> : null}
            {state.stale ? <span className="st-label is-stale">DATA PAUSED</span> : null}
          </div>
        ) : null}
      </div>
    </IconPackProvider>
  );
}
