import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord } from "../api/types.ts";
import { AssetUpload, assetUrl, MapPoolEditor } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Button, EmptyState, Field, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { useMapSuggestions } from "../lib/maps.ts";
import { usePermission } from "../state/session.tsx";

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
        <Field label="Time zone" hint="IANA name, e.g. Europe/Berlin">
          <input value={d.timeZone} onChange={(e) => set({ timeZone: e.target.value })} />
        </Field>
        <Field label="Starts">
          <input type="date" value={d.startsOn ?? ""} onChange={(e) => set({ startsOn: e.target.value || null })} />
        </Field>
        <Field label="Ends">
          <input type="date" value={d.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} />
        </Field>
        <Field label="Brand primary">
          <input type="color" value={d.brandPrimary} onChange={(e) => set({ brandPrimary: e.target.value })} />
        </Field>
        <Field label="Brand secondary">
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
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
      </div>
    </>
  );
}

export function EventsScreen() {
  const events = useApi<EventRecord[]>("/api/v1/events");
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Events</h1>
      </div>
      <p className="page-intro">An event holds branding (colours, logo) and the default map pool. Matches link to an event; HUDs show its name and logo.</p>
      <div className="grid-2-1">
        <Panel title="Events">
          <Async state={events}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No events yet">Create the event on the right, then add teams and matches.</EmptyState>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Dates</th>
                      <th>Brand</th>
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
                        <tr key={ev.id}>
                          <td>
                            <div className="row">
                              {assetUrl(ev.logoAssetId) ? <img className="thumb" src={assetUrl(ev.logoAssetId)!} alt="" /> : null}
                              <span>
                                <strong>{ev.name}</strong>
                                <div className="small muted">{ev.timeZone}</div>
                              </span>
                            </div>
                          </td>
                          <td className="small">
                            {ev.startsOn ?? "?"} → {ev.endsOn ?? "?"}
                          </td>
                          <td>
                            <span className="row small">
                              <span className="dot" style={{ background: ev.brandPrimary }} aria-hidden /> {ev.brandPrimary}
                              <span className="dot" style={{ background: ev.brandSecondary }} aria-hidden /> {ev.brandSecondary}
                            </span>
                          </td>
                          <td className="small">{ev.mapPool.join(", ") || <span className="muted">—</span>}</td>
                          <td>
                            <Button size="sm" onClick={() => setEditing(ev.id)}>
                              Edit
                            </Button>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              )
            }
          </Async>
        </Panel>
        <Panel title="New event">
          <EventForm initial={EMPTY} onSaved={() => void events.reload()} />
        </Panel>
      </div>
    </div>
  );
}
