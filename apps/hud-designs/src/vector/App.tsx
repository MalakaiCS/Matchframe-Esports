import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { HudSide, HudState } from "@matchframe/hud-sdk";
import { aliveCount, isLive, teamColor } from "../shared/format.ts";
import { MapRadar } from "../shared/radar.tsx";
import { useHud, VARIANT } from "../shared/useHud.ts";
import { isReplayLayer } from "../../../hud-renderer/src/components/replay.ts";
import { readOptions } from "./bits.tsx";
import { AliveBox, Killfeed } from "./Killfeed.tsx";
import { Observed } from "./Observed.tsx";
import { TeamColumn } from "./Players.tsx";
import { ReplayLayer } from "./Replay.tsx";
import { ScoreBar } from "./ScoreBar.tsx";

const FALLBACK = { ct: "#109be3", t: "#d05354" };
/** The `replay` entry point: the replay graphic only (for the replay scene). */
const REPLAY_LAYER = isReplayLayer();

/** The 1920×1080 stage scales to the browser source's size. */
function useFitStage() {
  useEffect(() => {
    const fit = () => document.documentElement.style.setProperty("--vx-scale", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
}

function Hud({ state, receivedAt }: { state: HudState; receivedAt: number }) {
  const s = state.settings;
  const opts = readOptions(s, VARIANT);
  const color = { left: teamColor(state.left, s, FALLBACK), right: teamColor(state.right, s, FALLBACK) };
  // Kill-feed names and radar markers are coloured by side: the colour of the team playing it.
  const bySide = (side: HudSide) => (state.left.side === side ? color.left : state.right.side === side ? color.right : teamColor({ ...state.left, color: null, side }, s, FALLBACK));
  const phase = state.match.phase;
  const extras = opts.showFreezeExtras && (phase === "freezetime" || phase === "timeout_ct" || phase === "timeout_t");
  // "Team names: short" shows each team's tag in the score bar and the winner card.
  const named = opts.shortNames ? { ...state, left: { ...state.left, name: state.left.shortName || state.left.name }, right: { ...state.right, name: state.right.shortName || state.right.name } } : state;
  const style = { "--vx-left": color.left, "--vx-right": color.right, "--vx-ct": bySide("CT"), "--vx-t": bySide("T"), "--radar-ct": bySide("CT"), "--radar-t": bySide("T") } as CSSProperties;
  return (
    <div className={`vx-stage phase-${phase}`} style={style}>
      {opts.showRadar ? <MapRadar radar={state.radar} className="vx-radar" /> : null}
      <ScoreBar state={named} receivedAt={receivedAt} extras={extras} color={color} />
      <TeamColumn state={state} team={state.left} align="left" showMoney={opts.showMoney} extras={extras} />
      <TeamColumn state={state} team={state.right} align="right" showMoney={opts.showMoney} extras={extras} />
      {opts.showAlive ? <AliveBox left={aliveCount(state.left)} right={aliveCount(state.right)} on={isLive(phase)} /> : null}
      {opts.showKillfeed ? <Killfeed entries={state.killfeed.entries} top={!opts.showAlive} /> : null}
      {opts.showObserved ? <Observed state={state} color={color} /> : null}
      {state.simulated || state.stale ? (
        <div className={`vx-flags ${opts.showRadar && state.radar.available ? "" : "is-top"}`}>
          {state.simulated ? <span className="vx-flag is-sim">SIMULATION</span> : null}
          {state.stale ? <span className="vx-flag">DATA PAUSED</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const { state, receivedAt } = useHud();
  useFitStage();
  // Nothing until the first state arrives: the page stays transparent.
  if (!state) return null;
  return REPLAY_LAYER ? <ReplayLayer state={state} /> : <Hud state={state} receivedAt={receivedAt} />;
}
