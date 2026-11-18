import { api } from "../../api/index.ts";
import { ActionButton, Async, Badge, Details, Note, Panel } from "../../components/ui.tsx";
import { fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
    <Panel title={t("training.whatTheDemosTeach")} subtitle={t("training.aModelTrainedOnDemos")}>
      <Async state={st}>
        {(s) => {
          const b = s.active?.bench;
          return (
            <>
              <div className="row">
                {s.active ? <Badge tone="ok">{t("training.on")}</Badge> : s.setting.enabled ? <Badge tone="warn">{t("training.notLoaded")}</Badge> : <Badge tone="neutral">{t("training.off")}</Badge>}
                <b>{s.setting.modelId === "builtin" ? t("training.builtInModel") : s.setting.modelId}</b>
                {s.active && s.active.maps.length ? <span className="small muted">{t("training.trainedOnJoin", { join: s.active.maps.map(mapName).join(", ") })}</span> : null}
              </div>
              {s.error && s.setting.enabled ? <Note tone="warn">{t("training.errorTheAutoDirectorRuns", { error: s.error })}</Note> : null}
              {s.active?.notes ? <p className="small muted">{s.active.notes}</p> : null}
              {b?.without_model && b.with_model_and_multi_frag ? (
                <p className="small"><T k="training.testBenchEachMatchReplayed" values={{ kills_shown: pct(b.without_model.kills_shown, b.without_model.kills), b: <b>{pct(b.with_model_and_multi_frag.kills_shown, b.with_model_and_multi_frag.kills)}</b>, multi_frag_kills_shown: pct(b.without_model.multi_frag_kills_shown, b.without_model.multi_frag_kills), b2: <b>{pct(b.with_model_and_multi_frag.multi_frag_kills_shown, b.with_model_and_multi_frag.multi_frag_kills)}</b>, opening_kills_shown: b.without_model.opening_kills_shown, b3: <b>{b.with_model_and_multi_frag.opening_kills_shown}</b>, opening_kills: b.without_model.opening_kills }} /></p>
              ) : null}
              <div className="form-actions">
                <ActionButton variant={s.setting.enabled ? "secondary" : "primary"} action={() => set({ enabled: !s.setting.enabled })} success={(r) => (r.setting.enabled ? (r.active ? t("training.theAutoDirectorUsesThe") : t("training.turnedOnButTheModel")) : t("training.theAutoDirectorRunsWithout"))} onDone={() => void st.reload()} disabledReason={reason}>
                  {s.setting.enabled ? t("training.turnOff") : t("training.turnOn")}
                </ActionButton>
                {s.setting.modelId !== "builtin" ? (
                  <ActionButton size="sm" variant="ghost" action={() => set({ modelId: "builtin" })} success={t("training.backToTheBuiltIn")} onDone={() => void st.reload()} disabledReason={reason}>{t("training.useTheBuiltInModel")}</ActionButton>
                ) : null}
              </div>
              {s.available.length ? (
                <Details summary={t("training.yourTrainedPovModelsCount", { count: s.available.length })}>
                  <ul className="small">
                    {s.available.map((m) => (
                      <li key={m.modelId}>
                        <span className="mono">{m.modelId}</span> <span className="muted">{fmtTime(m.createdAt)}</span>{" "}
                        {s.setting.modelId === m.modelId ? (
                          <Badge tone="ok">{t("training.inUse")}</Badge>
                        ) : (
                          <ActionButton size="sm" variant="ghost" action={() => set({ modelId: m.modelId, enabled: true })} success={(r) => (r.active ? t("training.modelidNowHelpsTheAuto", { modelId: m.modelId }) : t("training.notLoadedV", { v: r.error ?? t("training.unknownReason") }))} onDone={() => void st.reload()} disabledReason={reason}>{t("training.useThisOne")}</ActionButton>
                        )}
                        {m.notes ? <div className="muted">{m.notes}</div> : null}
                      </li>
                    ))}
                  </ul>
                  <p className="small muted">{t("training.runTheTestBenchAfter")}</p>
                </Details>
              ) : null}
              <Details summary={t("training.howItWorks")}>
                <p className="small muted">{t("training.forEveryLivingPlayerThe")}</p>
              </Details>
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
