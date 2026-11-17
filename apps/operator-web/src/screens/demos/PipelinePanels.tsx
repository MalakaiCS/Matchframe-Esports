import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import type { CloudStorageStatus, DemoConfigResponse, PythonCheck, PythonStatus } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, Field, KV, Note } from "../../components/ui.tsx";
import { fmtBytes, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

/** Python for the demo pipeline: set up from here into the program's data folder. */
export function PythonPanel({ onChange }: { onChange: () => void }) {
  const reason = usePermission("demos.manage");
  const st = useApi<PythonStatus>("/api/v1/demos/python", { refreshMs: 3000 });
  const [check, setCheck] = useState<PythonCheck | null>(null);
  const [path, setPath] = useState("");
  const running = st.data?.setup.state === "running";
  useEffect(() => {
    if (st.data?.setup.state === "done") onChange();
  }, [st.data?.setup.state, onChange]);
  return (
    <Async state={st}>
      {(p) => (
        <>
          <div className="row">
            {p.available ? <Badge tone="ok">{t("demos.ready")}</Badge> : <Badge tone="warn">{t("demos.notSetUp")}</Badge>}
            <span className="small muted mono">{p.interpreter ?? t("demos.noPythonChosen")}</span>
          </div>
          <p className="small muted"><T k="demos.readingDemosNeedsPython3" values={{ span: <span className="mono">{p.envDir}</span> }} tags={{ b: (c) => <b>{c}</b> }} /></p>
          {p.setup.state === "failed" ? <Note tone="warn" title={t("demos.setupFailed")}>{p.setup.error}</Note> : null}
          {running || p.setup.log.length ? (
            <Details summary={running ? `${p.setup.step ?? "Working"}…` : t("demos.lastSetupStateV", { state: p.setup.state, v: p.setup.finishedAt ? ` · ${fmtTime(p.setup.finishedAt)}` : "" })} open={running}>
              <pre className="small mono gc-log">{p.setup.log.slice(-10).join("\n")}</pre>
            </Details>
          ) : null}
          {check ? (
            check.ok ? (
              <Note tone="ok">{t("demos.pythonPythonWithEveryPackage", { python: check.python, join: Object.entries(check.packages).map(([k, v]) => `${k} ${v}`).join(", ") })}</Note>
            ) : (
              <Note tone="warn">{t("demos.pythonPythonVMissingV2", { python: check.python, v: check.python_ok ? "" : t("demos.text311OrNewerNeeded"), v2: check.missing.join(", ") || t("demos.nothing") })}</Note>
            )
          ) : null}
          <div className="form-actions">
            <ActionButton variant="primary" action={() => api.post<PythonStatus["setup"]>("/api/v1/demos/python/setup")} success={t("demos.settingUpPython")} onDone={() => void st.reload()} disabledReason={reason ?? (running ? t("demos.setupIsRunning") : null)}>
              {p.available ? t("demos.setUpAgain") : t("demos.setUpPython")}
            </ActionButton>
            <ActionButton action={() => api.post<PythonCheck>("/api/v1/demos/python/check")} success={(r) => (r.ok ? t("demos.pythonIsReady") : t("demos.packagesMissing"))} onDone={(r) => setCheck(r ?? null)} disabledReason={reason ?? (p.available ? null : t("demos.setUpPythonFirst"))}>{t("demos.check")}</ActionButton>
          </div>
          <Details summary={t("demos.useAnotherPython")}>
            <div className="row-end">
              <Field label={t("demos.pythonInterpreterPythonExe")}>
                <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\Python312\\python.exe" />
              </Field>
              <ActionButton size="sm" action={() => api.put("/api/v1/demos/python", { path: path.trim() || null })} success={t("demos.pythonInterpreterSaved")} onDone={() => { void st.reload(); onChange(); }} disabledReason={reason}>
                {path.trim() ? t("demos.useThisPython") : t("demos.useTheProgramSOwn")}
              </ActionButton>
            </div>
          </Details>
        </>
      )}
    </Async>
  );
}

/** FTP storage: each dataset uploaded with its POV labels, then the demo removed if chosen. */
export function CloudStoragePanel({ demos, onConfigChange }: { demos: DemoConfigResponse | null; onConfigChange: () => void }) {
  const reason = usePermission("demos.manage");
  const st = useApi<CloudStorageStatus>("/api/v1/demos/cloud-storage", { refreshMs: 5000 });
  const [form, setForm] = useState({ host: "", port: 21, username: "", password: "", remoteDir: "/matchframe", secure: "ftps" as "ftps" | "plain" });
  const loaded = st.data?.settings;
  useEffect(() => {
    if (loaded) setForm((f) => ({ ...f, host: loaded.host, port: loaded.port, username: loaded.username, remoteDir: loaded.remoteDir, secure: loaded.secure, password: "" }));
  }, [loaded?.host, loaded?.port, loaded?.username, loaded?.remoteDir, loaded?.secure]);
  const removeAfterUpload = demos?.config.retention.policy === "remove_after_upload";
  const save = () => api.put<CloudStorageStatus>("/api/v1/demos/cloud-storage", { host: form.host.trim(), port: form.port, username: form.username.trim(), remoteDir: form.remoteDir.trim() || "/matchframe", secure: form.secure, ...(form.password ? { password: form.password } : {}) });
  return (
    <Async state={st}>
      {(s) => (
        <>
          <p className="small muted">{t("demos.eachDemoSDataRounds")}</p>
          <div className="grid-2">
            <div className="gc-form">
              <Field label={t("demos.serverAddress")}>
                <input className="mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={t("demos.text174001Or")} />
              </Field>
              <Field label={t("demos.port")}>
                <input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 21 })} />
              </Field>
              <Field label={t("demos.userName")}>
                <input className="mono" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
              </Field>
              <Field label={t("demos.password")} hint={s.hasPassword ? t("demos.savedEncryptedOnThisComputer2") : t("demos.savedEncryptedOnThisComputer")}>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={s.hasPassword ? "••••••••" : ""} autoComplete="new-password" />
              </Field>
            </div>
            <div className="gc-form">
              <Field label={t("demos.folderOnTheServer")}>
                <input className="mono" value={form.remoteDir} onChange={(e) => setForm({ ...form, remoteDir: e.target.value })} />
              </Field>
              <Field label={t("demos.connection")} hint={form.secure === "plain" ? t("demos.unencryptedThePasswordAndThe") : t("demos.encryptedFtpFtpsTheServer")}>
                <select value={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.value as "ftps" | "plain" })}>
                  <option value="ftps">{t("demos.encryptedFtps")}</option>
                  <option value="plain">{t("demos.unencryptedFtp")}</option>
                </select>
              </Field>
              <KV
                items={[
                  [t("demos.uploaded"), `${t("editor.count.matches", { count: s.uploaded })} · ${fmtBytes(s.uploadedBytes)}`],
                  [t("demos.waiting"), String(s.pending)],
                  [t("demos.now"), s.current ? `${s.current.step === "features" ? t("demos.buildingPovLabels") : t("demos.uploading")} · ${Math.round(s.current.progress * 100)}%` : "—"],
                  [t("demos.certificate"), s.settings.fingerprint ? t("demos.trustedSlice", { slice: s.settings.fingerprint.slice(0, 16) }) : s.settings.secure === "ftps" ? t("demos.trustedAtTheFirstTest") : t("demos.noneUnencrypted")],
                ]}
              />
            </div>
          </div>
          {s.lastError ? (
            <Note tone="warn" title={t("demos.lastUploadFailed")}>
              {s.lastError.message}
              {s.nextTryAt ? t("demos.tryingAgainNexttryat", { nextTryAt: fmtTime(s.nextTryAt) }) : ""}
            </Note>
          ) : null}
          <Checkbox checked={s.settings.enabled} onChange={(v) => void api.put("/api/v1/demos/cloud-storage", { enabled: v }).then(() => st.reload())} disabled={!!reason || !s.settings.host || !s.hasPassword} label={t("demos.uploadDatasetsAutomatically")} hint={t("demos.oneAtATimeNever")} />
          <Checkbox
            checked={removeAfterUpload}
            disabled={!!reason || !demos}
            onChange={(v) => {
              if (!demos) return;
              void api.put("/api/v1/demos/config", { retention: { ...demos.config.retention, policy: v ? "remove_after_upload" : "quarantine_then_remove" } }).then(onConfigChange);
            }}
            label={t("demos.deleteEachDemoOnceIts")}
            hint={t("demos.forDemosDroppedIntoThe", { v: demos?.config.retention.quarantineDays ?? 7 })}
          />
          <div className="form-actions">
            <ActionButton variant="primary" action={save} success={t("demos.storageSettingsSaved")} onDone={() => { setForm((f) => ({ ...f, password: "" })); void st.reload(); }} disabledReason={reason ?? (form.host.trim() && form.username.trim() ? null : t("demos.enterTheAddressAndUser"))}>{t("demos.save")}</ActionButton>
            <ActionButton action={async () => { await save(); return api.post<{ secure: boolean; fingerprint: string | null }>("/api/v1/demos/cloud-storage/test"); }} success={(r) => (r.secure ? t("demos.connectedEncryptedTestFileWritten") : t("demos.connectedUnencryptedTestFileWritten"))} onDone={() => { setForm((f) => ({ ...f, password: "" })); void st.reload(); }} disabledReason={reason ?? (form.host.trim() && form.username.trim() ? null : t("demos.enterTheAddressAndUser"))}>{t("demos.saveAndTestConnection")}</ActionButton>
            <ActionButton size="sm" variant="ghost" action={() => api.post<CloudStorageStatus>("/api/v1/demos/cloud-storage/upload-now")} success={t("demos.uploadStarted")} onDone={() => void st.reload()} disabledReason={reason ?? (s.settings.enabled ? null : t("demos.turnOnAutomaticUploadsFirst"))}>{t("demos.uploadNow")}</ActionButton>
            {s.settings.fingerprint ? (
              <ActionButton size="sm" variant="ghost" action={() => api.post<CloudStorageStatus>("/api/v1/demos/cloud-storage/forget-certificate")} success={t("demos.certificateForgottenTheNextTest")} onDone={() => void st.reload()} disabledReason={reason} confirm={{ title: t("demos.trustANewCertificate"), body: t("demos.onlyIfYouKnowThe"), confirmLabel: t("demos.forgetCertificate") }}>{t("demos.forgetCertificate")}</ActionButton>
            ) : null}
          </div>
        </>
      )}
    </Async>
  );
}
