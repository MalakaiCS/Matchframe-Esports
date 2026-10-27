import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord } from "../api/types.ts";
import { AssetUpload, assetUrl, MapPoolEditor } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Button, EmptyState, Field, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { useMapSuggestions } from "../lib/maps.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-a.css";

type Draft = Omit<EventRecord, "id"> & { id?: string };

const EMPTY: Draft = { name: "", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", startsOn: null, endsOn: null, brandPrimary: "#2f7cf6", brandSecondary: "#ffffff", logoAssetId: null, mapPool: [] };

function EventForm({ initial, onSaved, onCancel }: { initial: Draft; onSaved: () => void; onCancel?: () => void }) {
  const reason = usePermission("metadata.write");
  const [d, setD] = useState<Draft>(initial);
  const suggestions = useMapSuggestions();
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const isEdit = !!initial.id;
  return (
    <>
      <div className="form-grid">
        <Field label="Event name">
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Time zone">
          <input value={d.timeZone} onChange={(e) => set({ timeZone: e.target.value })} placeholder="e.g. Europe/Berlin" title="IANA time zone name, e.g. Europe/Berlin" />
        </Field>
        <Field label="Starts">
          <input type="date" value={d.startsOn ?? ""} onChange={(e) => set({ startsOn: e.target.value || null })} />
        </Field>
        <Field label="Ends">
          <input type="date" value={d.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} />
        </Field>
        <Field label="Primary colour">
          <input type="color" value={d.brandPrimary} onChange={(e) => set({ brandPrimary: e.target.value })} />
        </Field>
        <Field label="Secondary colour">
          <input type="color" value={d.brandSecondary} onChange={(e) => set({ brandSecondary: e.target.value })} />
        </Field>
        <AssetUpload label="Event logo" value={d.logoAssetId} onChange={(id) => set({ logoAssetId: id })} disabledReason={reason} />
      </div>
      <MapPoolEditor value={d.mapPool} onChange={(m) => set({ mapPool: m })} suggestions={suggestions} />
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => {
            const { id, ...body } = d;
            return id ? api.patch<EventRecord>(`/api/v1/events/${seg(id)}`, body) : api.post<EventRecord>("/api/v1/events", body);
          }}
          success={(e) => (isEdit ? `Event “${e.name}” updated` : `Event “${e.name}” created`)}
          onDone={() => {
            if (!isEdit) setD(EMPTY);
            onSaved();
          }}
          disabledReason={reason ?? (d.name.trim() ? null : "Enter an event name")}
        >
          {isEdit ? "Save event" : "Create event"}
        </ActionButton>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </>
  );
}

function EventRow({ ev, onEdit }: { ev: EventRecord; onEdit: () => void }) {
  const logo = assetUrl(ev.logoAssetId);
  return (
    <tr>
      <td>
        <div className="row">
          {logo ? <img className="thumb" src={logo} alt="" /> : null}
          <span>
            <strong>{ev.name}</strong>
            <div className="small muted">{ev.timeZone}</div>
          </span>
        </div>
      </td>
      <td className="small">{ev.startsOn || ev.endsOn ? `${ev.startsOn ?? "?"} → ${ev.endsOn ?? "?"}` : <span className="muted">No dates</span>}</td>
      <td>
        <span className="row" title={`Primary ${ev.brandPrimary} · secondary ${ev.brandSecondary}`}>
          <span className="ga-swatch" style={{ background: ev.brandPrimary }} aria-label={`Primary colour ${ev.brandPrimary}`} role="img" />
          <span className="ga-swatch" style={{ background: ev.brandSecondary }} aria-label={`Secondary colour ${ev.brandSecondary}`} role="img" />
        </span>
      </td>
      <td className="small">{ev.mapPool.length ? <span title={ev.mapPool.join(", ")}>{ev.mapPool.length} maps</span> : <span className="muted">—</span>}</td>
      <td style={{ textAlign: "right" }}>
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${ev.name}`}>
          Edit
        </Button>
      </td>
    </tr>
  );
}

export function EventsScreen() {
  const events = useApi<EventRecord[]>("/api/v1/events");
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Tournaments</h1>
        <Button variant={creating ? "secondary" : "primary"} onClick={() => setCreating(!creating)}>
          {creating ? "Cancel" : "New event"}
        </Button>
      </div>
      <p className="page-intro">Tournaments and other events. An event sets the branding and default map pool that its matches and HUDs use.</p>
      {creating ? (
        <Panel title="New event">
          <EventForm
            initial={EMPTY}
            onSaved={() => {
              setCreating(false);
              void events.reload();
            }}
          />
        </Panel>
      ) : null}
      <Panel title="Events">
        <Async state={events}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No events yet">
                Create the event first, then add teams and matches.
              </EmptyState>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Dates</th>
                    <th>Colours</th>
                    <th>Map pool</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((ev) =>
                    editing === ev.id ? (
                      <tr key={ev.id}>
                        <td colSpan={5}>
                          <EventForm
                            initial={ev}
                            onSaved={() => {
                              setEditing(null);
                              void events.reload();
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <EventRow key={ev.id} ev={ev} onEdit={() => setEditing(ev.id)} />
                    ),
                  )}
                </tbody>
              </table>
            )
          }
        </Async>
      </Panel>
    </div>
  );
}
