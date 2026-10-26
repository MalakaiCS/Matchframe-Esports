import { useState } from "react";
import type { FormEvent } from "react";
import { ChangeEmailRequest, Password, UpdateProfileRequest } from "@matchframe/cloud-contracts";
import { api, describeError, fieldErrors } from "../api/index.ts";
import { CreateOrgForm } from "../components/CreateOrgForm.tsx";
import { signOut } from "../components/Layout.tsx";
import { ActionButton, Alert, Badge, Button, Card, FormError, PageHeader, TextField } from "../components/ui.tsx";
import { formatDate } from "../lib/format.ts";
import { useTitle } from "../lib/hooks.ts";
import { ROLE_LABEL } from "../lib/roles.ts";
import { Link } from "../router.tsx";
import { DownloadCard } from "./Download.tsx";
import { useSession } from "../state/session.tsx";

function ChangePassword() {
  const [v, setV] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    const errs: Record<string, string> = {};
    if (!v.currentPassword) errs.currentPassword = "Required.";
    if (!Password.safeParse(v.newPassword).success) errs.newPassword = "At least 10 characters.";
    if (v.confirm !== v.newPassword) errs.confirm = "The passwords don't match.";
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(v.currentPassword, v.newPassword);
      setDone(true);
      setV({ currentPassword: "", newPassword: "", confirm: "" });
    } catch (err) {
      const fe = fieldErrors(err);
      if (describeError(err).toLowerCase().includes("current password")) fe.currentPassword = "This isn't your current password.";
      setErrors(fe);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form form-narrow" onSubmit={submit} noValidate>
      <TextField label="Current password" type="password" autoComplete="current-password" value={v.currentPassword} onValue={set("currentPassword")} error={errors.currentPassword} />
      <TextField label="New password" type="password" autoComplete="new-password" value={v.newPassword} onValue={set("newPassword")} error={errors.newPassword} hint="At least 10 characters." />
      <TextField label="Repeat the new password" type="password" autoComplete="new-password" value={v.confirm} onValue={set("confirm")} error={errors.confirm} />
      <FormError error={error} />
      {done && <Alert tone="ok">Password changed. Other browsers and devices were signed out; this one stays signed in.</Alert>}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function EditName({ current, onSaved }: { current: string; onSaved: () => void }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    if (!UpdateProfileRequest.safeParse({ displayName: name }).success) return setError("Enter a name of 1 to 80 characters.");
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(name.trim());
      setDone(true);
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form form-narrow" onSubmit={submit} noValidate>
      <TextField label="Name" autoComplete="name" value={name} onValue={setName} maxLength={80} error={error} hint="Shown to your team and on invitations." />
      {done && <Alert tone="ok">Name saved.</Alert>}
      <div>
        <Button type="submit" variant="secondary" busy={busy} disabled={name.trim() === current}>
          Save name
        </Button>
      </div>
    </form>
  );
}

function ChangeEmail({ current }: { current: string }) {
  const [v, setV] = useState({ newEmail: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = ChangeEmailRequest.safeParse(v);
    const errs: Record<string, string> = {};
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.path[0] === "newEmail")) errs.newEmail = "Enter a valid email address.";
      if (parsed.error.issues.some((i) => i.path[0] === "password")) errs.password = "Required.";
    } else if (parsed.data.newEmail === current.toLowerCase()) errs.newEmail = "That is already your email address.";
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.changeEmail(parsed.data!.newEmail, v.password);
      setSentTo(parsed.data!.newEmail);
      setV({ newEmail: "", password: "" });
    } catch (err) {
      const fe = fieldErrors(err);
      const msg = describeError(err).toLowerCase();
      if (msg.includes("password")) fe.password = "This isn't your password.";
      if (msg.includes("already uses")) fe.newEmail = "Another account uses this address.";
      setErrors(fe);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form form-narrow" onSubmit={submit} noValidate>
      <TextField label="New email address" type="email" autoComplete="email" value={v.newEmail} onValue={set("newEmail")} error={errors.newEmail} />
      <TextField label="Your password" type="password" autoComplete="current-password" value={v.password} onValue={set("password")} error={errors.password} />
      <FormError error={error} />
      {sentTo && (
        <Alert tone="ok">
          We sent a confirmation link to {sentTo}. Your sign-in email changes once you open it (within 48 hours). {current} was told about the change.
        </Alert>
      )}
      <div>
        <Button type="submit" variant="secondary" busy={busy}>
          Change email
        </Button>
      </div>
    </form>
  );
}

export function Account() {
  useTitle("Account");
  const { me, clear, refresh } = useSession();
  const [resent, setResent] = useState(false);
  if (!me) return null;
  const u = me.user;
  return (
    <>
      <PageHeader title="Account" subtitle="Your profile, email address, password and organisations." />
      <div className="stack-lg">
        <Card title="Profile">
          <dl className="kv">
            <div>
              <dt>Email</dt>
              <dd>
                {u.email} {u.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{formatDate(u.createdAt)}</dd>
            </div>
            {u.staff && (
              <div>
                <dt>Access</dt>
                <dd>
                  Matchframe staff · <Link to="/admin">Admin</Link>
                </dd>
              </div>
            )}
          </dl>
          {!u.emailVerified && (
            <div className="button-row">
              {resent ? (
                <Alert tone="ok">A new verification link is on its way to {u.email}. It expires in 48 hours.</Alert>
              ) : (
                <ActionButton action={async () => {
                  const r = await api.resendVerification();
                  setResent(r.sent || !!r.alreadyVerified);
                }}>
                  Resend verification email
                </ActionButton>
              )}
            </div>
          )}
          <EditName key={u.displayName} current={u.displayName} onSaved={() => void refresh()} />
        </Card>

        <Card title="Email address">
          <ChangeEmail current={u.email} />
        </Card>

        <Card title="Password">
          <ChangePassword />
        </Card>

        <Card title="Organisations" id="orgs">
          {me.orgs.length === 0 ? (
            <p>You're not a member of any organisation.</p>
          ) : (
            <ul className="org-list">
              {me.orgs.map((o) => (
                <li key={o.id}>
                  <Link to={`/orgs/${encodeURIComponent(o.id)}`} className="strong">
                    {o.name}
                  </Link>
                  <span className="muted small">
                    {ROLE_LABEL[o.role]} · {o.planName} plan
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CreateOrgForm />
        </Card>

        <DownloadCard />

        <Card title="Sign out">
          <p className="muted">Signs out this browser only. Changing your password signs out everywhere else.</p>
          <ActionButton variant="danger" action={() => signOut(clear)}>
            Sign out
          </ActionButton>
        </Card>
      </div>
    </>
  );
}
