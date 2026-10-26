import { useCallback, useEffect, useState } from "react";
import type { HudState } from "@matchframe/hud-sdk";
import { Killfeed } from "./components/Killfeed.tsx";
import { ObservedPanel, TeamPanel } from "./components/Players.tsx";
import { Radar } from "./components/Radar.tsx";
import { Annotations, Badges, Cues, SponsorZone } from "./components/Overlays.tsx";
import { RoundHistory, Scoreboard, SeriesStrip } from "./components/Scoreboard.tsx";
import { BracketBoard, BreakScreen, PostMap, PostSeries, PreMatch, ReplayFrame, StandingsBoard, VetoBoard } from "./components/Screens.tsx";
import { readParams } from "./params.ts";
import { useHud, useTicker } from "./useHud.ts";

const PRESETS = new Set(["classic", "minimal", "arena"]);

/** Fixed 1920×1080 design stage scaled to the browser-source size (resolution independent). */
function useStageScale(): number {
  const [scale, setScale] = useState(() => window.innerWidth / 1920);
  useEffect(() => {
    const on = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return scale;
}

/** Composer position offsets (`settings.layout[id] = {dx, dy}`, design-stage pixels), clamped to the stage. */
function layoutOffset(settings: Record<string, unknown>, id: string): React.CSSProperties | undefined {
  const o = (settings.layout as Record<string, { dx?: unknown; dy?: unknown }> | undefined)?.[id];
  const dx = typeof o?.dx === "number" && Number.isFinite(o.dx) ? Math.max(-1920, Math.min(1920, o.dx)) : 0;
  const dy = typeof o?.dy === "number" && Number.isFinite(o.dy) ? Math.max(-1080, Math.min(1080, o.dy)) : 0;
  return dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : undefined;
}

/** Full-stage layer so absolutely positioned widgets keep their place and move together. */
function Placed({ id, settings, children }: { id: string; settings: Record<string, unknown>; children: React.ReactNode }) {
  return (
    <div className="mf-place" data-layout-id={id} style={layoutOffset(settings, id)}>
      {children}
    </div>
  );
}

function LiveHud({ state, receivedAt, now, onSponsorShown }: { state: HudState; receivedAt: number; now: number; onSponsorShown: (id: string, zone: string) => void }) {
  const hidden = (k: string) => (state.settings[`hide.${k}`] as boolean | undefined) === true;
  const observedTeam = state.observed ? (state.left.players.some((p) => p.steamId === state.observed!.steamId) ? state.left : state.right) : null;
  const showHistory = state.match.phase === "freezetime" || state.match.phase === "over" || state.match.phase === "halftime";
  const s = state.settings;
  return (
    <>
      {!hidden("scoreboard") && (
        <Placed id="scoreboard" settings={s}>
          <div className="mf-top">
            <Scoreboard state={state} receivedAt={receivedAt} now={now} />
            <SeriesStrip state={state} />
            {showHistory && !hidden("history") ? (
              <div style={layoutOffset(s, "history")}>
                <RoundHistory state={state} />
              </div>
            ) : null}
            <SponsorZone zone="top_bar" state={state} onShown={onSponsorShown} />
          </div>
        </Placed>
      )}
      {!hidden("radar") && (
        <Placed id="radar" settings={s}>
          <Radar radar={state.radar} />
        </Placed>
      )}
      {!hidden("killfeed") && (
        <Placed id="killfeed" settings={s}>
          <Killfeed state={state} />
        </Placed>
      )}
      {!hidden("players") && (
        <>
          <Placed id="players-left" settings={s}>
            <TeamPanel team={state.left} align="left" />
          </Placed>
          <Placed id="players-right" settings={s}>
            <TeamPanel team={state.right} align="right" />
          </Placed>
        </>
      )}
      {!hidden("observed") && (
        <Placed id="observed" settings={s}>
          <ObservedPanel p={state.observed} team={observedTeam} />
        </Placed>
      )}
      <SponsorZone zone="bottom_right" state={state} onShown={onSponsorShown} />
      <SponsorZone zone="bottom_left" state={state} onShown={onSponsorShown} />
      <Cues state={state} />
    </>
  );
}

export function App() {
  const params = readParams();
  const feed = useHud(params.wsUrl);
  const now = useTicker(200);
  const scale = useStageScale();
  const state = feed.state;
  const preset = state?.presetId && PRESETS.has(state.presetId) ? state.presetId : "classic";
  const variant = state?.variant ?? params.variant;
  const reducedMotion = state?.settings.reducedMotion === true;

  const ack = feed.ackSponsor;
  const onSponsorShown = useCallback((sponsorId: string, zone: string) => ack(sponsorId, zone), [ack]);

  let body: React.ReactNode = null;
  if (state) {
    if (state.replay.active || variant === "replay") body = <ReplayFrame />;
    else if (variant === "pre-match") body = <PreMatch state={state} />;
    else if (variant === "break")
      body = (
        <>
          <BreakScreen state={state} />
          <SponsorZone zone="break_fullscreen" state={state} onShown={onSponsorShown} />
        </>
      );
    else if (variant === "post-map") body = <PostMap state={state} />;
    else if (variant === "post-series") body = <PostSeries state={state} />;
    else if (variant === "veto") body = <VetoBoard state={state} />;
    else if (variant === "studio" && state.settings.studioPanel === "standings" && state.standings) body = <StandingsBoard state={state} />;
    else if (variant === "studio" && state.settings.studioPanel === "bracket" && state.bracket) body = <BracketBoard state={state} />;
    else if (variant === "studio") body = <Cues state={state} />;
    else if (variant === "compact")
      body = (
        <>
          <div className="mf-top">
            <Scoreboard state={state} receivedAt={feed.receivedAt} now={now} />
          </div>
          <ObservedPanel p={state.observed} team={null} />
        </>
      );
    else body = <LiveHud state={state} receivedAt={feed.receivedAt} now={now} onSponsorShown={onSponsorShown} />;
  }

  return (
    <div className={`mf-viewport ${reducedMotion ? "mf-reduced-motion" : ""} ${params.preview ? "is-preview" : ""}`}>
      <div className={`mf-stage mf-preset-${preset} mf-variant-${variant} ${state?.stale ? "is-stale" : ""}`} style={{ transform: `scale(${scale})` }} data-preset={preset}>
        {body}
        {state ? <Annotations state={state} /> : null}
        <Badges state={state} connected={feed.status === "open"} />
      </div>
    </div>
  );
}
