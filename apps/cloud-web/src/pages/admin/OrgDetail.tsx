import { useState } from "react";
import type { SubscriptionStatus } from "@matchframe/cloud-contracts";
import { api, describeError } from "../../api/index.ts";
import type { AdminOrgDetail as OrgDetail } from "../../api/types.ts";
import { AllowanceMeter } from "../../components/AllowanceMeter.tsx";
import { DetailList } from "../../components/data.tsx";
import { ConfirmDialog, Modal, useToast } from "../../components/overlay.tsx";
import { Badge, Button, Card, Empty, ErrorState, FormError, Hours, Loading, SelectField, TextField } from "../../components/ui.tsx";
import { formatDate, formatDateTime, formatRelative, fromDateInput, platformLabel } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { ROLE_LABEL, STATUS_LABEL, statusTone } from "../../lib/roles.ts";
import { Link } from "../../router.tsx";
import { AdminOnlyNote, useStaffRole } from "./shared.tsx";

/** Grant auto-director hours to an organisation (admin staff only). */
export function GrantDialog({ orgId, orgName, onClose, onDone }: { orgId: string; orgName: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const h = Number(hours);
    const errs: Record<string, string> = {};
    if (!Number.isFinite(h) || h <= 0 || h > 10000) errs.hours = "Between 0 and 10,000 hours (decimals allowed).";
    if (note.trim().length < 3) errs.note = 'At least 3 characters, e.g. "support credit, ticket 123".';
    const exp = expires ? fromDateInput(expires, true) : null;
    if (expires && !exp) errs.expires = "Pick a valid date.";
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.grantHours(orgId, { hours: h, note: note.trim(), expiresAt: exp });
      onDone(`Granted ${h} h to ${orgName}.`);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Grant hours to ${orgName}`}
      description="Granted hours are added as a credit, used after the plan's included hours and shown to the organisation on its billing page."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Grant hours
          </Button>
        </>
      }
    >
      <form
        className="form"
        noValidate
        aria-label={`Grant hours to ${orgName}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField label="Hours" type="number" inputMode="decimal" min={0} step="0.25" value={hours} onValue={setHours} error={errors.hours} data-autofocus />
        <TextField label="Note (shown to the organisation)" value={note} onValue={setNote} maxLength={200} error={errors.note} />
        <TextField label="Expires after" type="date" optional value={expires} onValue={setExpires} error={errors.expires} hint="Leave empty for credits that never expire." />
        <FormError error={error} />
      </form>
    </Modal>
  );
}

/** Statuses that give the organisation its plan (the rest mean the free plan). */
const PAID_STATUSES: SubscriptionStatus[] = ["active", "trialing", "past_due"];
const ALL_STATUSES = Object.keys(STATUS_LABEL) as SubscriptionStatus[];

/** Set an organisation's subscription status and plan by hand (admin staff only). */
function SubscriptionDialog({ d, onClose, onDone }: { d: OrgDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const catalog = useResource("admin-catalog", () => api.catalog());
  const current = d.subscription.override;
  const [status, setStatus] = useState<SubscriptionStatus>(current?.status ?? d.subscription.status);
  const [planId, setPlanId] = useState(current?.planId ?? (d.plan.id === "free" ? "" : d.plan.id));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paid = PAID_STATUSES.includes(status);
  const plans = (catalog.data?.plans ?? []).filter((p) => p.id !== "free");
  async function submit() {
    const errs: Record<string, string> = {};
    if (paid && !planId) errs.plan = "Choose the plan they get.";
    if (note.trim().length < 3) errs.note = 'At least 3 characters, e.g. "partner league, ticket 123".';
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.adminSetSubscriptionOverride(d.org.id, { status, planId: paid ? planId : null, note: note.trim() });
      const planName = plans.find((p) => p.id === r.planId)?.name ?? r.planId;
      onDone(`${d.org.name} is now ${STATUS_LABEL[r.status].toLowerCase()} on ${planName === "free" ? "the free plan" : planName}.`);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Change ${d.org.name}'s subscription status`}
      description="The organisation gets this status and plan everywhere (the website, the program, its computer and member limits and its hours) until an admin removes the override. Stripe's own updates are still recorded underneath. This doesn't change what Stripe charges: cancel or refund in Stripe separately."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Save status
          </Button>
        </>
      }
    >
      <form
        className="form"
        noValidate
        aria-label="Change subscription status"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SelectField label="Status" value={status} onValue={(v) => setStatus(v as SubscriptionStatus)} hint={paid ? "The organisation gets the plan below." : "The organisation gets the free plan while in this status."} data-autofocus>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        {paid && (
          <SelectField label="Plan" value={planId} onValue={setPlanId} error={errors.plan} disabled={catalog.loading && !catalog.data} hint={catalog.error ? "Couldn't load the plans; close and try again." : undefined}>
            <option value="">Choose a plan…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.public ? "" : " (hidden plan)"}
              </option>
            ))}
          </SelectField>
        )}
        <TextField label="Reason (recorded in the audit log)" value={note} onValue={setNote} maxLength={200} error={errors.note} hint="Not shown to the organisation." />
        <FormError error={error} />
      </form>
    </Modal>
  );
}

