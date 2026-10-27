import { useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { AllowanceMeter } from "../../components/AllowanceMeter.tsx";
import { DetailList } from "../../components/data.tsx";
import { Modal, useToast } from "../../components/overlay.tsx";
import { Badge, Button, Card, Empty, ErrorState, FormError, Hours, Loading, TextField } from "../../components/ui.tsx";
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

export function AdminOrgDetail({ orgId }: { orgId: string }) {
  const toast = useToast();
  const { isAdmin, role } = useStaffRole();
  const detail = useResource(`admin-org:${orgId}`, () => api.adminOrg(orgId));
  const audit = useResource(`admin-org-audit:${orgId}`, () => api.audit(orgId));
  const [granting, setGranting] = useState(false);
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
          <Card title="Auto-director hours this period">
            <AllowanceMeter allowance={{ ...d.allowance, overageAllowed: false }} planName={d.plan.name} />
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

          <Card title={`Computers (${linked.length} linked)`}>
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
                      <td data-label="Time">{formatDateTime(a.at)}</td>
                      <td data-label="Action" className="mono small">
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
          <Card title="Subscription">
            <DetailList
              items={[
                ["Plan", d.plan.name],
                ["Status", <Badge tone={statusTone(d.subscription.status)}>{STATUS_LABEL[d.subscription.status]}</Badge>],
                ["Period", `${formatDate(d.subscription.periodStart)} – ${formatDate(d.subscription.periodEnd)}`],
                ["Renews", d.subscription.cancelAtPeriodEnd ? "No, cancels at period end" : d.subscription.status === "none" ? "—" : "Yes"],
                ["Stripe customer", d.org.stripeCustomerId ? <span className="mono small">{d.org.stripeCustomerId}</span> : "None yet"],
              ]}
            />
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
