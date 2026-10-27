import { useState } from "react";
import { api } from "../../api/index.ts";
import type { AdminUser, StaffRole } from "../../api/types.ts";
import { DetailList, Initials } from "../../components/data.tsx";
import { ConfirmDialog, Modal, useToast } from "../../components/overlay.tsx";
import { Alert, Badge, Button, Card, Empty, ErrorState, FieldShell, FormError, Loading, SelectField, TextField } from "../../components/ui.tsx";
import { describeError, fieldErrors } from "../../api/client.ts";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { ROLE_LABEL } from "../../lib/roles.ts";
import { STAFF_ROLE_INFO, STAFF_ROLE_LABEL } from "../../lib/staff.ts";
import { describeUserAgent } from "../../lib/useragent.ts";
import { Link } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";
import { AdminOnlyNote, UserBadges, useStaffRole } from "./shared.tsx";

type Dialog = null | "verify" | "resend" | "reset" | "signout" | "role" | "disable" | "enable" | "edit";

/** Why an admin can't change this account's role or status (null = allowed). */
export function protectedReason(u: AdminUser, myId: string | null, what: "role" | "status"): string | null {
  if (u.id === myId) return what === "role" ? "You can't change your own staff role." : "You can't disable your own account.";
  if (u.bootstrapAdmin) return "This account is listed in the server's MF_STAFF_EMAILS setting, so it's always an admin and can't be demoted or disabled here. Change that setting on the server instead.";
  return null;
}

function DisableDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={`Disable ${user.displayName || user.email}?`}
      description="They're signed out everywhere and can't sign in until an admin enables the account again. Their organisations keep working for other members."
      confirmLabel="Disable account"
      validate={() => (reason.trim().length < 3 ? "Give a reason of at least 3 characters." : reason.trim().length > 300 ? "Keep the reason under 300 characters." : null)}
      onConfirm={() => api.adminDisableUser(user.id, reason.trim())}
      onClose={onClose}
      onDone={onDone}
    >
      <FieldShell label="Reason (recorded in the audit log)" hint={`${reason.trim().length} / 300 characters. Not shown to the user.`}>
        {({ id, describedBy }) => <textarea id={id} rows={3} maxLength={300} value={reason} aria-describedby={describedBy} onChange={(e) => setReason(e.target.value)} data-autofocus />}
      </FieldShell>
    </ConfirmDialog>
  );
}

