import { Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { ListenInButtons, PublicStateBanner } from "../comms/PublicControls.tsx";
import { RecordingButtons, RecordingStateBanner } from "../comms/RecordingPanel.tsx";
import type { CommsView } from "../comms/types.ts";
import "../../styles/team-comms.css";

/** Live Control's compact Team Comms controls: the public state in words and the four actions; the dedicated recording's state and its own Start/Stop. */
export function TeamCommsCard() {
  const st = useApi<CommsView>("/api/v1/comms", { refreshMs: 1000 });
  const v = st.data;
  if (v && !v.enabled) return null;
  return (
    <Panel
      title="Team Comms"
      className="comms-card"
      actions={
        <Link to="/live/comms" className="small">
          Open Team Comms
        </Link>
      }
    >
      <div className="stack-sm">
        <PublicStateBanner view={v?.onAir.listenIn ?? null} compact />
        <ListenInButtons view={v?.onAir.listenIn ?? null} size="sm" onDone={() => void st.reload()} />
        <RecordingStateBanner rec={v?.recorder ?? null} compact />
        <RecordingButtons rec={v?.recorder ?? null} size="sm" onDone={() => void st.reload()} />
        {v ? (
          <p className="muted small">
            {v.slots.map((s) => `${s.team?.name ?? `Team ${s.id}`}: ${s.ready ? "ready" : s.state}`).join(" · ")} · delay {(v.delay.effectiveMs / 1000).toFixed(3)} s
          </p>
        ) : st.error ? (
          <p className="small">{st.error}</p>
        ) : null}
      </div>
    </Panel>
  );
}
