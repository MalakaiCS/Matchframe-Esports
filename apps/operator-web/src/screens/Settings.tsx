import { useEffect, useState } from "react";
import { api, describeError, seg } from "../api/index.ts";
import type { AuditEntry, BroadcastReport, EngineMetrics, LogEntry, StatsResponse } from "../api/types.ts";
import { ImageField } from "../components/forms.tsx";
import { formatDate, formatNumber, LANGUAGE_NAMES, LOCALES, perLocale, t, type LanguagePref } from "../i18n/index.ts";
import { setLanguagePref, systemLocale, useLanguagePref } from "../i18n/language.ts";
import { T } from "../i18n/T.tsx";
import { PerformancePanel } from "../components/LowSpec.tsx";
import { ActionButton, Async, Badge, Button, Details, EmptyState, Field, JsonEditor, KV, Note, Panel, parseJsonOr } from "../components/ui.tsx";
import { setDefaultPlayerPicture, useDefaultPlayerPicture, type DefaultPlayerPicture } from "../lib/defaultPicture.ts";
import { fmtMs, fmtTime, MISSING, saveBlob } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { reasonInfo } from "../lib/reasons.ts";
import { Link } from "../router.tsx";
import { rollback, rollbackProgressText, updates, updateSummary, useRollbackProgress, useUpdates, type RollbackOption, type RollbackResult } from "../lib/updates.ts";
import { useCrashReports } from "../lib/crashReports.ts";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-c.css";

/** Settings keys the console knows about. Writable prefixes mirror the engine (hud|program|replay|director|demos|ui). */
const SETTING_KEYS = ["program.scenes", "replay.provider", "replay.mediaInput", "hud.radarUtility", "hud.allowUnverifiedRadar", "hud.annotationsDraft", "demos.config", "ui.rundownPosition", "observer.adapter", "observer.verifiedControl", "live.activeMatchId"];
export const KNOWN_SETTINGS: { key: string; description: string }[] = perLocale(() => SETTING_KEYS.map((key) => ({ key, description: t(`settings.keys.${key.replace(".", "_")}`) })));

export function settingWritable(key: string): boolean {
  return /^(hud|program|replay|director|demos|ui)\./.test(key);
}

