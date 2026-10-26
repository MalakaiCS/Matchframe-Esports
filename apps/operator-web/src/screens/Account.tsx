import { useEffect, useState } from "react";
import { api } from "../api/index.ts";
import type { CloudStatus, CloudUsageRecord } from "../api/types.ts";
import { ActionButton, Async, Badge, EmptyState, Field, KV, Meter, Note, Panel } from "../components/ui.tsx";
import type { Tone } from "../components/ui.tsx";
import { gateView } from "../lib/cloud.ts";
import { fmtAgo, fmtHours, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { usePermission } from "../state/session.tsx";

const LICENCE: Record<string, { tone: Tone; text: string }> = {
  valid: { tone: "ok", text: "VALID" },
  grace: { tone: "warn", text: "OFFLINE GRACE" },
  expired: { tone: "danger", text: "EXPIRED" },
};

function WebsitePanel({ st, onChange }: { st: CloudStatus; onChange: () => void }) {
  const reason = usePermission("settings.manage");
  const [url, setUrl] = useState(st.url ?? "");
  useEffect(() => setUrl(st.url ?? ""), [st.url]);
  return (
    <Panel title="Matchframe website" subtitle="Signup, billing, plans, team members and hour packs are managed on the website.">
      {st.urlFixed ? (
        <KV items={[["Address", st.url]]} />
      ) : (
        <div className="form-grid">
          <Field label="Website address" hint="Changing it unlinks this computer.">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.matchframe.example" spellCheck={false} />
          </Field>
          <div>
            <ActionButton
              variant="secondary"
              action={() => api.put("/api/v1/cloud/url", { url: url.trim() || null })}
              success="Website address saved"
              onDone={onChange}
              disabledReason={reason ?? (url.trim() === (st.url ?? "") ? "No change" : null)}
              confirm={st.device ? { title: "Change the website address?", body: "This computer is unlinked from its current account. You will need to link it again." } : undefined}
            >
              Save address
            </ActionButton>
          </div>
        </div>
      )}
      {st.url ? (
        <p className="muted">
          <a href={st.url} target="_blank" rel="noreferrer">
            Open the website
          </a>{" "}
          to sign up, choose a plan, buy hours or see usage for every computer.
        </p>
      ) : null}
    </Panel>
  );
}

function LinkPanel({ st, onChange }: { st: CloudStatus; onChange: () => void }) {
  const reason = usePermission("settings.manage");
  const [name, setName] = useState("");
  const needUrl = !st.url ? "Set the website address first" : null;
  return (
    <Panel
      title="This computer"
      actions={st.linkState === "linked" ? <Badge tone="ok">LINKED</Badge> : st.linkState === "linking" ? <Badge tone="info">WAITING FOR APPROVAL</Badge> : st.linkState === "revoked" ? <Badge tone="danger">UNLINKED ON WEBSITE</Badge> : <Badge>NOT LINKED</Badge>}
    >
      {st.linkState === "linking" && st.linking ? (
        <div className="stack">
          <p>
            On the website, open <strong>Link a computer</strong> and enter this code, or open the link below and approve it:
          </p>
          <div className="link-code" aria-label="Link code">
            {st.linking.userCode}
          </div>
          <p>
            <a href={st.linking.verificationUriComplete} target="_blank" rel="noreferrer">
              {st.linking.verificationUriComplete}
            </a>
          </p>
          <p className="muted">The code expires {fmtTime(st.linking.expiresAt)}. This page updates by itself once the website approves.</p>
          <div>
            <ActionButton variant="secondary" action={() => api.post("/api/v1/cloud/link/cancel")} onDone={onChange} disabledReason={reason}>
              Cancel
            </ActionButton>
          </div>
        </div>
      ) : st.device ? (
        <div className="stack">
          <KV
            items={[
              ["Organisation", st.device.orgName],
              ["Computer id", <code key="id">{st.device.deviceId}</code>],
              ["Linked", fmtTime(st.device.linkedAt)],
              ["Licence refreshed", st.lastRefreshAt ? fmtAgo(st.lastRefreshAt) : "not yet in this session"],
              ["Usage uploaded", st.lastSyncAt ? fmtAgo(st.lastSyncAt) : "not yet in this session"],
            ]}
          />
          <div className="row">
            <ActionButton variant="secondary" action={() => api.post("/api/v1/cloud/refresh")} success="Licence refreshed and usage uploaded" onDone={onChange} disabledReason={reason}>
              Refresh now
            </ActionButton>
            <ActionButton
              variant="danger"
              action={() => api.post("/api/v1/cloud/unlink")}
              success="Computer unlinked"
              onDone={onChange}
              disabledReason={reason}
              confirm={{ title: "Unlink this computer?", body: "Pending usage is uploaded first. Automatic direction on live matches stops being available until you link again; HUDs and manual control keep working." }}
            >
              Unlink
            </ActionButton>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>Link this computer to your Matchframe account to use automatic direction on live matches. You approve the link on the website; no password is typed here.</p>
          <Field label="Name shown on the website" hint="Defaults to this computer's name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Observer PC" maxLength={80} />
          </Field>
          <div>
            <ActionButton variant="primary" action={() => api.post("/api/v1/cloud/link/start", name.trim() ? { deviceName: name.trim() } : {})} onDone={onChange} disabledReason={reason ?? needUrl}>
              Link this computer
            </ActionButton>
          </div>
        </div>
      )}
      {st.lastError ? (
        <Note tone="warn" title="Last problem">
          {st.lastError}
        </Note>
      ) : null}
    </Panel>
  );
}

function HoursPanel({ st }: { st: CloudStatus }) {
  const ent = st.entitlement;
  const gate = gateView(st.gate, st.enforcement);
  if (!ent)
    return (
      <Panel title="Plan and auto-director hours" actions={<Badge tone={gate.tone}>{gate.text}</Badge>}>
        <EmptyState title="No licence on this computer">Link this computer to see its plan and hours. HUDs, manual and advisory direction, and the simulation never need an account.</EmptyState>
      </Panel>
    );
  const ad = ent.autoDirector;
  const total = ad.includedSeconds + ad.creditSeconds;
  const lic = LICENCE[ent.state] ?? { tone: "danger" as Tone, text: ent.state.toUpperCase() };
  return (
    <Panel title="Plan and auto-director hours" actions={<Badge tone={gate.tone}>{gate.text}</Badge>}>
      <div className="stack">
        <div className="hours-big">
          <span className="hours-value">{fmtHours(Math.max(0, ent.localRemainingSeconds))}</span>
          <span className="muted"> left this period</span>
        </div>
        <Meter value={Math.max(0, total - ent.localRemainingSeconds)} max={Math.max(1, total)} tone={ent.localRemainingSeconds <= 0 ? "danger" : ent.localRemainingSeconds < 1800 ? "warn" : "accent"} label="Hours used" />
        <KV
          items={[
            ["Plan", `${ent.plan.name}${ent.subscriptionStatus !== "none" ? ` (${ent.subscriptionStatus.replace("_", " ")})` : ""}`],
            ["Included this period", fmtHours(ad.includedSeconds)],
            ["Hour-pack and support credits", fmtHours(ad.creditSeconds)],
            ["Used (all computers, as of the licence)", fmtHours(ad.usedSeconds)],
            ["Used here since then", fmtHours(ad.remainingSeconds - ent.localRemainingSeconds)],
            ["Period", `${fmtTime(ad.periodStart)} – ${fmtTime(ad.periodEnd)}`],
            ["Licence", <Badge key="lic" tone={lic.tone}>{lic.text}</Badge>],
            ["Works offline until", fmtTime(ent.graceUntil)],
          ]}
        />
        {!st.gate.ok ? (
          <Note tone={gate.tone === "danger" ? "danger" : "warn"} title="Automatic direction cannot be armed">
            {st.gate.reason}
          </Note>
        ) : null}
        <p className="muted">
          An hour counts only while automatic or assisted direction actually controls a real camera on live telemetry. Advisory and manual direction, the simulation, stale telemetry and time with no camera control connected are free. Running out never stops a map in progress: automation hands back to manual at the next map change, and re-arming is blocked until hours are added.
        </p>
      </div>
    </Panel>
  );
}

function UsagePanel({ st }: { st: CloudStatus }) {
  const records = useApi<{ records: CloudUsageRecord[] }>("/api/v1/cloud/usage?limit=50", { refreshMs: 15000 });
  return (
    <Panel title="Automatic direction on this computer" actions={st.usage.metering ? <Badge tone="info" icon="●">METERING</Badge> : null} subtitle={`${st.usage.pendingRecords} record(s) waiting to upload (${fmtHours(st.usage.pendingSeconds)}); ${fmtHours(st.usage.openSeconds)} in the current segment.`}>
      <Async state={records} empty={<EmptyState title="No automatic direction recorded yet" />}>
        {(d) =>
          d.records.length === 0 ? (
            <EmptyState title="No automatic direction recorded yet" />
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
                      <td>{r.rejectedReason ? <Badge tone="danger" title={r.rejectedReason}>NOT COUNTED</Badge> : r.uploadedAt ? <Badge tone="ok">UPLOADED</Badge> : <Badge tone="info">PENDING</Badge>}</td>
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
      <p className="page-intro">HUDs, manual and advisory direction, replays and the simulation work without an account or internet. Automatic direction on live matches uses auto-director hours from your Matchframe plan.</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            {st.enforcement === "off" ? <Note tone="info" title="Enforcement is off">This build lets automatic direction arm without an account (MATCHFRAME_CLOUD_ENFORCEMENT=off). Release builds require a linked computer.</Note> : null}
            <div className="grid-2">
              <LinkPanel st={st} onChange={() => void status.reload()} />
              <HoursPanel st={st} />
            </div>
            <div className="grid-2">
              <WebsitePanel st={st} onChange={() => void status.reload()} />
              <UsagePanel st={st} />
            </div>
          </div>
        )}
      </Async>
    </div>
  );
}
