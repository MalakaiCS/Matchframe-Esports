import { useEffect } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import Layout from "./hud/Layout.tsx";
import { useHud, useNow } from "./useHud.ts";
import { setting } from "./util.ts";

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Colours and panel opacity from the HUD's settings in the HUD Library, applied as CSS variables. */
function useAppearance(state: HudState | null) {
  const ct = state ? setting(state, "ctColor", "#5ab8f4") : "#5ab8f4";
  const t = state ? setting(state, "tColor", "#f0c941") : "#f0c941";
  const opacity = state ? setting(state, "panelOpacity", 0.83) : 0.83;
  useEffect(() => {
    const root = document.documentElement.style;
    if (HEX.test(ct)) root.setProperty("--color-new-ct", ct);
    if (HEX.test(t)) root.setProperty("--color-new-t", t);
    const a = Math.min(1, Math.max(0.3, Number(opacity) || 0.83));
    root.setProperty("--sub-panel-color", `rgba(0, 0, 0, ${a})`);
    root.setProperty("--main-panel-color", `rgba(12, 15, 18, ${Math.min(1, a + 0.02)})`);
  }, [ct, t, opacity]);
}

export default function App() {
  const { state, receivedAt } = useHud();
  const now = useNow(100);
  useAppearance(state);
  // Nothing until the first state arrives: the page stays fully transparent.
  if (!state) return null;
  return (
    <>
      <Layout state={state} receivedAt={receivedAt} now={now} />
      {/* Honest labels: the test simulation, and game data that has stopped arriving. */}
      {state.simulated || state.stale ? (
        <div className="mf-labels">
          {state.simulated ? <div className="mf-simulation">SIMULATION</div> : null}
          {state.stale ? <div className="mf-stale">DATA PAUSED</div> : null}
        </div>
      ) : null}
    </>
  );
}
