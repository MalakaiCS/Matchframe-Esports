import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import type { CloudStorageStatus, DemoConfigResponse, PythonCheck, PythonStatus } from "../../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, Field, KV, Note } from "../../components/ui.tsx";
import { fmtBytes, fmtTime } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

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
            {p.available ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">Not set up</Badge>}
            <span className="small muted mono">{p.interpreter ?? "No Python chosen"}</span>
          </div>
          <p className="small muted">
            Reading demos needs Python 3.11 or newer with the pipeline's packages. <b>Set up</b> finds Python on this computer and installs the packages into the program's own folder (<span className="mono">{p.envDir}</span>), not into your Python. It takes a few minutes and needs the internet.
          </p>
          {p.setup.state === "failed" ? <Note tone="warn" title="Setup failed">{p.setup.error}</Note> : null}
          {running || p.setup.log.length ? (
            <Details summary={running ? `${p.setup.step ?? "Working"}…` : `Last setup: ${p.setup.state}${p.setup.finishedAt ? ` · ${fmtTime(p.setup.finishedAt)}` : ""}`} open={running}>
              <pre className="small mono gc-log">{p.setup.log.slice(-10).join("\n")}</pre>
            </Details>
          ) : null}
          {check ? (
            check.ok ? (
              <Note tone="ok">Python {check.python} with every package: {Object.entries(check.packages).map(([k, v]) => `${k} ${v}`).join(", ")}.</Note>
            ) : (
              <Note tone="warn">Python {check.python}{check.python_ok ? "" : " (3.11 or newer needed)"}; missing: {check.missing.join(", ") || "nothing"}. Press Set up to install them.</Note>
            )
          ) : null}
          <div className="form-actions">
            <ActionButton variant="primary" action={() => api.post<PythonStatus["setup"]>("/api/v1/demos/python/setup")} success="Setting up Python…" onDone={() => void st.reload()} disabledReason={reason ?? (running ? "Setup is running" : null)}>
              {p.available ? "Set up again" : "Set up Python"}
            </ActionButton>
            <ActionButton action={() => api.post<PythonCheck>("/api/v1/demos/python/check")} success={(r) => (r.ok ? "Python is ready" : "Packages missing")} onDone={(r) => setCheck(r ?? null)} disabledReason={reason ?? (p.available ? null : "Set up Python first")}>
              Check
            </ActionButton>
          </div>
          <Details summary="Use another Python">
            <div className="row-end">
              <Field label="Python interpreter (python.exe)">
                <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\Python312\\python.exe" />
              </Field>
              <ActionButton size="sm" action={() => api.put("/api/v1/demos/python", { path: path.trim() || null })} success="Python interpreter saved" onDone={() => { void st.reload(); onChange(); }} disabledReason={reason}>
                {path.trim() ? "Use this Python" : "Use the program's own"}
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
          <p className="small muted">
            Each demo's data (rounds, kills, positions, utility, and the POV labels: who gets a kill, dies or starts a multi-frag in the next seconds) is uploaded here. That's about 20–40 MB a match instead of a 300 MB demo.
          </p>
          <div className="grid-2">
            <div className="gc-form">
              <Field label="Server address">
                <input className="mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="174.0.0.1 or ftp.example.com" />
              </Field>
              <Field label="Port">
                <input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 21 })} />
              </Field>
              <Field label="User name">
                <input className="mono" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Password" hint={s.hasPassword ? "Saved (encrypted on this computer). Leave empty to keep it." : "Saved encrypted on this computer, never shown again."}>
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={s.hasPassword ? "••••••••" : ""} autoComplete="new-password" />
              </Field>
            </div>
            <div className="gc-form">
              <Field label="Folder on the server">
                <input className="mono" value={form.remoteDir} onChange={(e) => setForm({ ...form, remoteDir: e.target.value })} />
              </Field>
              <Field label="Connection" hint={form.secure === "plain" ? "Unencrypted: the password and the data cross the internet readable. Use only if the server has no FTPS." : "Encrypted FTP (FTPS). The server's certificate is trusted at the first good test and checked after that."}>
                <select value={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.value as "ftps" | "plain" })}>
                  <option value="ftps">Encrypted (FTPS)</option>
                  <option value="plain">Unencrypted FTP</option>
                </select>
              </Field>
              <KV
                items={[
                  ["Uploaded", `${s.uploaded} match${s.uploaded === 1 ? "" : "es"} · ${fmtBytes(s.uploadedBytes)}`],
                  ["Waiting", String(s.pending)],
                  ["Now", s.current ? `${s.current.step === "features" ? "Building POV labels" : "Uploading"} · ${Math.round(s.current.progress * 100)}%` : "—"],
                  ["Certificate", s.settings.fingerprint ? `trusted (${s.settings.fingerprint.slice(0, 16)}…)` : s.settings.secure === "ftps" ? "trusted at the first test" : "none (unencrypted)"],
                ]}
              />
            </div>
          </div>
          {s.lastError ? (
            <Note tone="warn" title="Last upload failed">
              {s.lastError.message}
              {s.nextTryAt ? ` Trying again ${fmtTime(s.nextTryAt)}.` : ""}
            </Note>
          ) : null}
          <Checkbox checked={s.settings.enabled} onChange={(v) => void api.put("/api/v1/demos/cloud-storage", { enabled: v }).then(() => st.reload())} disabled={!!reason || !s.settings.host || !s.hasPassword} label="Upload datasets automatically" hint="One at a time, never during a live broadcast." />
          <Checkbox
            checked={removeAfterUpload}
            disabled={!!reason || !demos}
            onChange={(v) => {
              if (!demos) return;
              void api.put("/api/v1/demos/config", { retention: { ...demos.config.retention, policy: v ? "remove_after_upload" : "quarantine_then_remove" } }).then(onConfigChange);
            }}
            label="Delete each demo once its data is uploaded"
            hint={`For demos dropped into the ingest folder from now on: moved to quarantine once the upload is checked, deleted ${demos?.config.retention.quarantineDays ?? 7} days later (Library settings → quarantine days).`}
          />
          <div className="form-actions">
            <ActionButton variant="primary" action={save} success="Storage settings saved" onDone={() => { setForm((f) => ({ ...f, password: "" })); void st.reload(); }} disabledReason={reason ?? (form.host.trim() && form.username.trim() ? null : "Enter the address and user name")}>
              Save
            </ActionButton>
            <ActionButton action={async () => { await save(); return api.post<{ secure: boolean; fingerprint: string | null }>("/api/v1/demos/cloud-storage/test"); }} success={(r) => (r.secure ? "Connected, encrypted. Test file written and removed." : "Connected (unencrypted). Test file written and removed.")} onDone={() => { setForm((f) => ({ ...f, password: "" })); void st.reload(); }} disabledReason={reason ?? (form.host.trim() && form.username.trim() ? null : "Enter the address and user name")}>
              Save and test connection
            </ActionButton>
            <ActionButton size="sm" variant="ghost" action={() => api.post<CloudStorageStatus>("/api/v1/demos/cloud-storage/upload-now")} success="Upload started" onDone={() => void st.reload()} disabledReason={reason ?? (s.settings.enabled ? null : "Turn on automatic uploads first")}>
              Upload now
            </ActionButton>
            {s.settings.fingerprint ? (
              <ActionButton size="sm" variant="ghost" action={() => api.post<CloudStorageStatus>("/api/v1/demos/cloud-storage/forget-certificate")} success="Certificate forgotten: the next test trusts the server's current one" onDone={() => void st.reload()} disabledReason={reason} confirm={{ title: "Trust a new certificate?", body: "Only if you know the storage server's certificate changed (a new server or a renewed certificate). The next connection test trusts whatever certificate the server shows.", confirmLabel: "Forget certificate" }}>
                Forget certificate
              </ActionButton>
            ) : null}
          </div>
        </>
      )}
    </Async>
  );
}
