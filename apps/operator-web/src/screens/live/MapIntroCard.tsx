import { api, describeError } from "../../api/index.ts";
import type { MapIntroStatus, MapIntrosResponse } from "../../api/types.ts";
import { ActionButton, Badge, Button, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { shortcutLabel } from "../../lib/replay-keys.ts";
import { Link } from "../../router.tsx";
import { usePermission } from "../../state/session.tsx";
import { introLength, MAP_INTROS_PATH } from "../replays/MapIntros.tsx";

/**
 * Map intros in Live Control: the status line ("Next intro: Mirage, at pistol round start"), Play
 * map intro (the map in the game data) and Play next map's intro (the active match's next map,
 * before the server changes to it), and Stop while one is on air.
 */
export function MapIntroCard() {
  const intros = useApi<MapIntrosResponse>(MAP_INTROS_PATH, { refreshMs: 1000 });
  const reason = usePermission("replay.control");
  const toast = useToast();
  const status = intros.data?.status ?? null;
  const done = (r: { status: MapIntroStatus }) => intros.setData(intros.data ? { ...intros.data, status: r.status } : intros.data);
  const cur = status?.current ?? null;
  const next = status?.nextMap ?? null;
  const stop = async () => {
    try {
      done(await api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/stop`));
    } catch (e) {
      toast.push("warn", "Map intro", describeError(e));
    }
  };
  return (
    <Panel title="Map intro" subtitle={status?.detail} actions={status?.running ? <Badge tone="accent">On air</Badge> : null}>
      <div className="stack-sm" aria-label="Map intro controls">
        {status?.running ? (
          <div className="row">
            <Button variant="danger" disabledReason={reason} title="Back to the scene the program came from" onClick={() => void stop()}>
              Stop
            </Button>
            {status.playing ? <span className="small">{`${status.playing.displayName}${status.playing.isDefault ? " (default intro)" : ""} · ${introLength(status.playing.durationMs)}`}</span> : null}
          </div>
        ) : (
          <div className="row">
            <ActionButton
              variant="primary"
              action={() => api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/play`)}
              success={(r) => (r.status.running ? `${r.status.playing?.displayName ?? "Map"} intro on air` : null)}
              onDone={done}
              disabledReason={reason ?? (!status ? "Loading…" : status.blocked)}
              title={`Plays ${cur ? `${cur.displayName}'s` : "the current map's"} intro on the program now, then goes back to the scene it came from (${shortcutLabel("F4")})`}
            >
              Play map intro
            </ActionButton>
            <ActionButton
              action={() => api.post<{ status: MapIntroStatus }>(`${MAP_INTROS_PATH}/play-next`)}
              success={(r) => (r.status.running ? `${r.status.playing?.displayName ?? "Next map"} intro on air` : null)}
              onDone={done}
              disabledReason={reason ?? (!status ? "Loading…" : status.blockedNext)}
              title={next ? `Plays ${next.displayName}'s intro now (the next map in the active match's veto), before the server changes map` : "The next map in the active match's veto"}
            >
              {next ? `Play next map's intro (${next.displayName})` : "Play next map's intro"}
            </ActionButton>
          </div>
        )}
        {status && !status.running && status.next !== status.detail ? <span className="small muted">{status.next}</span> : null}
        {status?.auto && !status.auto.started ? <span className="small text-warn">{status.auto.detail}</span> : null}
        <span className="small muted">
          Videos and when they start: <Link to="/replays">Replays &amp; Production → Map intros</Link>.
        </span>
      </div>
    </Panel>
  );
}
