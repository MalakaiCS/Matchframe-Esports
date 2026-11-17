import { useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Field, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { PresetsView } from "./types.ts";
import { t } from "../../i18n/index.ts";

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
    if (r?.loaded?.skipped.length) toast.push("warn", t("comms.loadedNameExcept", { name: r.loaded.name }), r.loaded.skipped.join("; "));
  };
  const saveAs = async () => {
    try {
      await api.post<PresetsView>("/api/v1/comms/presets", { name: name.trim() });
      toast.push("ok", t("comms.savedTrim", { trim: name.trim() }));
      setName("");
      done();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const rename = async () => {
    if (!renaming) return;
    try {
      await api.put<PresetsView>(`/api/v1/comms/presets/${seg(renaming.id)}`, { name: renaming.name.trim() });
      setRenaming(null);
      done();
    } catch (e) {
      toast.push("danger", t("comms.notRenamed"), describeError(e));
    }
  };
  if (!v) return <Panel title={t("comms.eventPresets")}>{st.error ? <Note tone="warn">{t("comms.presetsArenTAvailableError", { error: st.error })}</Note> : <p className="muted small">{t("common.loading")}</p>}</Panel>;
  const active = v.active;
  return (
    <Panel
      title={t("comms.eventPresets")}
      subtitle={t("comms.peopleAndTheirChoicesEach", { v: v.currentEventName ? t("comms.thisMatchCurrenteventname", { currentEventName: v.currentEventName }) : "" })}
      actions={active ? <Badge tone={active.changed ? "warn" : "ok"} icon={active.changed ? "✎" : "✓"}>{active.changed ? t("comms.nameChanged", { name: active.name }) : active.name}</Badge> : <Badge tone="neutral">{t("comms.noPresetLoaded")}</Badge>}
    >
      <div className="stack-sm">
        <p className="small" role="status" aria-live="polite">
          {active ? (active.changed ? t("comms.activePresetNameChangedSince", { name: active.name, join: active.differs.join(", ") }) : t("comms.activePresetNameAsSaved", { name: active.name })) : t("comms.noActivePresetTheCurrent")}
        </p>
        <div className="row-end">
          <Field label={t("comms.saveAs")}>
            <input aria-label={t("comms.newPresetName")} value={name} maxLength={80} placeholder={t("comms.eGSpringCupPlayoffs")} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant="primary" disabledReason={reason ?? (name.trim() ? null : t("comms.nameItFirst"))} onClick={() => void saveAs()}>{t("comms.saveAs")}</Button>
          {active ? (
            <ActionButton disabledReason={reason ?? (active.changed ? null : t("comms.noChangeSinceItWas"))} action={() => api.post<PresetsView>(`/api/v1/comms/presets/${seg(active.id)}/save`)} onDone={() => done()} success={t("comms.savedName", { name: active.name })}>
              {t("comms.saveName", { name: active.name })}
            </ActionButton>
          ) : null}
        </div>
        {v.presets.length === 0 ? (
          <p className="muted small">{t("comms.noPresetsYet")}</p>
        ) : (
          <table className="table comms-presets">
            <thead>
              <tr>
                <th>{t("comms.preset")}</th>
                <th>{t("comms.event")}</th>
                <th>{t("comms.people")}</th>
                <th>{t("comms.delay")}</th>
                <th aria-label={t("comms.actions")} />
              </tr>
            </thead>
            <tbody>
              {v.presets.map((p) => (
                <tr key={p.id} className={p.active ? "is-active" : ""}>
                  <td>
                    {renaming?.id === p.id ? (
                      <span className="row">
                        <input aria-label={t("comms.renameName", { name: p.name })} value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                        <Button size="sm" disabledReason={renaming.name.trim() ? null : t("comms.nameIt")} onClick={() => void rename()}>{t("comms.rename")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                      </span>
                    ) : (
                      <>
                        <strong>{p.name}</strong> {p.active ? <Badge tone="info">{active?.changed ? t("comms.activeChanged") : t("comms.active")}</Badge> : null}
                        <div className="muted small">{p.teams.map((tRow) => tRow.name ?? t("comms.aTeamNoLongerIn")).join(" vs ")}</div>
                      </>
                    )}
                  </td>
                  <td className="small">{p.eventName ?? (p.eventId ? t("comms.anEventNoLongerIn") : t("comms.anyEvent"))}</td>
                  <td className="small">{t("comms.peopleBroadcastBroadcastRecordingRecordi", { people: p.people, broadcast: p.included.broadcast, recording: p.included.recording })}</td>
                  <td className="small">{fmtDelay(p.delayMs)}</td>
                  <td>
                    <span className="row">
                      <ActionButton
                        size="sm"
                        variant={p.active ? "secondary" : "primary"}
                        disabledReason={reason}
                        action={() => api.post<PresetsView>(`/api/v1/comms/presets/${seg(p.id)}/load`)}
                        onDone={(r) => done(r)}
                        success={t("comms.loadedName", { name: p.name })}
                        confirm={active?.changed ? { title: t("comms.loadName", { name: p.name }), body: t("comms.theCurrentSetupHasChanges", { name: active.name, join: active.differs.join(", ") }), confirmLabel: t("comms.load") } : undefined}
                      >{t("comms.load")}</ActionButton>
                      <Button size="sm" variant="ghost" disabledReason={reason} onClick={() => setRenaming({ id: p.id, name: p.name })}>{t("comms.rename")}</Button>
                      <ActionButton size="sm" variant="ghost" disabledReason={reason} action={() => api.del<PresetsView>(`/api/v1/comms/presets/${seg(p.id)}`)} onDone={() => done()} success={t("comms.deletedName", { name: p.name })} confirm={{ title: t("comms.deleteName", { name: p.name }), body: t("comms.thePresetIsGoneThe"), confirmLabel: t("comms.delete") }}>{t("comms.delete")}</ActionButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t("comms.loadingAPresetNeverPuts")}</p>
      </div>
    </Panel>
  );
}
