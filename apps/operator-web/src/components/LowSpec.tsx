import { useState } from "react";
import { api, describeError } from "../api/index.ts";
import type { LowSpecStatus } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import { useApi } from "../lib/hooks.ts";
import { useLowSpec } from "../lib/lowSpec.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import { ActionButton, Checkbox, KV, Note, Panel } from "./ui.tsx";

/** Turns low-spec mode on or off (PUT /api/v1/performance, audited). */
export const setLowSpec = (on: boolean) => api.put<LowSpecStatus>("/api/v1/performance", { lowSpec: on });

function engineMemory(st: LowSpecStatus, canRestart: boolean): string {
  const used = t("settings.perf.inUse", { mb: st.engine.heapUsedMb });
  if (!st.lowSpec) return t("settings.perf.noCap", { used });
  if (st.engine.heapCapMb !== null) return t("settings.perf.capped", { mb: st.engine.heapCapMb, used });
  return canRestart ? t("settings.perf.capNextStart", { used }) : t("settings.perf.capByProgram", { used });
}

function obsLine(st: LowSpecStatus): string {
  if (!st.lowSpec) return t("settings.perf.unchanged");
  if (st.obs.error) return t("settings.perf.obsError", { error: st.obs.error });
  if (!st.obs.connected) return t("settings.perf.obsNotConnected");
  return st.obs.sources.length ? t("settings.perf.obsSources", { sources: st.obs.sources.join(", ") }) : t("settings.perf.obsNone");
}

/**
 * Settings → General → Performance: Low-spec mode (one PC, ADR-078), off by default. What it does,
 * and what it has done here: the engine's memory cap, OBS's browser sources, background work.
 */
export function PerformancePanel() {
  const reason = usePermission("settings.manage");
  const summary = useLowSpec();
  const status = useApi<LowSpecStatus>("/api/v1/performance", { refreshMs: 5000 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = status.data;
  const on = st?.lowSpec ?? summary?.lowSpec ?? false;
  const mf = window.matchframe;
  const canRestart = !!mf?.restartEngine && mf.connectionMode !== "remote";
  const save = async (v: boolean) => {
    setSaving(true);
    setError(null);
    try {
      status.setData(await setLowSpec(v));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title={t("settings.perf.title")} subtitle={t("settings.perf.subtitle")}>
      <div className="stack" data-testid="performance-panel">
        <Checkbox checked={on} disabled={reason !== null || saving || !st} onChange={(v) => void save(v)} label={<strong>{t("settings.perf.lowSpec")}</strong>} hint={reason ?? t("settings.perf.lowSpecHint")} />
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>{t("settings.perf.what1")}</li>
          <li>{t("settings.perf.what2")}</li>
          <li>{t("settings.perf.what3")}</li>
          <li>{t("settings.perf.what4")}</li>
        </ul>
        {st ? (
          <KV
            items={[
              [t("settings.perf.engineMemory"), engineMemory(st, canRestart)],
              [t("settings.perf.obsSourcesLabel"), obsLine(st)],
              [t("settings.perf.background"), st.deferring ? t("settings.perf.bgWaiting") : st.lowSpec ? t("settings.perf.bgBetween") : t("settings.perf.bgAsSet")],
            ]}
          />
        ) : null}
        {st?.lowSpec && st.engine.heapCapMb === null && canRestart ? (
          <div className="row">
            <ActionButton
              size="sm"
              action={async () => {
                if (!(await mf!.restartEngine!())) throw new Error(t("settings.perf.restartFailed"));
                return true;
              }}
              success={t("settings.perf.restarting")} confirm={{ title: t("settings.perf.restartTitle"), body: t("settings.perf.restartBody"), confirmLabel: t("settings.perf.restartEngine") }}>
              {t("settings.perf.restartNow")}
            </ActionButton>
          </div>
        ) : null}
        {!on && summary?.suggestion ? <Note tone="info" title={t("settings.perf.suggested")}>{summary.suggestion.reason}</Note> : null}
        {error ? <Note tone="warn">{error}</Note> : null}
      </div>
    </Panel>
  );
}

/**
 * The one-time suggestion (HUD Library): HUD outputs stuttered while CS2 runs on this computer. Turn
 * it on, or dismiss it for good.
 */
export function LowSpecSuggestion() {
  const summary = useLowSpec();
  const reason = usePermission("settings.manage");
  const [done, setDone] = useState(false);
  const s = summary?.suggestion;
  if (!s || summary.lowSpec || done) return null;
  return (
    <div data-testid="low-spec-suggestion">
      <Note tone="info" title={t("settings.perf.onePc")}>
        <p style={{ margin: "0 0 8px" }}>
          {s.reason} <T k="settings.perf.suggestion" />
        </p>
        <div className="row">
          <ActionButton size="sm" variant="primary" action={() => setLowSpec(true)} success={t("settings.perf.on")} onDone={() => setDone(true)} disabledReason={reason}>
            {t("settings.perf.turnOn")}
          </ActionButton>
          <ActionButton size="sm" variant="ghost" action={() => api.post<LowSpecStatus>("/api/v1/performance/suggestion/dismiss")} success={null} onDone={() => setDone(true)} disabledReason={reason}>
            {t("shell.status.dismiss")}
          </ActionButton>
          <Link to="/settings">{t("settings.perf.whatItDoes")}</Link>
        </div>
      </Note>
    </div>
  );
}
