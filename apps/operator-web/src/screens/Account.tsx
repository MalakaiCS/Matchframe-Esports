import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/index.ts";
import type { CloudStatus, CloudUsageRecord } from "../api/types.ts";
import { SignInForm } from "../components/SignIn.tsx";
import { ActionButton, Async, Badge, Details, EmptyState, Field, KV, Meter, Note, Panel } from "../components/ui.tsx";
import type { Tone } from "../components/ui.tsx";
import { gateView } from "../lib/cloud.ts";
import { fmtAgo, fmtHours, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-a.css";

const LICENCE: Record<string, { tone: Tone; text: string }> = {
  valid: { tone: "ok", text: "Valid" },
  grace: { tone: "warn", text: "Offline grace" },
  expired: { tone: "danger", text: "Expired" },
};

function Website({ st, onChange }: { st: CloudStatus; onChange: () => void }) {
  const reason = usePermission("settings.manage");
  const [url, setUrl] = useState(st.url ?? "");
  useEffect(() => setUrl(st.url ?? ""), [st.url]);
  const signInAsksForUrl = !st.url && !st.device && !reason;
  if (!st.url && (st.urlFixed || signInAsksForUrl)) return null;
  return (
    <div className="ga-section">
      {st.url ? (
        <p className="muted" style={{ margin: 0 }}>
          <a href={st.url} target="_blank" rel="noreferrer" title={st.url}>
            Open the website
          </a>{" "}
          to sign up, choose a plan, buy hours, manage team members or see usage for every computer.
        </p>
      ) : null}
      {st.urlFixed || signInAsksForUrl ? null : (
        <Details summary="Website address">
          <div className="row-end">
            <Field label="Website address" hint="Changing it signs this computer out.">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.matchframe.example" spellCheck={false} style={{ width: 320 }} />
            </Field>
            <ActionButton
              action={() => api.put("/api/v1/cloud/url", { url: url.trim() || null })}
              success="Website address saved"
              onDone={onChange}
              disabledReason={reason ?? (url.trim() === (st.url ?? "") ? "No change" : null)}
              confirm={st.device ? { title: "Change the website address?", body: "This computer is signed out of its current account. You will need to sign in again." } : undefined}
            >
              Save address
            </ActionButton>
          </div>
        </Details>
      )}
    </div>
  );
}

function AccountPanel({ st, onChange }: { st: CloudStatus; onChange: () => void }) {
  const reason = usePermission("settings.manage");
  const user = st.signIn.user;
  return (
    <Panel
      title="Matchframe account"
      actions={st.linkState === "linked" ? <Badge tone="ok">Signed in</Badge> : st.linkState === "linking" ? <Badge tone="info">Waiting for approval</Badge> : st.linkState === "revoked" ? <Badge tone="danger">Signed out on website</Badge> : <Badge>Signed out</Badge>}
    >
      {st.device ? (
        <>
          <KV
            items={[
              ["Signed in as", user ? `${user.displayName} (${user.email})` : MISSING],
              ["Organisation", st.device.orgName],
              ["Signed in", fmtTime(st.device.linkedAt)],
            ]}
          />
          <div className="ga-actions">
            <ActionButton action={() => api.post("/api/v1/cloud/refresh")} success="Licence refreshed and usage uploaded" onDone={onChange} disabledReason={reason}>
              Refresh now
            </ActionButton>
            <ActionButton
              variant="ghost"
              action={() => api.post("/api/v1/cloud/unlink")}
              success="Signed out"
              onDone={onChange}
              disabledReason={reason}
              confirm={{
                title: "Sign out of Matchframe?",
                body: st.signIn.required
                  ? "Pending usage is uploaded first. The program keeps running until you close it; the next time it opens it asks you to sign in."
                  : "Pending usage is uploaded first. Automatic direction on live matches stops being available until you sign in again; HUDs and manual control keep working.",
                danger: true,
              }}
            >
              Sign out
            </ActionButton>
          </div>
          <Details summary="Computer details">
            <KV
              items={[
                ["Computer id", <code key="id">{st.device.deviceId}</code>],
                ["Licence refreshed", st.lastRefreshAt ? fmtAgo(st.lastRefreshAt) : "not yet in this session"],
                ["Usage uploaded", st.lastSyncAt ? fmtAgo(st.lastSyncAt) : "not yet in this session"],
              ]}
            />
          </Details>
        </>
      ) : reason ? (
        <p>{reason}. Sign in on the production computer.</p>
      ) : (
        <SignInForm status={st} onSignedIn={onChange} onChange={onChange} />
      )}
      {st.lastError ? (
        <Note tone="warn" title="Last problem">
          {st.lastError}
        </Note>
      ) : null}
      <Website st={st} onChange={onChange} />
      {st.enforcement === "off" ? (
        <p className="small muted" style={{ margin: "14px 0 0" }} title="MATCHFRAME_CLOUD_ENFORCEMENT=off. Release builds require signing in.">
          Development build: automatic direction can be armed without an account.
        </p>
      ) : !st.signIn.required ? (
        <p className="small muted" style={{ margin: "14px 0 0" }} title="MATCHFRAME_SIGN_IN=off (development only).">
          Development build: signing in is not required for the Auto Director.
        </p>
      ) : null}
    </Panel>
  );
}

function HoursPanel({ st }: { st: CloudStatus }) {
  const ent = st.entitlement;
  const gate = gateView(st.gate, st.enforcement);
  const badge = <Badge tone={gate.tone}>{gate.text}</Badge>;
  if (!ent)
    return (
      <Panel title="Plan and hours" actions={badge}>
        <EmptyState title="No licence on this computer">Sign in to see the plan and auto-director hours.</EmptyState>
      </Panel>
    );
  const ad = ent.autoDirector;
  const total = ad.includedSeconds + ad.creditSeconds;
  const lic = LICENCE[ent.state] ?? { tone: "danger" as Tone, text: ent.state };
  const licBadge = (
    <Badge key="lic" tone={lic.tone}>
      {lic.text}
    </Badge>
  );
  return (
    <Panel title="Plan and hours" actions={badge}>
      <div className="hours-big">
        <span className="hours-value">{fmtHours(Math.max(0, ent.localRemainingSeconds))}</span>
        <span className="muted"> of auto-director time left this period</span>
      </div>
      <div style={{ margin: "8px 0 12px" }}>
        <Meter value={Math.max(0, total - ent.localRemainingSeconds)} max={Math.max(1, total)} tone={ent.localRemainingSeconds <= 0 ? "danger" : ent.localRemainingSeconds < 1800 ? "warn" : "accent"} label="Hours used" />
      </div>
      <KV
        items={[
          ["Plan", `${ent.plan.name}${ent.subscriptionStatus !== "none" ? ` (${ent.subscriptionStatus.replace("_", " ")})` : ""}`],
          ["Period", `${fmtTime(ad.periodStart)} – ${fmtTime(ad.periodEnd)}`],
          ["Works offline until", fmtTime(ent.graceUntil)],
          ...(ent.state !== "valid" ? ([["Licence", licBadge]] as [string, ReactNode][]) : []),
        ]}
      />
      {!st.gate.ok ? (
        <Note tone={gate.tone === "danger" ? "danger" : "warn"} title="Automatic direction cannot be armed">
          {st.gate.reason}
        </Note>
      ) : null}
      <Details summary="Breakdown">
        <KV
          items={[
            ["Included this period", fmtHours(ad.includedSeconds)],
            ["Hour-pack and support credits", fmtHours(ad.creditSeconds)],
            ["Used (all computers, as of the licence)", fmtHours(ad.usedSeconds)],
            ["Used here since then", fmtHours(ad.remainingSeconds - ent.localRemainingSeconds)],
            ["Licence", licBadge],
          ]}
        />
      </Details>
      <Details summary="How hours are counted">
        <p className="muted small">
          An hour counts only while the Observer (Observer, Observer &amp; Cinematics or Full Action Observer) actually controls a real camera on live telemetry, at the same rate in every mode. Observer Off, manual camera work, the simulation, stale telemetry and time with no camera control connected are free. Full Action Observer (nade cameras) needs a plan that includes it. Running out never stops a map in progress: automation hands back to manual at the next map change, and re-arming is blocked until hours are added.
        </p>
      </Details>
    </Panel>
  );
}

function UploadState({ r }: { r: CloudUsageRecord }) {
  if (r.rejectedReason)
    return (
      <span className="text-danger" title={r.rejectedReason}>
        Not counted
      </span>
    );
  return r.uploadedAt ? <span className="muted">Uploaded</span> : <span>Pending</span>;
}

function UsagePanel({ st }: { st: CloudStatus }) {
  const records = useApi<{ records: CloudUsageRecord[] }>("/api/v1/cloud/usage?limit=50", { refreshMs: 15000 });
  const empty = <p className="muted">No automatic direction recorded yet.</p>;
  return (
    <Panel
      title="Automatic direction on this computer"
      actions={
        st.usage.metering ? (
          <Badge tone="info" icon="●">
            Metering
          </Badge>
        ) : null
      }
      subtitle={st.usage.pendingRecords || st.usage.openSeconds ? `${st.usage.pendingRecords} waiting to upload (${fmtHours(st.usage.pendingSeconds)}) · ${fmtHours(st.usage.openSeconds)} in the current segment` : undefined}
    >
      <Async state={records} empty={empty}>
        {(d) =>
          d.records.length === 0 ? (
            empty
          ) : (
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Map</th>
                    <th>Duration</th>
                    <th>Upload</th>
                  </tr>
                </thead>
                <tbody>
                  {d.records.map((r) => (
                    <tr key={r.recordId}>
                      <td>{fmtTime(r.startedAt)}</td>
                      <td>{r.mapName ?? MISSING}</td>
                      <td>{fmtHours(r.seconds)}</td>
                      <td>
                        <UploadState r={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </Panel>
  );
}

export function AccountScreen() {
  const status = useApi<CloudStatus>("/api/v1/cloud/status", { refreshMs: 3000 });
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Account & Hours</h1>
      </div>
      <p className="page-intro">Your Matchframe sign-in and the auto-director hours this computer uses.</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            <div className="grid-2">
              <AccountPanel st={st} onChange={() => void status.reload()} />
              <HoursPanel st={st} />
            </div>
            <UsagePanel st={st} />
          </div>
        )}
      </Async>
    </div>
  );
}
