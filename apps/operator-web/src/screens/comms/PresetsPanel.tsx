import { useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { PresetsView } from "./types.ts";

/**
 * Event presets (ADR-069): the people (mappings, Include in Broadcast and in Recording, levels), each
 * team's TeamSpeak server and channel, the delay, the recording team and levels, the speaker strip
 * and the on-air settings, saved by name with the event. Never a password, the Solo or the public
 * listen-in: loading one never opens it.
 */
export function PresetsPanel({ onChanged }: { onChanged: () => void }) {
  const st = useApi<PresetsView>("/api/v1/comms/presets", { refreshMs: 2000 });
  const reason = usePermission("program.control");
  const toast = useToast();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const v = st.data;
  const done = (r?: PresetsView) => {
    void st.reload();
    onChanged();
    if (r?.loaded?.skipped.length) toast.push("warn", `Loaded “${r.loaded.name}”, except`, r.loaded.skipped.join("; "));
  };
  const saveAs = async () => {
    try {
      await api.post<PresetsView>("/api/v1/comms/presets", { name: name.trim() });
      toast.push("ok", `Saved “${name.trim()}”`);
      setName("");
      done();
    } catch (e) {
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const rename = async () => {
    if (!renaming) return;
    try {
      await api.put<PresetsView>(`/api/v1/comms/presets/${seg(renaming.id)}`, { name: renaming.name.trim() });
      setRenaming(null);
      done();
    } catch (e) {
      toast.push("danger", "Not renamed", describeError(e));
    }
  };
  if (!v) return <Panel title="Event presets">{st.error ? <Note tone="warn">Presets aren't available: {st.error}</Note> : <p className="muted small">Loading…</p>}</Panel>;
  const active = v.active;
  return (
    <Panel
      title="Event presets"
      subtitle={`People and their choices, each team's TeamSpeak channel, the delay, the recording team and levels, the strip and the on-air settings, by name${v.currentEventName ? ` (this match: ${v.currentEventName})` : ""}.`}
      actions={active ? <Badge tone={active.changed ? "warn" : "ok"} icon={active.changed ? "✎" : "✓"}>{active.changed ? `${active.name}: changed` : active.name}</Badge> : <Badge tone="neutral">No preset loaded</Badge>}
    >
      <div className="stack-sm">
        <p className="small" role="status" aria-live="polite">
          {active ? (active.changed ? `Active preset: ${active.name}. Changed since: ${active.differs.join(", ")}.` : `Active preset: ${active.name} (as saved).`) : "No active preset: the current setup isn't saved as one."}
        </p>
        <div className="row-end">
          <Field label="Save as">
            <input aria-label="New preset name" value={name} maxLength={80} placeholder="e.g. Spring Cup — playoffs" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" disabledReason={reason ?? (name.trim() ? null : "Name it first")} onClick={() => void saveAs()}>
            Save as
          </Button>
          {active ? (
            <ActionButton disabledReason={reason ?? (active.changed ? null : "No change since it was saved")} action={() => api.post<PresetsView>(`/api/v1/comms/presets/${seg(active.id)}/save`)} onDone={() => done()} success={`Saved “${active.name}”`}>
              {`Save “${active.name}”`}
            </ActionButton>
          ) : null}
        </div>
        {v.presets.length === 0 ? (
          <p className="muted small">No presets yet.</p>
        ) : (
          <table className="table comms-presets">
            <thead>
              <tr>
                <th>Preset</th>
                <th>Event</th>
                <th>People</th>
                <th>Delay</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {v.presets.map((p) => (
                <tr key={p.id} className={p.active ? "is-active" : ""}>
                  <td>
                    {renaming?.id === p.id ? (
                      <span className="row">
                        <input aria-label={`Rename ${p.name}`} value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                        <Button size="sm" disabledReason={renaming.name.trim() ? null : "Name it"} onClick={() => void rename()}>
                          Rename
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <>
                        <strong>{p.name}</strong> {p.active ? <Badge tone="info">{active?.changed ? "Active (changed)" : "Active"}</Badge> : null}
                        <div className="muted small">{p.teams.map((t) => t.name ?? "a team no longer in Matchframe").join(" vs ")}</div>
                      </>
                    )}
                  </td>
                  <td className="small">{p.eventName ?? (p.eventId ? "an event no longer in Matchframe" : "Any event")}</td>
                  <td className="small">{`${p.people} (${p.included.broadcast} broadcast, ${p.included.recording} recording)`}</td>
                  <td className="small">{fmtDelay(p.delayMs)}</td>
                  <td>
                    <span className="row">
                      <ActionButton
                        size="sm"
                        variant={p.active ? "secondary" : "primary"}
                        disabledReason={reason}
                        action={() => api.post<PresetsView>(`/api/v1/comms/presets/${seg(p.id)}/load`)}
                        onDone={(r) => done(r)}
                        success={`Loaded “${p.name}”`}
                        confirm={active?.changed ? { title: `Load “${p.name}”?`, body: `The current setup has changes not saved in “${active.name}” (${active.differs.join(", ")}). Loading replaces them. The public listen-in is left as it is.`, confirmLabel: "Load" } : undefined}
                      >
                        Load
                      </ActionButton>
                      <Button size="sm" variant="ghost" disabledReason={reason} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                        Rename
                      </Button>
                      <ActionButton size="sm" variant="ghost" disabledReason={reason} action={() => api.del<PresetsView>(`/api/v1/comms/presets/${seg(p.id)}`)} onDone={() => done()} success={`Deleted “${p.name}”`} confirm={{ title: `Delete “${p.name}”?`, body: "The preset is gone; the current setup is not changed.", confirmLabel: "Delete" }}>
                        Delete
                      </ActionButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Loading a preset never puts comms on air (and never takes them off): passwords stay in Matchframe's secure settings, and your headphone Solo is your own.</p>
      </div>
    </Panel>
  );
}
