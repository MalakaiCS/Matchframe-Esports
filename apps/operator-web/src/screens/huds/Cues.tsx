import { useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { HudCue, HudOutputEntry } from "../../api/types.ts";
import { ActionButton, Async, EmptyState, Field, Panel } from "../../components/ui.tsx";
import { fmtMs } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { useNow } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
      <Panel title={t("huds.showACue")} subtitle={t("huds.lowerThirdsCasterCardsAnd")}>
        <div className="form-grid">
          <Field label={t("huds.kind")}>
            <input list="cue-kinds" value={kind} onChange={(e) => setKind(e.target.value)} />
            <datalist id="cue-kinds">
              {["lower_third", "caster_card", "announcement", "sponsor_show", "stat_card"].map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </Field>
          <Field label={t("huds.title")}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t("huds.subtitle")}>
            <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          </Field>
          <Field label={t("huds.durationS")} hint={t("huds.emptyUntilCleared")}>
            <input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
        </div>
        <fieldset style={{ marginTop: 10 }}>
          <legend><T k="huds.outputsNoneSelectedAll" tags={{ span: (c) => <span className="muted small">{c}</span> }} /></legend>
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
            success={(c) => t("huds.cueTitleOnAir", { title: c.title })}
            onDone={() => void cues.reload()}
            disabledReason={reason ?? (title.trim() && kind.trim() ? null : t("huds.enterAKindAndA"))}
          >{t("huds.showCue")}</ActionButton>
        </div>
      </Panel>
      <Panel title={t("huds.activeCues")} className="gb-start">
        <Async state={cues}>
          {(list) => {
            const active = list.filter((c) => c.untilMs === null || c.untilMs > now);
            return active.length === 0 ? (
              <EmptyState title={t("huds.noActiveCues")}>{t("huds.cuesFromHereAutomationRules")}</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("huds.cue")}</th>
                    <th>{t("huds.kind")}</th>
                    <th>{t("huds.outputs")}</th>
                    <th>{t("huds.remaining")}</th>
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
                      <td>{c.outputs?.join(", ") ?? t("huds.all")}</td>
                      <td>{c.untilMs === null ? t("huds.untilCleared") : fmtMs(c.untilMs - now)}</td>
                      <td>
                        <ActionButton size="sm" action={() => api.del(`/api/v1/hud/cues/${seg(c.id)}`)} success={t("huds.cueCleared")} onDone={() => void cues.reload()} disabledReason={reason}>{t("huds.clear")}</ActionButton>
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