function SettingsTab() {
  const reason = usePermission("settings.manage");
  const [key, setKey] = useState(KNOWN_SETTINGS[0]!.key);
  const [custom, setCustom] = useState("");
  const value = useApi<{ key: string; value: unknown }>(reason ? null : `/api/v1/settings/${seg(key)}`);
  const [text, setText] = useState("");
  useEffect(() => {
    if (value.data) setText(JSON.stringify(value.data.value, null, 2));
  }, [value.data]);
  const parsed = parseJsonOr<unknown>(text, null);
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <>
      <p className="page-intro">{t("settings.advanced.intro")}</p>
      <div className="grid-1-2">
        <Panel title={t("settings.advanced.keys")}>
          <ul className="select-list">
            {KNOWN_SETTINGS.map((s) => (
              <li key={s.key}>
                <button className={s.key === key ? "is-selected" : ""} onClick={() => setKey(s.key)}>
                  <span style={{ flex: 1 }}>
                    <span className="mono">{s.key}</span>
                    <div className="small muted">{s.description}</div>
                  </span>
                  {settingWritable(s.key) ? null : <span className="small muted">{t("settings.advanced.readOnly")}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="row-end" style={{ marginTop: 10 }}>
            <Field label={t("settings.advanced.otherKey")}>
              <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="hud.someSetting" />
            </Field>
            <Button onClick={() => custom.trim() && setKey(custom.trim())} disabled={!custom.trim()}>
              {t("settings.advanced.open")}
            </Button>
          </div>
        </Panel>
        <Panel title={key} subtitle={settingWritable(key) ? t("settings.advanced.writable") : t("settings.advanced.readOnlyHere")}>
          <Async state={value}>
            {() => (
              <>
                <JsonEditor label={t("settings.advanced.value")} value={text} onChange={setText} rows={14} />
                <div className="form-actions">
                  <ActionButton
                    variant="primary"
                    action={() => {
                      if (!parsed.ok) throw new Error(parsed.error);
                      return api.put(`/api/v1/settings/${seg(key)}`, { value: parsed.value });
                    }}
                    success={t("settings.advanced.saved", { key })}
                    onDone={() => void value.reload()}
                    disabledReason={!settingWritable(key) ? t("settings.advanced.notWritable") : parsed.ok ? null : t("settings.advanced.invalidJson")}
                  >
                    {t("settings.save")}
                  </ActionButton>
                  <Button variant="ghost" onClick={() => void value.reload()}>
                    {t("settings.reload")}
                  </Button>
                </div>
              </>
            )}
          </Async>
        </Panel>
      </div>
    </>
  );
}

function AuditTab() {
  const reason = usePermission("settings.manage");
  const audit = useApi<AuditEntry[]>(reason ? null : "/api/v1/audit?limit=300", { refreshMs: 5000 });
  const [q, setQ] = useState("");
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <Panel title={t("nav.auditLog")} subtitle={t("settings.audit.subtitle")} actions={<input aria-label={t("settings.audit.filter")} placeholder={t("settings.audit.filterPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />}>
      <Async state={audit}>
        {(list) => {
          const f = list.filter((a) => !q || `${a.actor} ${a.action} ${a.target ?? ""}`.toLowerCase().includes(q.toLowerCase()));
          return (
            <div className="table-wrap" style={{ maxHeight: 640, overflowY: "auto" }}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("settings.audit.at")}</th>
                    <th>{t("settings.audit.actor")}</th>
                    <th>{t("settings.audit.action")}</th>
                    <th>{t("settings.audit.target")}</th>
                    <th>{t("settings.audit.detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {f.map((a) => (
                    <tr key={a.seq}>
                      <td className="mono small muted">{a.seq}</td>
                      <td className="small gc-nowrap">{fmtTime(a.at)}</td>
                      <td>{a.actor}</td>
                      <td className="mono small">{a.action}</td>
                      <td className="small">{a.target ?? MISSING}</td>
                      <td className="small mono muted">{a.detail ? JSON.stringify(a.detail).slice(0, 140) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Async>
    </Panel>
  );
}

function LogsTab() {
  const reason = usePermission("settings.manage");
  const logs = useApi<LogEntry[]>(reason ? null : "/api/v1/logs/recent", { refreshMs: 4000 });
  const [level, setLevel] = useState("all");
  if (reason) return <Note tone="warn">{reason}.</Note>;
  return (
    <Panel
      title={t("settings.logs.title")}
      subtitle={t("settings.logs.subtitle")}
      actions={
        <select aria-label={t("settings.logs.level")} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">{t("settings.logs.all")}</option>
          <option value="error">{t("settings.logs.errors")}</option>
          <option value="warn">{t("settings.logs.warnings")}</option>
          <option value="info">{t("settings.logs.info")}</option>
        </select>
      }
    >
      <Async state={logs}>
        {(list) => {
          const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
          const min = level === "all" ? 0 : (rank[level] ?? 0);
          const f = [...list].reverse().filter((l) => (rank[l.level] ?? 0) >= min);
          return f.length === 0 ? (
            <p className="muted small">{t("settings.logs.empty")}</p>
          ) : (
            <div style={{ maxHeight: 640, overflowY: "auto" }}>
              <table className="table table-compact">
                <tbody>
                  {f.map((l, i) => (
                    <tr key={i}>
                      <td className="small gc-nowrap">{fmtTime(l.at ?? l.ts ?? l.time ?? null)}</td>
                      <td>{l.level === "error" || l.level === "warn" ? <Badge tone={l.level === "error" ? "danger" : "warn"}>{l.level}</Badge> : <span className="small muted">{l.level}</span>}</td>
                      <td>
                        {l.msg ?? l.message}
                        {l.data !== undefined ? <div className="small mono muted">{JSON.stringify(l.data).slice(0, 200)}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Async>
    </Panel>
  );
}

const METRIC_KEYS = ["packets", "rejected", "invalid", "cuts", "recommendations", "ingestP95Ms", "evalP95Ms", "maxIngestMs", "maxEvalMs"];
const METRIC_LABEL: Record<string, string> = perLocale(() => Object.fromEntries(METRIC_KEYS.map((k) => [k, t(`settings.metric.${k}`)])));

function DiagnosticsTab() {
  const settingsReason = usePermission("settings.manage");
  const metrics = useApi<EngineMetrics>("/api/v1/live/metrics", { refreshMs: 2000 });
  return (
    <div className="grid-2">
      <Panel title={t("settings.diag.troubleshooting")}>
        <ActionButton
          variant="primary"
          action={async () => {
            const d = await api.download("/api/v1/diagnostics/bundle");
            saveBlob(d.blob, d.filename ?? `matchframe-support-${Date.now()}.json`);
            return d;
          }}
          success={(d) => t("settings.diag.downloaded", { file: d.filename ?? t("settings.diag.bundle") })}
          disabledReason={settingsReason}
        >
          {t("settings.diag.downloadBundle")}
        </ActionButton>
        <p className="gc-caption">{t("settings.diag.bundleCaption")}</p>
        <div className="gc-section">
          <h3 className="gc-section-title">API</h3>
          <ActionButton
            size="sm"
            action={async () => {
              const d = await api.download("/api/v1/openapi.json");
              saveBlob(d.blob, "matchframe-openapi.json");
              return d;
            }}
            success={t("settings.diag.openapiDownloaded")}
          >
            {t("settings.diag.downloadOpenapi")}
          </ActionButton>
          <p className="gc-caption">
            <T k="settings.diag.apiCaption" values={{ path: <code>/api/v1/openapi.json</code> }} />
          </p>
        </div>
      </Panel>
      <Panel title={t("settings.diag.metrics")} subtitle={t("settings.diag.metricsSubtitle")}>
        <Async state={metrics}>
          {(m) => (
            <dl className="gc-metrics">
              {Object.entries(m).map(([k, v]) => (
                <div key={k}>
                  <dt title={k}>{METRIC_LABEL[k] ?? k}</dt>
                  <dd>{v === null ? MISSING : /Ms$/.test(k) ? fmtMs(v) : formatNumber(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Async>
      </Panel>
    </div>
  );
}

/** Going back to an earlier version: one at a time, its progress pushed by the program. */
function useGoBack() {
  const [progress, setProgress] = useRollbackProgress();
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<RollbackResult | null>(null);
  const start = async (version: string, toStable = false) => {
    setRunning(version);
    setResult(null);
    try {
      setResult(await rollback.start(version, { toStable }));
    } catch (e) {
      setResult({ ok: false, message: describeError(e) });
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };
  return { progress: running ? progress : null, running, result, start };
}

/** Settings → General → Program → Go back to a previous version (ADR-076). */
function GoBackSection({ goBack }: { goBack: ReturnType<typeof useGoBack> }) {
  const [options, setOptions] = useState<RollbackOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setOptions(await rollback.list());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="gc-section" data-rollback>
      <h3 className="gc-section-title">{t("settings.goBack.title")}</h3>
      <p className="small muted">{t("settings.goBack.body")}</p>
      <div className="row">
        <Button onClick={() => void load()} disabledReason={loading ? t("settings.goBack.lookingUp") : goBack.running ? t("settings.busy") : null}>
          {options ? t("settings.goBack.refresh") : t("settings.goBack.open")}
        </Button>
      </div>
      {loading ? <p className="small muted">{t("settings.goBack.lookingUpGithub")}</p> : null}
      {error ? <Note tone="warn">{error}</Note> : null}
      {options && options.length === 0 ? <p className="small muted">{t("settings.goBack.none")}</p> : null}
      {options?.length ? (
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }} data-rollback-list>
          {options.map((o) => (
            <li key={o.version} data-rollback-version={o.version}>
              <div className="row">
                <strong>{o.version}</strong>
                {o.publishedAt ? <span className="small muted">{formatDate(o.publishedAt, { day: "numeric", month: "short", year: "numeric" })}</span> : null}
                <a href={o.notesUrl} target="_blank" rel="noreferrer">
                  {t("settings.whatsNew")}
                </a>
                <Button size="sm" onClick={() => void goBack.start(o.version)} disabledReason={o.data.kind === "refuse" ? t("settings.goBack.noCopy") : goBack.running ? t("settings.busy") : null}>
                  {t("settings.goBack.to", { version: o.version })}
                </Button>
              </div>
              <p className={`small ${o.data.kind === "refuse" ? "text-warn" : "muted"}`}>{o.data.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The program itself: version, automatic updates and their channel, going back to a previous
 * version, plus what used to be in the window's File menu (the window has no menu bar): connection
 * settings and the data folder.
 */
function ProgramPanel() {
  const st = useUpdates();
  const goBack = useGoBack();
  const mf = window.matchframe;
  if (!mf?.updates && !mf?.openConnection) return null;
  const busy = st?.status === "checking" || st?.status === "downloading";
  return (
    <Panel title={t("settings.program.title")} subtitle={st ? `MatchFrame Esports ${st.currentVersion}` : undefined}>
      {st ? (
        <div className="stack" data-updates={st.status}>
          <p className={st.status === "error" ? "text-warn" : st.status === "ready" ? "text-ok" : "muted"}>{updateSummary(st)}</p>
          <div className="row">
            {st.status === "ready" ? (
              <Button variant="primary" onClick={() => void updates.installNow()} title={t("settings.program.restartTitle")}>
                {t("settings.program.restartUpdate")}
              </Button>
            ) : st.status === "available" && st.downgrade && st.version ? (
              <Button variant="primary" onClick={() => void goBack.start(st.version!, true)} disabledReason={!rollback.available() ? t("settings.program.cantGoBack") : goBack.running ? t("settings.busy") : null} title={t("settings.program.installTitle")}>
                {t("settings.program.install", { version: st.version })}
              </Button>
            ) : st.status === "available" ? (
              <Button variant="primary" onClick={() => void updates.download()}>
                {t("settings.program.download", { version: st.version })}
              </Button>
            ) : (
              <Button onClick={() => void updates.check()} disabledReason={st.status === "disabled" ? st.disabledReason : busy ? t("settings.busy") : null}>
                {t("settings.program.check")}
              </Button>
            )}
            {st.releaseNotesUrl ? (
              <a href={st.releaseNotesUrl} target="_blank" rel="noreferrer">
                {t("settings.whatsNew")}
              </a>
            ) : null}
          </div>
          <label className="check">
            <input type="checkbox" checked={st.autoDownload} disabled={st.status === "disabled"} onChange={(e) => void updates.setAutoDownload(e.target.checked)} />
            <span>{t("settings.program.autoDownload")}</span>
          </label>
          {mf.updates?.setChannel ? (
            <Field label={t("settings.program.channel")} hint={t("settings.program.channelHint")}>
              <select value={st.channel ?? "stable"} disabled={st.status === "disabled"} onChange={(e) => void updates.setChannel(e.target.value === "beta" ? "beta" : "stable")} data-update-channel>
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </Field>
          ) : null}
          <p className="small muted">{t("settings.program.updatesNote")}</p>
        </div>
      ) : null}
      {goBack.progress ? <p className="small muted">{rollbackProgressText(goBack.progress)}</p> : null}
      {goBack.result ? <Note tone={goBack.result.ok ? "ok" : goBack.result.cancelled ? "info" : "warn"}>{goBack.result.message}</Note> : null}
      {rollback.available() ? <GoBackSection goBack={goBack} /> : null}
      <CrashReportsSetting />
      <div className="row" style={{ marginTop: 10 }}>
        {mf.openConnection ? <Button onClick={() => void mf.openConnection!()}>{t("settings.program.connection")}</Button> : null}
        {mf.openDataDir ? <Button onClick={() => void mf.openDataDir!()}>{t("settings.program.dataFolder")}</Button> : null}
      </div>
    </Panel>
  );
}

/** Send crash reports (ADR-077): off unless turned on here, or Always send after a crash. */
function CrashReportsSetting() {
  const { state, setEnabled } = useCrashReports();
  if (!state) return null;
  return (
    <div className="stack" style={{ marginTop: 10 }} data-crash-reports={state.enabled ? "on" : "off"}>
      <label className="check">
        <input type="checkbox" checked={state.enabled} onChange={(e) => void setEnabled(e.target.checked)} />
        <span>{t("settings.crash.send")}</span>
      </label>
      <p className="small muted">{t("settings.crash.body")}</p>
      {state.recent.length > 0 ? (
        <p className="small">
          <T
            k="settings.crash.sent"
            values={{
              list: state.recent.slice(0, 3).map((r, i) => (
                <span key={r.id}>
                  {i > 0 ? ", " : ""}
                  <code>{r.id}</code> ({fmtTime(r.sentAt)})
                </span>
              )),
            }}
          />
        </p>
      ) : null}
      {state.queued > 0 ? <p className="small muted">{state.lastError ? t("settings.crash.waitingError", { count: state.queued, error: state.lastError }) : t("settings.crash.waiting", { count: state.queued })}</p> : null}
    </div>
  );
}

/**
 * Settings → General → Language (ADR-082): applies at once, here and in the program's tray, dialogs
 * and notifications. Each language is listed in its own name, so it can be found in any language.
 */
export function LanguagePanel() {
  const pref = useLanguagePref();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (next: LanguagePref) => {
    setBusy(true);
    setError(null);
    try {
      await setLanguagePref(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t("settings.language.title")} subtitle={t("settings.language.subtitle")}>
      <div className="stack" data-language-panel>
        <Field label={t("settings.language.label")} hint={t("settings.language.hint")}>
          <select value={pref} disabled={busy} onChange={(e) => void choose(e.target.value as LanguagePref)} data-language={pref}>
            <option value="system">{t("settings.language.system", { language: LANGUAGE_NAMES[systemLocale()] })}</option>
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LANGUAGE_NAMES[l]}
              </option>
            ))}
          </select>
        </Field>
        <Note tone="info" title={t("settings.language.machineTitle")}>
          {t("settings.language.machine")}
        </Note>
        <p className="small muted">{t("settings.language.scope")}</p>
        {error ? <Note tone="warn">{error}</Note> : null}
      </div>
    </Panel>
  );
}

/** The default player picture: shown for any player without a picture of their own, everywhere. */
function DefaultPlayerPicturePanel() {
  const writeReason = usePermission("metadata.write");
  const pic = useDefaultPlayerPicture();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: { stagedId: string } | { clear: true }) => {
    setSaving(true);
    setError(null);
    try {
      setDefaultPlayerPicture(await api.put<DefaultPlayerPicture>("/api/v1/default-player-picture", body));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title={t("settings.picture.title")} subtitle={t("settings.picture.subtitle")}>
      <ImageField
        id="default-player-picture"
        label={t("settings.picture.label")}
        kind="avatar"
        value={{ assetId: pic?.assetId ?? null, staged: null }}
        disabledReason={writeReason ?? (saving ? t("settings.picture.saving") : null)}
        onChange={(v) => {
          if (v.staged) void save({ stagedId: v.staged.stagedId });
          else if (!v.assetId && pic?.assetId) void save({ clear: true });
        }}
      />
      <p className="small muted">
        <T k="settings.picture.note" tags={{ link: (c) => <Link to="/hud/images">{c}</Link> }} />
      </p>
      {error ? <Note tone="warn">{error}</Note> : null}
    </Panel>
  );
}

function GeneralTab() {
  const settingsReason = usePermission("settings.manage");
  const directorReason = usePermission("director.control");
  const snap = useSnapshot();
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <div className="grid-2">
      <LanguagePanel />
      <ProgramPanel />
      <PerformancePanel />
      <DefaultPlayerPicturePanel />
      <Panel title={t("settings.session.title")}>
        <div className="row">
          {snap?.simulated ? (
            <ActionButton action={() => api.post("/api/v1/simulation/stop")} success={t("settings.session.simStopped")} disabledReason={settingsReason}>
              {t("settings.session.stopSim")}
            </ActionButton>
          ) : (
            <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success={t("settings.session.simStarted")} disabledReason={settingsReason}>
              {t("settings.session.startSim")}
            </ActionButton>
          )}
          <ActionButton variant="ghost" action={() => api.post<{ sessionId: string }>("/api/v1/session/restart")} success={(r) => t("settings.session.newSession", { id: r.sessionId })} disabledReason={directorReason} confirm={{ title: t("settings.session.restartTitle"), body: t("settings.session.restartBody"), danger: true, confirmLabel: t("settings.session.restartConfirm") }}>
            {t("settings.session.restart")}
          </ActionButton>
        </div>
        <div className="gc-section">
          <h3 className="gc-section-title">{t("settings.gsi.title")}</h3>
          <p className="small muted">{t("settings.gsi.body")}</p>
          <div className="row">
            <ActionButton variant="ghost" action={() => api.post<{ note: string }>("/api/v1/setup/rotate-gsi-token")} success={(r) => t("settings.gsi.rotated", { note: r.note })} disabledReason={settingsReason} confirm={{ title: t("settings.gsi.rotateTitle"), body: t("settings.gsi.rotateBody"), danger: true, confirmLabel: t("settings.gsi.rotateConfirm") }}>
              {t("settings.gsi.rotate")}
            </ActionButton>
            <Link to="/settings/setup#step-gsi" className="btn btn-ghost btn-md">
              {t("settings.gsi.rewrite")}
            </Link>
          </div>
        </div>
      </Panel>
      <Panel title={t("settings.backup.title")}>
        <ActionButton
          variant="primary"
          action={async () => {
            const d = await api.download("/api/v1/export/event-package");
            saveBlob(d.blob, d.filename ?? `matchframe-event-${Date.now()}.json`);
            return d;
          }}
          success={t("settings.backup.downloaded")}
        >
          {t("settings.backup.export")}
        </ActionButton>
        <p className="gc-caption">{t("settings.backup.caption")}</p>
        <div className="gc-section">
          <h3 className="gc-section-title">{t("settings.backup.restoreTitle")}</h3>
          <input
            type="file"
            accept=".json,application/json"
            aria-label={t("settings.backup.file")}
            onChange={async (e) => {
              setPreview(null);
              setFileError(null);
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                setPkg(JSON.parse(await f.text()) as Record<string, unknown>);
              } catch {
                setPkg(null);
                setFileError(t("settings.backup.notJson"));
              }
            }}
          />
          {fileError ? <p className="small text-danger">{fileError}</p> : null}
          <div className="form-actions">
            <ActionButton size="sm" action={() => api.post<{ counts: Record<string, number>; collisions: { kind: string; id: string }[]; assets: number }>("/api/v1/import/event-package", { package: pkg, mode: "preview" })} onDone={setPreview} success={t("settings.backup.verified")} disabledReason={settingsReason ?? (pkg ? null : t("settings.backup.chooseFile"))}>
              {t("settings.backup.preview")}
            </ActionButton>
            <ActionButton
              size="sm"
              action={() => api.post("/api/v1/import/event-package", { package: pkg, mode: "commit" })}
              success={t("settings.backup.restored")}
              disabledReason={settingsReason ?? (!preview ? t("settings.backup.previewFirst") : preview.collisions.length ? t("settings.backup.collisions", { count: preview.collisions.length }) : null)}
              confirm={{ title: t("settings.backup.restoreConfirmTitle"), body: t("settings.backup.restoreConfirmBody") }}
            >
              {t("settings.backup.restore")}
            </ActionButton>
          </div>
          <p className="gc-caption">{t("settings.backup.previewCaption")}</p>
          {preview ? (
            <div style={{ marginTop: 10 }}>
              <KV items={[...Object.entries(preview.counts).map(([k, v]) => [k, v] as [string, number]), [t("settings.backup.assetFiles"), preview.assets]]} />
              {preview.collisions.length ? <Note tone="warn">{t("settings.backup.collisionList", { list: preview.collisions.map((c) => `${c.kind} ${c.id}`).join(", ") })}</Note> : <p className="small text-ok">{t("settings.backup.noCollisions")}</p>}
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function StatsTab() {
  const stats = useApi<StatsResponse>("/api/v1/stats/current", { refreshMs: 5000 });
  const report = useApi<BroadcastReport>("/api/v1/reports/broadcast", { refreshMs: 15000 });
  return (
    <div className="stack">
      <Panel
        title={t("settings.stats.title")}
        subtitle={t("settings.stats.subtitle")}
        actions={
          <ActionButton
            size="sm"
            action={async () => {
              const d = await api.download("/api/v1/stats/current.csv");
              saveBlob(d.blob, d.filename ?? "matchframe-stats.csv");
              return d;
            }}
            success={t("settings.stats.csvDownloaded")}
          >
            {t("settings.stats.downloadCsv")}
          </ActionButton>
        }
      >
        <Async state={stats}>
          {(s) => {
            const unavailable = s.metrics.filter((m) => !m.available);
            return (
              <>
                {s.players.length === 0 ? (
                  <EmptyState title={t("settings.stats.noPlayers")}>{t("settings.stats.noPlayersBody")}</EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("settings.stats.player")}</th>
                        <th>{t("settings.stats.side")}</th>
                        <th>K</th>
                        <th>D</th>
                        <th>A</th>
                        <th>MVP</th>
                        <th>{t("settings.stats.score")}</th>
                        <th>ADR</th>
                        <th>KAST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.players.map((p) => (
                        <tr key={p.steamId}>
                          <td>{p.name}</td>
                          <td>{p.side ?? MISSING}</td>
                          <td>{p.kills ?? MISSING}</td>
                          <td>{p.deaths ?? MISSING}</td>
                          <td>{p.assists ?? MISSING}</td>
                          <td>{p.mvps ?? MISSING}</td>
                          <td>{p.score ?? MISSING}</td>
                          <td title={t("settings.stats.needsDamage")}>{p.adr ?? t("settings.stats.na")}</td>
                          <td title={t("settings.stats.needsKills")}>{p.kast ?? t("settings.stats.na")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {unavailable.length ? <p className="gc-caption">{t("settings.stats.notAvailable", { list: unavailable.map((m) => m.label).join(", ") })}</p> : null}
                <Details summary={t("settings.stats.definitions")}>
                  <ul className="list-plain small">
                    {s.metrics.map((m) => (
                      <li key={m.key}>
                        <strong>{m.label}</strong> {m.available ? <span className="text-ok">{t("settings.stats.available")}</span> : <span className="text-warn">{t("settings.stats.unavailable")}</span>}
                        <div className="muted">
                          {m.definition} {m.reason ? `— ${m.reason}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Details>
              </>
            );
          }}
        </Async>
      </Panel>
      <Panel
        title={t("settings.report.title")}
        subtitle={t("settings.report.subtitle")}
        actions={
          <>
            <ActionButton
              size="sm"
              action={async () => {
                const d = await api.download("/api/v1/reports/broadcast?format=html");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.html`);
                return d;
              }}
              success={t("settings.report.htmlDownloaded")}
            >
              {t("settings.report.downloadHtml")}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              action={async () => {
                const d = await api.download("/api/v1/reports/broadcast");
                saveBlob(d.blob, `matchframe-broadcast-report-${Date.now()}.json`);
                return d;
              }}
              success={t("settings.report.jsonDownloaded")}
            >
              {t("settings.report.downloadJson")}
            </ActionButton>
          </>
        }
      >
        <Async state={report}>
          {(r) => (
            <>
              <div className="grid-2">
                <KV
                  items={[
                    [t("settings.report.window"), t("settings.report.windowValue", { count: r.window.decisions, minutes: r.window.minutes })],
                    [t("settings.report.actions"), Object.entries(r.director.actions).map(([k, v]) => `${k} ${v}`).join(" · ") || MISSING],
                    [t("settings.report.automated"), t("settings.report.automatedValue", { total: r.director.automatedCommands, confirmed: r.director.automatedConfirmed, failed: r.director.automatedFailed })],
                    [t("settings.report.shotChanges"), r.continuity.shotChanges],
                    [t("settings.report.cutsPerMinute"), r.continuity.cutsPerMinute ?? MISSING],
                    [t("settings.report.medianShot"), fmtMs(r.continuity.medianShotMs)],
                    [t("settings.report.takeovers"), `${r.control.manualTakeovers} / ${r.control.externalChanges} / ${r.control.emergencyStops}`],
                  ]}
                />
                <div>
                  <h3 className="gc-section-title">{t("settings.report.topReasons")}</h3>
                  <ul className="list-plain small">
                    {r.director.topReasons.slice(0, 8).map(([k, v]) => (
                      <li key={k} className="row" title={k}>
                        {reasonInfo(k).label}
                        <span className="spacer" />
                        <span className="muted">{v}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {r.caveats.map((c, i) => (
                <p key={i} className="gc-caption">
                  {c}
                </p>
              ))}
              <Details summary={t("settings.report.details")}>
                <KV
                  items={[
                    [t("settings.report.generated"), fmtTime(r.generatedAt)],
                    [t("settings.report.source"), r.simulated ? t("settings.report.simulation") : t("settings.report.live")],
                    [t("settings.report.policy"), r.policyVersion],
                    [t("settings.report.p10"), fmtMs(r.continuity.p10ShotMs)],
                    [t("settings.report.outlived"), r.continuity.shotsThatOutlivedTheirPlayer],
                  ]}
                />
              </Details>
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

export type SettingsTabId = "general" | "stats" | "diagnostics" | "logs" | "audit" | "settings";
const SETTINGS_TITLES: Record<SettingsTabId, { title: string }> = perLocale(() => ({
  general: { title: t("settings.titles.general") },
  stats: { title: t("nav.statsReports") },
  diagnostics: { title: t("nav.diagnostics") },
  logs: { title: t("nav.logs") },
  audit: { title: t("nav.auditLog") },
  settings: { title: t("settings.titles.advanced") },
}));

/** One Settings section; the section bar above the page (Shell) switches between them by URL. */
export function SettingsScreen({ tab = "general" }: { tab?: SettingsTabId }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{SETTINGS_TITLES[tab].title}</h1>
      </div>
      {tab === "general" ? <GeneralTab /> : null}
      {tab === "stats" ? <StatsTab /> : null}
      {tab === "diagnostics" ? <DiagnosticsTab /> : null}
      {tab === "logs" ? <LogsTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
    </div>
  );
}