function ResetUsageDialog({ d, onClose, onDone }: { d: OrgDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <ConfirmDialog
      title={`Reset ${d.org.name}'s usage this period?`}
      description="Auto-director usage this period goes back to zero, so the plan's included hours are available again, and hour credits already spent stay spent. The usage history is kept."
      confirmLabel="Reset usage"
      variant="primary"
      validate={() => (note.trim().length < 3 ? "Give a reason of at least 3 characters." : null)}
      onConfirm={() => api.adminResetUsage(d.org.id, note.trim())}
      onClose={onClose}
      onDone={() => onDone("Usage reset to zero for this period.")}
    >
      <TextField label="Reason (recorded in the audit log)" value={note} onValue={setNote} maxLength={200} hint='For example "outage on 12 May, ticket 123".' data-autofocus />
    </ConfirmDialog>
  );
}

type OrgDialog = null | "status" | "remove-override" | "reset-usage" | "sign-out-all" | { signOut: { id: string; name: string } };

export function AdminOrgDetail({ orgId }: { orgId: string }) {
  const toast = useToast();
  const { isAdmin, role } = useStaffRole();
  const detail = useResource(`admin-org:${orgId}`, () => api.adminOrg(orgId));
  const audit = useResource(`admin-org-audit:${orgId}`, () => api.audit(orgId));
  const [granting, setGranting] = useState(false);
  const [dialog, setDialog] = useState<OrgDialog>(null);
  const d = detail.data;
  useTitle(d ? `${d.org.name} · Admin` : "Organisation · Admin");

  if (detail.loading && !d) return <Loading label="Loading the organisation…" />;
  if (detail.error && !d)
    return (
      <>
        <p className="crumb-back">
          <Link to="/admin/orgs">← Organisations</Link>
        </p>
        <ErrorState error={detail.error} onRetry={detail.reload} title="Couldn't load this organisation" />
      </>
    );
  if (!d) return null;
  const linked = d.devices.filter((x) => !x.revokedAt);
  const override = d.subscription.override;
  const stripe = d.subscription.stripe;
  const closeDialog = () => setDialog(null);
  const changed = (msg: string) => {
    toast(msg);
    void detail.reload();
    void audit.reload();
  };

  return (
    <>
      <p className="crumb-back">
        <Link to="/admin/orgs">← Organisations</Link>
      </p>
      <header className="detail-head">
        <div className="detail-head-text">
          <h1 tabIndex={-1} data-page-heading>
            {d.org.name}
          </h1>
          <p className="muted">
            <span className="mono small">{d.org.id}</span> · created {formatDate(d.org.createdAt)}
          </p>
          <span className="badge-row">
            <Badge tone="info">{d.plan.name}</Badge>
            <Badge tone={statusTone(d.subscription.status)}>{STATUS_LABEL[d.subscription.status]}</Badge>
            {override && <Badge tone="info">Set by staff</Badge>}
            {d.subscription.cancelAtPeriodEnd && <Badge tone="warn">Cancels at period end</Badge>}
          </span>
        </div>
        <div className="detail-head-actions">
          <Link to={`/orgs/${encodeURIComponent(d.org.id)}`} className="btn btn-secondary btn-sm">
            Open as staff (read-only)
          </Link>
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setGranting(true)}>
              Grant hours
            </Button>
          )}
        </div>
      </header>

      <div className="detail-grid">
        <div className="stack-lg">
          <Card
            title="Auto-director hours this period"
            actions={
              isAdmin ? (
                <Button size="sm" onClick={() => setDialog("reset-usage")} disabledReason={d.allowance.usedSeconds === 0 ? "Nothing has been used this period." : null}>
                  Reset usage
                </Button>
              ) : undefined
            }
          >
            <AllowanceMeter allowance={{ ...d.allowance, overageAllowed: false }} planName={d.plan.name} />
            {d.usageResets.length > 0 && (
              <ul className="small muted reset-list">
                {d.usageResets.map((x) => (
                  <li key={x.id}>
                    Reset by {x.createdBy} on {formatDateTime(x.createdAt)}: <Hours seconds={x.seconds} /> cleared ({x.note})
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Members (${d.members.length})`}>
            {d.members.length === 0 ? (
              <Empty title="No members" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {d.members.map((m) => (
                    <tr key={m.userId}>
                      <td data-label="Name">
                        <Link to={`/admin/users/${encodeURIComponent(m.userId)}`} className="strong">
                          {m.displayName || "(no name)"}
                        </Link>
                      </td>
                      <td data-label="Email">{m.email}</td>
                      <td data-label="Role">{ROLE_LABEL[m.role] ?? m.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title={`Computers (${linked.length} of ${d.limits.maxDevices} signed in)`}
            actions={
              <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDialog("sign-out-all")} disabledReason={linked.length === 0 ? "No computers are signed in." : null}>
                Sign out all
              </Button>
            }
          >
            {linked.length >= d.limits.maxDevices && (
              <p className="small muted">
                At the {d.plan.name} plan's limit: signing in on another computer is refused until one is signed out.
              </p>
            )}
            {d.devices.length === 0 ? (
              <Empty title="No computers linked yet" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Computer</th>
                    <th scope="col">Platform</th>
                    <th scope="col">Version</th>
                    <th scope="col">Linked</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.devices.map((x) => (
                    <tr key={x.id} className={x.revokedAt ? "is-muted" : undefined}>
                      <td data-label="Computer" className="strong">
                        {x.name}
                      </td>
                      <td data-label="Platform">{platformLabel(x.platform)}</td>
                      <td data-label="Version">{x.appVersion || "—"}</td>
                      <td data-label="Linked">{formatDate(x.linkedAt)}</td>
                      <td data-label="Last seen">{x.lastSeenAt ? formatRelative(x.lastSeenAt) : "Never"}</td>
                      <td data-label="Status">{x.revokedAt ? <Badge>Unlinked {formatDate(x.revokedAt)}</Badge> : <Badge tone="ok">Linked</Badge>}</td>
                      <td data-label="">
                        {!x.revokedAt && (
                          <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDialog({ signOut: { id: x.id, name: x.name } })}>
                            Sign out
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Recent activity">
            {audit.loading && !audit.data && <Loading />}
            {audit.error && <ErrorState error={audit.error} onRetry={audit.reload} />}
            {audit.data && audit.data.length === 0 && <Empty title="No recorded activity" />}
            {audit.data && audit.data.length > 0 && (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.slice(0, 25).map((a) => (
                    <tr key={a.id}>
                      <td data-label="Time" className="nowrap">{formatDateTime(a.at)}</td>
                      <td data-label="Action" className="mono small nowrap">
                        {a.action}
                      </td>
                      <td data-label="Actor" className="mono small">
                        {a.actor}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="stack-lg">
          <Card
            title="Subscription"
            actions={
              isAdmin ? (
                <Button size="sm" onClick={() => setDialog("status")}>
                  Change status
                </Button>
              ) : undefined
            }
          >
            <DetailList
              items={[
                ["Plan", d.plan.name],
                ["Status", <Badge tone={statusTone(d.subscription.status)}>{STATUS_LABEL[d.subscription.status]}</Badge>],
                ["Period", `${formatDate(d.subscription.periodStart)} – ${formatDate(d.subscription.periodEnd)}`],
                ["Renews", override ? "Set by staff" : d.subscription.cancelAtPeriodEnd ? "No, cancels at period end" : d.subscription.status === "none" ? "—" : "Yes"],
                ["Stripe reports", stripe ? `${STATUS_LABEL[stripe.status]} · ${stripe.planId}` : "No Stripe subscription"],
                ["Stripe customer", d.org.stripeCustomerId ? <span className="mono small">{d.org.stripeCustomerId}</span> : "None yet"],
              ]}
            />
            {override && (
              <div className="override-note">
                <p className="small">
                  <span className="strong">Set by staff:</span> {override.createdBy} on {formatDateTime(override.createdAt)}. Reason: {override.note}
                </p>
                <p className="small muted">This wins over Stripe until it's removed. Removing it makes Stripe's status apply again.</p>
                {isAdmin && (
                  <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDialog("remove-override")}>
                    Remove override
                  </Button>
                )}
              </div>
            )}
            {!isAdmin && <AdminOnlyNote role={role} what="Changing the subscription status is hidden." />}
          </Card>

          <Card title="Hour credits" actions={isAdmin ? <Button size="sm" onClick={() => setGranting(true)}>Grant hours</Button> : undefined}>
            {!isAdmin && <AdminOnlyNote role={role} what="Granting hours is hidden." />}
            {d.credits.length === 0 ? (
              <Empty title="No hour credits" />
            ) : (
              <ul className="credit-list">
                {d.credits.map((c) => (
                  <li key={c.id}>
                    <div>
                      <p className="strong">{c.note ?? (c.source === "hour_pack" ? "Hour pack" : "Granted hours")}</p>
                      <p className="small muted">
                        {c.source === "hour_pack" ? "Bought" : "Granted by staff"} {formatDate(c.createdAt)} · {c.expiresAt ? `expires ${formatDate(c.expiresAt)}` : "never expires"}
                      </p>
                    </div>
                    <p className="credit-hours">
                      <Hours seconds={c.remainingSeconds} />
                      <span className="small muted block">
                        of <Hours seconds={c.seconds} />
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {dialog === "status" && <SubscriptionDialog d={d} onClose={closeDialog} onDone={changed} />}
      {dialog === "reset-usage" && <ResetUsageDialog d={d} onClose={closeDialog} onDone={changed} />}
      {dialog === "remove-override" && (
        <ConfirmDialog
          title="Remove the override?"
          description={stripe ? `Stripe's status applies again: ${STATUS_LABEL[stripe.status].toLowerCase()} (${stripe.planId}).` : "This organisation has no Stripe subscription, so it goes back to the free plan."}
          confirmLabel="Remove override"
          onConfirm={() => api.adminRemoveSubscriptionOverride(d.org.id)}
          onClose={closeDialog}
          onDone={() => changed("Override removed; Stripe's status applies again.")}
        />
      )}
      {dialog === "sign-out-all" && (
        <ConfirmDialog
          title={`Sign out all of ${d.org.name}'s computers?`}
          description={`${linked.length} ${linked.length === 1 ? "computer is" : "computers are"} signed out. An open program keeps running until it's closed, then asks to sign in again. Automation already running is never cut mid-map.`}
          confirmLabel="Sign out all"
          onConfirm={() => api.adminSignOutAllComputers(d.org.id)}
          onClose={closeDialog}
          onDone={(r) => {
            const n = (r as { computers?: number } | undefined)?.computers ?? 0;
            changed(`Signed out ${n} ${n === 1 ? "computer" : "computers"}.`);
          }}
        />
      )}
      {dialog && typeof dialog === "object" && (
        <ConfirmDialog
          title={`Sign out ${dialog.signOut.name}?`}
          description="It frees a place under the plan's computer limit. An open program keeps running until it's closed, then asks to sign in again."
          confirmLabel="Sign out computer"
          onConfirm={() => api.adminSignOutComputer(d.org.id, dialog.signOut.id)}
          onClose={closeDialog}
          onDone={() => changed(`${dialog.signOut.name} signed out.`)}
        />
      )}
      {granting && (
        <GrantDialog
          orgId={d.org.id}
          orgName={d.org.name}
          onClose={() => setGranting(false)}
          onDone={(m) => {
            toast(m);
            void detail.reload();
            void audit.reload();
          }}
        />
      )}
    </>
  );
}
