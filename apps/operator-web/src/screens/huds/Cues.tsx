import { useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudCue, HudOutputEntry } from "../../api/types.ts";
import { ActionButton, Async, EmptyState, Field, Panel } from "../../components/ui.tsx";
import { fmtMs } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { useNow } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";

export function CuesTab() {
  const cues = useApi<HudCue[]>("/api/v1/hud/cues", { refreshMs: 2000 });
  const outputs = useApi<HudOutputEntry[]>("/api/v1/hud/outputs");
  const reason = usePermission("hud.publish");
  const now = useNow(1000);
  const [kind, setKind] = useState("lower_third");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [duration, setDuration] = useState("8");
  const [target, setTarget] = useState<string[]>([]);
  return (
    <div className="grid-2">
      <Panel title="Show a cue" subtitle="Lower thirds, caster cards and other short graphics">
        <div className="form-grid">
          <Field label="Kind">
            <input list="cue-kinds" value={kind} onChange={(e) => setKind(e.target.value)} />
            <datalist id="cue-kinds">
              {["lower_third", "caster_card", "announcement", "sponsor_show", "stat_card"].map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </Field>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Subtitle">
            <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          </Field>
          <Field label="Duration (s)" hint="Empty = until cleared">
            <input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
        </div>
        <fieldset style={{ marginTop: 10 }}>
          <legend>
            Outputs <span className="muted small">(none selected = all)</span>
          </legend>
          <div className="row">
            {(outputs.data ?? []).map((o) => (
              <label key={o.draft.outputId} className="check">
                <input type="checkbox" checked={target.includes(o.draft.outputId)} onChange={(e) => setTarget(e.target.checked ? [...target, o.draft.outputId] : target.filter((x) => x !== o.draft.outputId))} />
                {o.draft.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-actions">
          <ActionButton
            variant="primary"
            action={() => api.post<HudCue>("/api/v1/hud/cues", { kind, title, subtitle: subtitle || null, durationMs: duration ? Number(duration) * 1000 : null, outputs: target.length ? target : null })}
            success={(c) => `Cue “${c.title}” on air`}
            onDone={() => void cues.reload()}
            disabledReason={reason ?? (title.trim() && kind.trim() ? null : "Enter a kind and a title")}
          >
            Show cue
          </ActionButton>
        </div>
      </Panel>
      <Panel title="Active cues" className="gb-start">
        <Async state={cues}>
          {(list) => {
            const active = list.filter((c) => c.untilMs === null || c.untilMs > now);
            return active.length === 0 ? (
              <EmptyState title="No active cues">Cues from here, automation rules and rundown takes stay listed until they expire or are cleared.</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Cue</th>
                    <th>Kind</th>
                    <th>Outputs</th>
                    <th>Remaining</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {active.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.title}</strong>
                        {c.subtitle ? <div className="small muted">{c.subtitle}</div> : null}
                      </td>
                      <td>{c.kind}</td>
                      <td>{c.outputs?.join(", ") ?? "all"}</td>
                      <td>{c.untilMs === null ? "until cleared" : fmtMs(c.untilMs - now)}</td>
                      <td>
                        <ActionButton size="sm" action={() => api.del(`/api/v1/hud/cues/${seg(c.id)}`)} success="Cue cleared" onDone={() => void cues.reload()} disabledReason={reason}>
                          Clear
                        </ActionButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }}
        </Async>
      </Panel>
    </div>
  );
}
