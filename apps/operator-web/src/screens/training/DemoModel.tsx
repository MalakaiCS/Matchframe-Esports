import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Details, Note, Panel } from "../../components/ui.tsx";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

interface BenchTotals {
  kills_shown: number;
  kills: number;
  multi_frag_kills_shown: number;
  multi_frag_kills: number;
  opening_kills_shown: number;
  opening_kills: number;
}

export interface PovModelStatus {
  setting: { enabled: boolean; modelId: string; weight: number; ref: number };
  active: { modelId: string; builtin: boolean; notes: string | null; maps: string[]; sha256: string; bench: { without_model?: BenchTotals; with_model_and_multi_frag?: BenchTotals } | null } | null;
  error: string | null;
  available: { modelId: string; createdAt: string | null; notes: string | null }[];
}

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
const mapName = (m: string) => m.replace(/^de_/, "").replace(/^./, (c) => c.toUpperCase());

/** "What the demos teach": the demo-trained POV model the Auto Director uses to pick whose POV to show. */
export function DemoModelPanel() {
  const reason = usePermission("models.promote");
  const st = useApi<PovModelStatus>("/api/v1/models/pov", { refreshMs: 10000 });
  const set = (body: { enabled?: boolean; modelId?: string }) => api.put<PovModelStatus>("/api/v1/models/pov", body);
  return (
    <Panel title="What the demos teach" subtitle="A model trained on demos tells the Auto Director whose POV is about to show a kill.">
      <Async state={st}>
        {(s) => {
          const b = s.active?.bench;
          return (
            <>
              <div className="row">
                {s.active ? <Badge tone="ok">On</Badge> : s.setting.enabled ? <Badge tone="warn">Not loaded</Badge> : <Badge tone="neutral">Off</Badge>}
                <b>{s.setting.modelId === "builtin" ? "Built-in model" : s.setting.modelId}</b>
                {s.active && s.active.maps.length ? <span className="small muted">trained on {s.active.maps.map(mapName).join(", ")}</span> : null}
              </div>
              {s.error && s.setting.enabled ? <Note tone="warn">{s.error}. The Auto Director runs without it.</Note> : null}
              {s.active?.notes ? <p className="small muted">{s.active.notes}</p> : null}
              {b?.without_model && b.with_model_and_multi_frag ? (
                <p className="small">
                  Test bench, each match replayed with a model that never saw it: kills shown {pct(b.without_model.kills_shown, b.without_model.kills)} → <b>{pct(b.with_model_and_multi_frag.kills_shown, b.with_model_and_multi_frag.kills)}</b>, multi-frags on the killer&apos;s POV {pct(b.without_model.multi_frag_kills_shown, b.without_model.multi_frag_kills)} → <b>{pct(b.with_model_and_multi_frag.multi_frag_kills_shown, b.with_model_and_multi_frag.multi_frag_kills)}</b> (with multi-frag awareness), opening kills {b.without_model.opening_kills_shown} → <b>{b.with_model_and_multi_frag.opening_kills_shown}</b> of {b.without_model.opening_kills}.
                </p>
              ) : null}
              <div className="form-actions">
                <ActionButton variant={s.setting.enabled ? "secondary" : "primary"} action={() => set({ enabled: !s.setting.enabled })} success={(r) => (r.setting.enabled ? (r.active ? "The Auto Director uses the demo-trained model" : "Turned on, but the model could not be loaded") : "The Auto Director runs without the demo-trained model")} onDone={() => void st.reload()} disabledReason={reason}>
                  {s.setting.enabled ? "Turn off" : "Turn on"}
                </ActionButton>
                {s.setting.modelId !== "builtin" ? (
                  <ActionButton size="sm" variant="ghost" action={() => set({ modelId: "builtin" })} success="Back to the built-in model" onDone={() => void st.reload()} disabledReason={reason}>
                    Use the built-in model
                  </ActionButton>
                ) : null}
              </div>
              {s.available.length ? (
                <Details summary={`Your trained POV models (${s.available.length})`}>
                  <ul className="small">
                    {s.available.map((m) => (
                      <li key={m.modelId}>
                        <span className="mono">{m.modelId}</span> <span className="muted">{fmtTime(m.createdAt)}</span>{" "}
                        {s.setting.modelId === m.modelId ? (
                          <Badge tone="ok">In use</Badge>
                        ) : (
                          <ActionButton size="sm" variant="ghost" action={() => set({ modelId: m.modelId, enabled: true })} success={(r) => (r.active ? `${m.modelId} now helps the Auto Director` : `Not loaded: ${r.error ?? "unknown reason"}`)} onDone={() => void st.reload()} disabledReason={reason}>
                            Use this one
                          </ActionButton>
                        )}
                        {m.notes ? <div className="muted">{m.notes}</div> : null}
                      </li>
                    ))}
                  </ul>
                  <p className="small muted">Run the test bench after switching: it replays your demos with the model in use and shows the difference.</p>
                </Details>
              ) : null}
              <Details summary="How it works">
                <p className="small muted">
                  For every living player, the model estimates the chance their POV shows a kill in the next 2 seconds, from what the game data shows: distances and view angles to the enemies, health, weapon, kills this round. Half of the director&apos;s &quot;a fight is coming&quot; score comes from it, half from the built-in rules. Train your own with the task &quot;POV shows a kill within 2 s&quot; below; it replaces the built-in model only when you choose it.
                </p>
              </Details>
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
