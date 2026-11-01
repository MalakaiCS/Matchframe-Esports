import { Async, Note } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { ListenInButtons, PublicStateBanner } from "./comms/PublicControls.tsx";
import { PreviewPanel } from "./comms/PreviewPanel.tsx";
import { BridgePanel, DuckingPanel, ObsCheckPanel, OutputsPanel, OverlayPanel, TimingPanel } from "./comms/SetupPanels.tsx";
import { TeamPanel } from "./comms/TeamPanel.tsx";
import type { CommsView } from "./comms/types.ts";
import "../styles/team-comms.css";

/**
 * Team Comms (ADR-065, ADR-066): both teams' TeamSpeak, each person, delayed. The public listen-in's
 * state and its four actions on top; each team's connection, buffer and people (Include in Broadcast,
 * Include in Recording, level, live and delayed meters, Solo); the preview in the operator's
 * headphones; the delay; the outputs to OBS, caster ducking, the team-only graphic; the plugin and
 * bridge setup. The dedicated recording's controls are phase 4.
 */
export function TeamCommsScreen() {
  const st = useApi<CommsView>("/api/v1/comms", { refreshMs: 300 });
  const reload = () => void st.reload();
  return (
    <div className="stack comms-page">
      <Async state={st}>
        {(v) => (
          <>
            <section className="panel comms-onair" aria-label="Public listen-in">
              <div className="panel-body">
                <PublicStateBanner view={v.onAir.listenIn} />
                <ListenInButtons view={v.onAir.listenIn} size="lg" onDone={reload} />
                {!v.enabled ? <Note tone="info">Team Comms is off: switch it on under Bridge and TeamSpeak plugin.</Note> : null}
                <p className="muted small">Listen In opens only a team whose buffer holds the delay, and closes the other team first (never both). Mute All Comms silences the public route at once; the recording carries on. Comms come back on air only with a new Listen In: never after a restart, a reset or a lost connection.</p>
              </div>
            </section>
            <div className="grid-2 comms-teams">
              {v.slots.map((s) => (
                <TeamPanel key={s.id} slot={s} people={v.participants.filter((p) => p.slot === s.id)} delayMs={v.delay.effectiveMs} onChanged={reload} />
              ))}
            </div>
            <div className="grid-2">
              <PreviewPanel people={v.participants} />
              <TimingPanel view={v} onChanged={reload} />
            </div>
            <div className="grid-2">
              <OutputsPanel view={v} onChanged={reload} />
              <OverlayPanel view={v} onChanged={reload} />
            </div>
            <div className="grid-2">
              <DuckingPanel view={v} onChanged={reload} />
              <ObsCheckPanel />
            </div>
            <BridgePanel view={v} onChanged={reload} />
          </>
        )}
      </Async>
    </div>
  );
}
