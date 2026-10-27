import type { HudState } from "@matchframe/hud-sdk";
import { VARIANT } from "../useHud.ts";
import { isFreezetime, setting } from "../util.ts";
import { MapSeries, Pause, Timeout } from "./Banners.tsx";
import Killfeed from "./Killfeed.tsx";
import MatchBar, { SeriesBox } from "./MatchBar.tsx";
import Observed from "./Observed.tsx";
import { PlayersAlive, TeamBox } from "./Players.tsx";
import Radar from "./Radar.tsx";
import SideBoxes from "./SideBoxes.tsx";

/**
 * The HUD at its design size (1920×1080). Elements can be switched off in the HUD Library
 * (Appearance); the compact variant leaves out the radar, side boxes and map series.
 */
export default function Layout({ state, receivedAt, now }: { state: HudState; receivedAt: number; now: number }) {
  const compact = VARIANT === "compact";
  const freeze = isFreezetime(state);
  const on = (key: string) => setting(state, key, true);
  return (
    <div className="layout">
      {on("showPlayersAlive") ? <PlayersAlive state={state} /> : null}
      {on("showKillfeed") ? <Killfeed state={state} /> : null}
      {!compact && on("showRadar") ? <Radar state={state} size={setting(state, "radarSize", 340)} /> : null}
      <MatchBar state={state} receivedAt={receivedAt} now={now} />
      <Pause state={state} />
      <Timeout state={state} receivedAt={receivedAt} now={now} />
      <SeriesBox state={state} />
      {on("showObserved") ? <Observed state={state} /> : null}
      {on("showPlayers") ? (
        <>
          <TeamBox state={state} team={state.left} orientation="left" />
          <TeamBox state={state} team={state.right} orientation="right" />
        </>
      ) : null}
      {!compact ? <MapSeries state={state} show={freeze} /> : null}
      {!compact && on("showSideBoxes") ? <SideBoxes state={state} show={freeze} /> : null}
    </div>
  );
}
