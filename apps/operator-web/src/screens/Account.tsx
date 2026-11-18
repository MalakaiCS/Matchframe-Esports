import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, describeError } from "../api/index.ts";
import type { CloudStatus, CloudSyncStatus, CloudUsageRecord } from "../api/types.ts";
import { SignInForm } from "../components/SignIn.tsx";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Async, Badge, Details, EmptyState, Field, KV, Meter, Note, Panel } from "../components/ui.tsx";
import type { Tone } from "../components/ui.tsx";
import { gateView } from "../lib/cloud.ts";
import { fmtAgo, fmtHours, fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { countsText, storageText, syncedAgo } from "../lib/sync.ts";
import { usePermission } from "../state/session.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-a.css";

const LICENCE: Record<string, { tone: Tone; text: string }> = perLocale(() => ({
  valid: { tone: "ok", text: t("account.valid") },
  grace: { tone: "warn", text: t("account.offlineGrace") },
  expired: { tone: "danger", text: t("account.expired") },
}));

/** The billing provider's subscription state, in words; an unknown state shows as sent. */
function subscriptionText(status: string): string {
  const key = `account.subscription.${status}`;
  const text = t(key);
  return text === key ? status.replace(/_/g, " ") : text;
}

function Website({ st, onChange }: { st: CloudStatus; onChange: () => void }) {
  const reason = usePermission("settings.manage");
  const [url, setUrl] = useState(st.url ?? "");
  useEffect(() => setUrl(st.url ?? ""), [st.url]);
  const signInAsksForUrl = !st.url && !st.device && !reason;
  if (!st.url && (st.urlFixed || signInAsksForUrl)) return null;
  return (
    <div className="ga-section">
      {st.url ? (
        <p className="muted" style={{ margin: 0 }}><T k="account.openTheWebsiteToSign" tags={{ link: (c) => <a href={st.url ?? undefined} target="_blank" rel="noreferrer" title={st.url ?? undefined}>{c}</a> }} /></p>
      ) : null}
      {st.urlFixed || signInAsksForUrl ? null : (
        <Details summary={t("account.websiteAddress")}>
          <div className="row-end">
            <Field label={t("account.websiteAddress")} hint={t("account.changingItSignsThisComputer")}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.matchframe.example" spellCheck={false} style={{ width: 320 }} />
            </Field>
            <ActionButton
              action={() => api.put("/api/v1/cloud/url", { url: url.trim() || null })}
              success={t("account.websiteAddressSaved")}
              onDone={onChange}
              disabledReason={reason ?? (url.trim() === (st.url ?? "") ? t("account.noChange") : null)}
              confirm={st.device ? { title: t("account.changeTheWebsiteAddress"), body: t("account.thisComputerIsSignedOut") } : undefined}
            >{t("account.saveAddress")}</ActionButton>
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
      title={t("account.matchframeAccount")}
      actions={st.linkState === "linked" ? <Badge tone="ok">{t("account.signedIn")}</Badge> : st.linkState === "linking" ? <Badge tone="info">{t("account.waitingForApproval")}</Badge> : st.linkState === "revoked" ? <Badge tone="danger">{t("account.signedOutOnWebsite")}</Badge> : <Badge>{t("account.signedOut")}</Badge>}
    >
      {st.device ? (
        <>
          <KV
            items={[
              [t("account.signedInAs"), user ? `${user.displayName} (${user.email})` : MISSING],
              [t("account.organisation"), st.device.orgName],
              [t("account.signedIn"), fmtTime(st.device.linkedAt)],
            ]}
          />
          <div className="ga-actions">
            <ActionButton action={() => api.post("/api/v1/cloud/refresh")} success={t("account.licenceRefreshedAndUsageUploaded")} onDone={onChange} disabledReason={reason}>{t("account.refreshNow")}</ActionButton>
            <ActionButton
              variant="ghost"
              action={() => api.post("/api/v1/cloud/unlink")}
              success={t("account.signedOut")}
              onDone={onChange}
              disabledReason={reason}
              confirm={{
                title: t("account.signOutOfMatchframe"),
                body: st.signIn.required
                  ? t("account.pendingUsageIsUploadedFirst2")
                  : t("account.pendingUsageIsUploadedFirst"),
                danger: true,
              }}
            >{t("account.signOut")}</ActionButton>
          </div>
          <Details summary={t("account.computerDetails")}>
            <KV
              items={[
                [t("account.computerId"), <code key="id">{st.device.deviceId}</code>],
                [t("account.licenceRefreshed"), st.lastRefreshAt ? fmtAgo(st.lastRefreshAt) : t("account.notYetInThisSession")],
                [t("account.usageUploaded"), st.lastSyncAt ? fmtAgo(st.lastSyncAt) : t("account.notYetInThisSession")],
              ]}
            />
          </Details>
        </>
      ) : reason ? (
        <p>{t("account.reasonSignInOnThe", { reason })}</p>
      ) : (
        <SignInForm status={st} onSignedIn={onChange} onChange={onChange} />
      )}
      {st.lastError ? (
        <Note tone="warn" title={t("account.lastProblem")}>
          {st.lastError}
        </Note>
      ) : null}
      <Website st={st} onChange={onChange} />
      {st.enforcement === "off" ? (
        <p className="small muted" style={{ margin: "14px 0 0" }} title={t("account.matchframeCloudEnforcementOffRelease")}>{t("account.developmentBuildAutomaticDirectionCan")}</p>
      ) : !st.signIn.required ? (
        <p className="small muted" style={{ margin: "14px 0 0" }} title={t("account.matchframeSignInOffDevelopment")}>{t("account.developmentBuildSigningInIs")}</p>
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
      <Panel title={t("account.planAndHours")} actions={badge}>
        <EmptyState title={t("account.noLicenceOnThisComputer")}>{t("account.signInToSeeThe")}</EmptyState>
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
    <Panel title={t("account.planAndHours")} actions={badge}>
      <div className="hours-big">
        <span className="hours-value">{fmtHours(Math.max(0, ent.localRemainingSeconds))}</span>
        <span className="muted">{t("account.ofAutoDirectorTimeLeft")}</span>
      </div>
      <div style={{ margin: "8px 0 12px" }}>
        <Meter value={Math.max(0, total - ent.localRemainingSeconds)} max={Math.max(1, total)} tone={ent.localRemainingSeconds <= 0 ? "danger" : ent.localRemainingSeconds < 1800 ? "warn" : "accent"} label={t("account.hoursUsed")} />
      </div>
      <KV
        items={[
          [t("account.plan"), `${ent.plan.name}${ent.subscriptionStatus !== "none" ? ` (${subscriptionText(ent.subscriptionStatus)})` : ""}`],
          [t("account.period"), `${fmtTime(ad.periodStart)} – ${fmtTime(ad.periodEnd)}`],
          [t("account.worksOfflineUntil"), fmtTime(ent.graceUntil)],
          ...(ent.state !== "valid" ? ([[t("account.licence"), licBadge]] as [string, ReactNode][]) : []),
        ]}
      />
      {!st.gate.ok ? (
        <Note tone={gate.tone === "danger" ? "danger" : "warn"} title={t("account.automaticDirectionCannotBeArmed")}>
          {st.gate.reason}
        </Note>
      ) : null}
      <Details summary={t("account.breakdown")}>
        <KV
          items={[
            [t("account.includedThisPeriod"), fmtHours(ad.includedSeconds)],
            [t("account.hourPackAndSupportCredits"), fmtHours(ad.creditSeconds)],
            [t("account.usedAllComputersAsOf"), fmtHours(ad.usedSeconds)],
            [t("account.usedHereSinceThen"), fmtHours(ad.remainingSeconds - ent.localRemainingSeconds)],
            [t("account.licence"), licBadge],
          ]}
        />
      </Details>
      <Details summary={t("account.howHoursAreCounted")}>
        <p className="muted small">{t("account.anHourCountsOnlyWhile")}</p>
      </Details>
    </Panel>
  );
}

/** Account sync: teams, players, matches and imported HUDs shared by every computer of the organisation. */
export function SharedPanel() {
  const reason = usePermission("settings.manage");
  const toast = useToast();
  const sync = useApi<CloudSyncStatus>("/api/v1/cloud/sync", { refreshMs: 2000 });
  const [switching, setSwitching] = useState(false);
  const s = sync.data;
  if (!s?.linked) return null;
  const toggle = async () => {
    setSwitching(true);
    try {
      sync.setData(await api.post<CloudSyncStatus>("/api/v1/cloud/sync", { enabled: !s.enabled }));
    } catch (e) {
      toast.push("danger", t("account.couldNotChangeSharing"), describeError(e));
    } finally {
      setSwitching(false);
    }
  };
  const line = s.busy ? `${s.busy}…` : s.state === "starting" ? t("account.gettingYourOrganisationSData") : syncedAgo(s.lastSyncAt);
  return (
    <Panel
      title={t("account.sharedWithV", { v: s.orgName ?? t("account.yourOrganisation") })}
      actions={
        <button type="button" role="switch" aria-checked={s.enabled} aria-label={t("account.shareWithTheOrganisation")} className={`switch ${s.enabled ? "is-on" : ""}`} disabled={!!reason || switching} title={reason ?? (s.enabled ? t("account.sharingIsOnClickTo") : t("account.sharingIsOffClickTo"))} onClick={() => void toggle()}>
          <span className="switch-label">{s.enabled ? t("account.on") : t("account.off")}</span>
          <span className="switch-track" aria-hidden>
            <span className="switch-thumb" />
          </span>
        </button>
      }
    >
      {s.enabled ? (
        <>
          <p className="sync-line">{line}</p>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {countsText(s.counts)}
          </p>
          {s.pending > 0 ? (
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              {t("account.changesWaiting", { count: s.pending })}
            </p>
          ) : null}
          {s.storage ? (
            <div className="sync-storage">
              <Meter value={s.storage.usedBytes} max={Math.max(1, s.storage.quotaBytes)} tone={s.storage.usedBytes >= s.storage.quotaBytes * 0.9 ? "warn" : "accent"} label={t("account.sharedStorage")} />
              <span className="small muted">{storageText(s.storage.usedBytes, s.storage.quotaBytes)}</span>
            </div>
          ) : null}
          {s.lastError ? (
            <Note tone="warn" title={t("account.lastProblem")}>
              {s.lastError}
            </Note>
          ) : null}
          <div className="ga-actions">
            <ActionButton action={() => api.post<CloudSyncStatus>("/api/v1/cloud/sync/now")} success={(r) => (r.lastError ? null : t("account.everythingIsShared"))} onDone={(r) => sync.setData(r)} disabledReason={reason}>{t("account.syncNow")}</ActionButton>
          </div>
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>{t("account.sharingIsOffOnThis")}</p>
      )}
      <Details summary={t("account.whatIsShared")}>
        <p className="muted small">{t("account.teamsPlayersRostersEventsAnd")}</p>
      </Details>
    </Panel>
  );
}

function UploadState({ r }: { r: CloudUsageRecord }) {
  if (r.rejectedReason)
    return (
      <span className="text-danger" title={r.rejectedReason}>{t("account.notCounted")}</span>
    );
  return r.uploadedAt ? <span className="muted">{t("account.uploaded")}</span> : <span>{t("account.pending")}</span>;
}

function UsagePanel({ st }: { st: CloudStatus }) {
  const records = useApi<{ records: CloudUsageRecord[] }>("/api/v1/cloud/usage?limit=50", { refreshMs: 15000 });
  const empty = <p className="muted">{t("account.noAutomaticDirectionRecordedYet")}</p>;
  return (
    <Panel
      title={t("account.automaticDirectionOnThisComputer")}
      actions={
        st.usage.metering ? (
          <Badge tone="info" icon="●">{t("account.metering")}</Badge>
        ) : null
      }
      subtitle={st.usage.pendingRecords || st.usage.openSeconds ? t("account.pendingrecordsWaitingToUploadPendingseco", { pendingRecords: st.usage.pendingRecords, pendingSeconds: fmtHours(st.usage.pendingSeconds), openSeconds: fmtHours(st.usage.openSeconds) }) : undefined}
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
                    <th>{t("account.started")}</th>
                    <th>{t("account.map")}</th>
                    <th>{t("account.duration")}</th>
                    <th>{t("account.upload")}</th>
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
        <h1 className="page-title">{t("account.accountHours")}</h1>
      </div>
      <p className="page-intro">{t("account.yourMatchframeSignInAnd")}</p>
      <Async state={status}>
        {(st) => (
          <div className="stack">
            <div className="grid-2">
              <AccountPanel st={st} onChange={() => void status.reload()} />
              <HoursPanel st={st} />
            </div>
            {st.device ? <SharedPanel /> : null}
            <UsagePanel st={st} />
          </div>
        )}
      </Async>
    </div>
  );
}