function EditDialog({ user, isSelf, onClose, onDone }: { user: AdminUser; isSelf: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailLocked = isSelf || user.bootstrapAdmin;
  async function save() {
    const body: { displayName?: string; email?: string } = {};
    const errs: Record<string, string> = {};
    if (name.trim() !== user.displayName) {
      if (name.trim().length < 1 || name.trim().length > 80) errs.displayName = "Between 1 and 80 characters.";
      else body.displayName = name.trim();
    }
    if (email.trim().toLowerCase() !== user.email.toLowerCase()) {
      if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = "Enter a valid email address.";
      else body.email = email.trim();
    }
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    if (!body.displayName && !body.email) return setError("Nothing has changed.");
    setBusy(true);
    setError(null);
    try {
      await api.adminUpdateUser(user.id, body);
      onDone(body.email ? `Saved. A verification email was sent to ${body.email}.` : "Name saved.");
      onClose();
    } catch (e) {
      const fe = fieldErrors(e);
      if (describeError(e).toLowerCase().includes("already")) fe.email = "Another account uses this address.";
      setErrors(fe);
      setError(describeError(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Edit account"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Name" value={name} onValue={setName} maxLength={80} error={errors.displayName} data-autofocus />
        <TextField
          label="Email"
          type="email"
          value={email}
          onValue={setEmail}
          error={errors.email}
          disabled={emailLocked}
          hint={emailLocked ? (isSelf ? "Change your own email from your account page." : "Bootstrap admins' email addresses are set on the server.") : "Changing it marks the address unverified and sends a verification email to the new address."}
        />
        <FormError error={error} />
      </form>
    </Modal>
  );
}

export function AdminUserDetail({ userId }: { userId: string }) {
  const toast = useToast();
  const { isAdmin, role: myRole, userId: myId } = useStaffRole();
  const { refresh } = useSession();
  const detail = useResource(`admin-user:${userId}`, () => api.adminUser(userId));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newRole, setNewRole] = useState<string>("");
  const u = detail.data?.user;
  useTitle(u ? `${u.displayName || u.email} · Admin` : "User · Admin");
  const close = () => setDialog(null);
  const done = (msg: string) => {
    toast(msg);
    void detail.reload();
  };

  if (detail.loading && !detail.data) return <Loading label="Loading the account…" />;
  if (detail.error && !detail.data)
    return (
      <>
        <p className="crumb-back">
          <Link to="/admin/users">← Users</Link>
        </p>
        <ErrorState error={detail.error} onRetry={detail.reload} title="Couldn't load this account" />
      </>
    );
  if (!detail.data || !u) return null;
  const d = detail.data;
  const roleBlock = protectedReason(u, myId, "role");
  const statusBlock = protectedReason(u, myId, "status");
  const roleValue = newRole || (u.staffRole ?? "none");
  const roleChanged = roleValue !== (u.staffRole ?? "none");

  return (
    <>
      <p className="crumb-back">
        <Link to="/admin/users">← Users</Link>
      </p>
      <header className="detail-head">
        <Initials name={u.displayName || u.email} />
        <div className="detail-head-text">
          <h1 tabIndex={-1} data-page-heading>
            {u.displayName || "(no name)"}
          </h1>
          <p className="muted">
            {u.email} · <span className="mono small">{u.id}</span>
          </p>
          <UserBadges u={u} />
        </div>
      </header>

      {u.disabled && (
        <Alert tone="danger" title="This account is disabled" live={false}>
          It can't sign in. Reason: {u.disabledReason ?? "none recorded"}.
        </Alert>
      )}

      <div className="detail-grid">
        <div className="stack-lg">
          <Card title="Account">
            <DetailList
              items={[
                ["Email", <>{u.email} {u.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}</>],
                ["Staff role", u.staffRole ? STAFF_ROLE_LABEL[u.staffRole] : "None (customer)"],
                ["Signed up", formatDateTime(u.createdAt)],
                ["Last sign-in", u.lastLoginAt ? `${formatDateTime(u.lastLoginAt)} (${formatRelative(u.lastLoginAt)})` : "Never"],
                ["Organisations", String(u.orgCount)],
              ]}
            />
          </Card>

          <Card title="Organisations">
            {d.memberships.length === 0 ? (
              <Empty title="Not a member of any organisation" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Organisation</th>
                    <th scope="col">Role</th>
                    <th scope="col">Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {d.memberships.map((m) => (
                    <tr key={m.orgId}>
                      <td data-label="Organisation">
                        <Link to={`/admin/orgs/${encodeURIComponent(m.orgId)}`} className="strong">
                          {m.orgName}
                        </Link>
                      </td>
                      <td data-label="Role">{ROLE_LABEL[m.role] ?? m.role}</td>
                      <td data-label="Plan">{m.planName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Signed-in browsers">
            {d.sessions.length === 0 ? (
              <Empty title="No active sessions" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Device</th>
                    <th scope="col">IP address</th>
                    <th scope="col">Signed in</th>
                    <th scope="col">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sessions.map((s) => (
                    <tr key={s.id}>
                      <td data-label="Device">{describeUserAgent(s.userAgent).label}</td>
                      <td data-label="IP address" className="mono small">
                        {s.ip ?? "—"}
                      </td>
                      <td data-label="Signed in">{formatDateTime(s.createdAt)}</td>
                      <td data-label="Last active">{s.lastSeenAt ? formatRelative(s.lastSeenAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Recent activity">
            {d.audit.length === 0 ? (
              <Empty title="No recorded activity" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Organisation</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {d.audit.slice(0, 50).map((a, i) => (
                    <tr key={`${a.at}-${i}`}>
                      <td data-label="Time" className="nowrap">{formatDateTime(a.at)}</td>
                      <td data-label="Action" className="mono small nowrap">
                        {a.action}
                      </td>
                      <td data-label="Organisation">{a.orgId ? <Link to={`/admin/orgs/${encodeURIComponent(a.orgId)}`} className="mono small">{a.orgId}</Link> : "—"}</td>
                      <td data-label="Detail">
                        {a.detail && typeof a.detail === "object" && Object.keys(a.detail as object).length > 0 ? (
                          <details>
                            <summary>Show</summary>
                            <pre className="json">{JSON.stringify(a.detail, null, 2)}</pre>
                          </details>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="stack-lg">
          <Card title="Support actions">
            <div className="action-list">
              {!u.emailVerified && (
                <>
                  <div className="action-item">
                    <div>
                      <p className="strong">Verify email</p>
                      <p className="small muted">Mark the address as confirmed, for example after checking it by other means.</p>
                    </div>
                    <Button size="sm" onClick={() => setDialog("verify")}>
                      Verify email
                    </Button>
                  </div>
                  <div className="action-item">
                    <div>
                      <p className="strong">Resend verification</p>
                      <p className="small muted">Email a new confirmation link (valid for 48 hours).</p>
                    </div>
                    <Button size="sm" onClick={() => setDialog("resend")}>
                      Resend verification
                    </Button>
                  </div>
                </>
              )}
              <div className="action-item">
                <div>
                  <p className="strong">Send password reset</p>
                  <p className="small muted">Email a reset link valid for 60 minutes.</p>
                </div>
                <Button size="sm" onClick={() => setDialog("reset")} disabledReason={u.disabled ? "Enable the account first." : null}>
                  Send password reset
                </Button>
              </div>
              <div className="action-item">
                <div>
                  <p className="strong">Sign out everywhere</p>
                  <p className="small muted">End every browser session and sign out the computers this account signed in.</p>
                </div>
                <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDialog("signout")} disabledReason={d.sessions.length === 0 ? "No active sessions." : null}>
                  Sign out everywhere
                </Button>
              </div>
            </div>
          </Card>

          <Card title="Admin actions">
            {!isAdmin ? (
              <AdminOnlyNote role={myRole} what="Changing staff roles, disabling or enabling accounts and editing names or email addresses are hidden." />
            ) : (
              <div className="action-list">
                <div className="action-item action-item-stack">
                  <SelectField label="Staff role" value={roleValue} onValue={setNewRole} disabled={!!roleBlock} hint={STAFF_ROLE_INFO[roleValue as StaffRole | "none"]}>
                    <option value="none">None (customer)</option>
                    <option value="support">Support</option>
                    <option value="admin">Admin</option>
                  </SelectField>
                  <Button size="sm" variant="primary" onClick={() => setDialog("role")} disabledReason={roleBlock} disabled={!roleChanged}>
                    Save staff role
                  </Button>
                </div>
                <div className="action-item">
                  <div>
                    <p className="strong">{u.disabled ? "Enable account" : "Disable account"}</p>
                    <p className="small muted">{u.disabled ? "Let this account sign in again." : "Sign the account out and block sign-in."}</p>
                  </div>
                  {u.disabled ? (
                    <Button size="sm" onClick={() => setDialog("enable")} disabledReason={statusBlock}>
                      Enable account
                    </Button>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => setDialog("disable")} disabledReason={statusBlock}>
                      Disable account
                    </Button>
                  )}
                </div>
                <div className="action-item">
                  <div>
                    <p className="strong">Edit name or email</p>
                    <p className="small muted">A new email address must be verified again.</p>
                  </div>
                  <Button size="sm" onClick={() => setDialog("edit")}>
                    Edit account
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {dialog === "verify" && <ConfirmDialog title="Mark this email as verified?" description={`${u.email} will be treated as confirmed. Only do this if you're sure the address belongs to this person.`} confirmLabel="Verify email" variant="primary" onConfirm={() => api.adminVerifyEmail(u.id)} onClose={close} onDone={() => done("Email marked as verified.")} />}
      {dialog === "resend" && (
        <ConfirmDialog
          title="Resend the verification email?"
          description={`A new confirmation link goes to ${u.email}.`}
          confirmLabel="Send email"
          variant="primary"
          onConfirm={() => api.adminResendVerification(u.id)}
          onClose={close}
          onDone={(r) => done((r as { alreadyVerified?: boolean } | undefined)?.alreadyVerified ? "That address is already verified." : `Verification email sent to ${u.email}.`)}
        />
      )}
      {dialog === "reset" && <ConfirmDialog title="Send a password reset link?" description={`${u.email} gets a link to choose a new password. Their current password keeps working until they use it.`} confirmLabel="Send reset link" variant="primary" onConfirm={() => api.adminPasswordReset(u.id)} onClose={close} onDone={() => done(`Password reset link sent to ${u.email}.`)} />}
      {dialog === "signout" && (
        <ConfirmDialog
          title="Sign out everywhere?"
          description={`Every browser and every Matchframe program signed in as ${u.email} is signed out. A program that is open keeps running until it is closed. They can sign in again straight away.`}
          confirmLabel="Sign out everywhere"
          onConfirm={() => api.adminSignOutUser(u.id)}
          onClose={close}
          onDone={(r) => {
            const n = (r as { revoked?: number } | undefined)?.revoked ?? 0;
            const c = (r as { computers?: number } | undefined)?.computers ?? 0;
            done(`Signed out ${n} ${n === 1 ? "session" : "sessions"}${c ? ` and ${c} ${c === 1 ? "computer" : "computers"}` : ""}.`);
          }}
        />
      )}
      {dialog === "role" && (
        <ConfirmDialog
          title={roleValue === "none" ? "Remove staff access?" : `Make ${u.displayName || u.email} ${roleValue === "admin" ? "an admin" : "support staff"}?`}
          description={STAFF_ROLE_INFO[roleValue as StaffRole | "none"]}
          confirmLabel={roleValue === "none" ? "Remove staff role" : "Save staff role"}
          variant={roleValue === "admin" ? "danger" : "primary"}
          onConfirm={() => api.adminSetStaffRole(u.id, roleValue === "none" ? null : (roleValue as StaffRole))}
          onClose={close}
          onDone={() => {
            setNewRole("");
            done(roleValue === "none" ? "Staff role removed." : `Staff role set to ${STAFF_ROLE_LABEL[roleValue as StaffRole].toLowerCase()}.`);
            if (u.id === myId) void refresh();
          }}
        />
      )}
      {dialog === "disable" && <DisableDialog user={u} onClose={close} onDone={() => done("Account disabled and signed out.")} />}
      {dialog === "enable" && <ConfirmDialog title="Enable this account?" description={`${u.email} can sign in again.`} confirmLabel="Enable account" variant="primary" onConfirm={() => api.adminEnableUser(u.id)} onClose={close} onDone={() => done("Account enabled.")} />}
      {dialog === "edit" && <EditDialog user={u} isSelf={u.id === myId} onClose={close} onDone={done} />}
    </>
  );
}
