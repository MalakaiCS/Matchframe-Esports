import { useState } from "react";
import { api, seg } from "../api/index.ts";
import type { EventRecord } from "../api/types.ts";
import { AssetUpload, assetUrl, MapPoolEditor } from "../components/AssetUpload.tsx";
import { ActionButton, Async, Button, EmptyState, Field, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { useMapSuggestions } from "../lib/maps.ts";
import { usePermission } from "../state/session.tsx";
import { t } from "../i18n/index.ts";
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
        <Field label={t("matches.eventName")}>
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t("matches.timeZone")}>
          <input value={d.timeZone} onChange={(e) => set({ timeZone: e.target.value })} placeholder={t("matches.eGEuropeBerlin")} title={t("matches.ianaTimeZoneNameE")} />
        </Field>
        <Field label={t("matches.starts")}>
          <input type="date" value={d.startsOn ?? ""} onChange={(e) => set({ startsOn: e.target.value || null })} />
        </Field>
        <Field label={t("matches.ends")}>
          <input type="date" value={d.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} />
        </Field>
        <Field label={t("matches.primaryColour")}>
          <input type="color" value={d.brandPrimary} onChange={(e) => set({ brandPrimary: e.target.value })} />
        </Field>
        <Field label={t("matches.secondaryColour")}>
          <input type="color" value={d.brandSecondary} onChange={(e) => set({ brandSecondary: e.target.value })} />
        </Field>
        <AssetUpload label={t("matches.eventLogo")} value={d.logoAssetId} onChange={(id) => set({ logoAssetId: id })} disabledReason={reason} />
      </div>
      <MapPoolEditor value={d.mapPool} onChange={(m) => set({ mapPool: m })} suggestions={suggestions} />
      <div className="form-actions">
        <ActionButton
          variant="primary"
          action={() => {
            const { id, ...body } = d;
            return id ? api.patch<EventRecord>(`/api/v1/events/${seg(id)}`, body) : api.post<EventRecord>("/api/v1/events", body);
          }}
          success={(e) => (isEdit ? t("matches.eventNameUpdated", { name: e.name }) : t("matches.eventNameCreated", { name: e.name }))}
          onDone={() => {
            if (!isEdit) setD(EMPTY);
            onSaved();
          }}
          disabledReason={reason ?? (d.name.trim() ? null : t("matches.enterAnEventName"))}
        >
          {isEdit ? t("matches.saveEvent") : t("matches.createEvent")}
        </ActionButton>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
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
      <td className="small">{ev.startsOn || ev.endsOn ? `${ev.startsOn ?? "?"} → ${ev.endsOn ?? "?"}` : <span className="muted">{t("matches.noDates")}</span>}</td>
      <td>
        <span className="row" title={t("matches.primaryBrandprimarySecondaryBrandseconda", { brandPrimary: ev.brandPrimary, brandSecondary: ev.brandSecondary })}>
          <span className="ga-swatch" style={{ background: ev.brandPrimary }} aria-label={t("matches.primaryColourBrandprimary", { brandPrimary: ev.brandPrimary })} role="img" />
          <span className="ga-swatch" style={{ background: ev.brandSecondary }} aria-label={t("matches.secondaryColourBrandsecondary", { brandSecondary: ev.brandSecondary })} role="img" />
        </span>
      </td>
      <td className="small">{ev.mapPool.length ? <span title={ev.mapPool.join(", ")}>{t("matches.countMaps", { count: ev.mapPool.length })}</span> : <span className="muted">—</span>}</td>
      <td style={{ textAlign: "right" }}>
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t("matches.editName", { name: ev.name })}>{t("matches.edit")}</Button>
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
        <h1 className="page-title">{t("matches.tournaments")}</h1>
        <Button variant={creating ? "secondary" : "primary"} onClick={() => setCreating(!creating)}>
          {creating ? t("common.cancel") : t("matches.newEvent")}
        </Button>
      </div>
      <p className="page-intro">{t("matches.tournamentsAndOtherEventsAn")}</p>
      {creating ? (
        <Panel title={t("matches.newEvent")}>
          <EventForm
            initial={EMPTY}
            onSaved={() => {
              setCreating(false);
              void events.reload();
            }}
          />
        </Panel>
      ) : null}
      <Panel title={t("matches.events")}>
        <Async state={events}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title={t("matches.noEventsYet")}>{t("matches.createTheEventFirstThen")}</EmptyState>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("matches.event")}</th>
                    <th>{t("matches.dates")}</th>
                    <th>{t("matches.colours")}</th>
                    <th>{t("matches.mapPool")}</th>
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
