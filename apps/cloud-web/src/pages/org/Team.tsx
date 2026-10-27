import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { InviteRequest } from "@matchframe/cloud-contracts";
import type { OrgScope } from "../../App.tsx";
import { api, describeError } from "../../api/index.ts";
import type { Member, OrgDetails, OrgRole } from "../../api/types.ts";
import { Alert, Badge, Button, Card, ConfirmButton, Empty, ErrorState, FormError, Loading, PageHeader, SelectField, TextField } from "../../components/ui.tsx";
import { formatDate } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { ROLE_INFO, ROLE_LABEL, can, roleReason } from "../../lib/roles.ts";
import type { ViewerRole } from "../../lib/roles.ts";
import { validate } from "../../lib/validate.ts";
import { Link, navigate } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

const ROLES: OrgRole[] = ["owner", "admin", "billing", "member"];

/** Rename the organisation (owners and admins). */
function OrgNameCard({ org, role, onSaved }: { org: OrgDetails; role: ViewerRole; onSaved: () => Promise<unknown> }) {
  const [name, setName] = useState(org.name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const why = roleReason(role, "org.rename");
  useEffect(() => setName(org.name), [org.name]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (!name.trim()) {
      setFieldError("Required.");
      setError("Please fix the highlighted field.");
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      await api.renameOrg(org.id, name.trim());
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Organisation" id="organisation">
      <form className="inline-form" onSubmit={submit} noValidate>
        <TextField label="Organisation name" value={name} onValue={setName} maxLength={80} error={fieldError} disabled={!!why} hint="Shown to your team, on invitations and in the program after it refreshes." />
        <div>
          <Button type="submit" busy={busy} disabledReason={why ?? (name.trim() === org.name ? "Change the name first." : null)}>
            Save name
          </Button>
        </div>
        <FormError error={error} />
      </form>
      {saved && <Alert tone="ok">Name saved.</Alert>}
      <dl className="kv">
        <div>
          <dt>Organisation ID</dt>
          <dd className="mono">{org.id}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(org.createdAt)}</dd>
        </div>
      </dl>
      <p className="small muted">
        Need a separate organisation with its own billing? Create one from your <Link to="/account#orgs">account page</Link>.
      </p>
    </Card>
  );
}

/** Why `me` can't change `target`'s role (null = can). Mirrors the API's owner and last-owner rules. */
export function roleChangeBlocker(myRole: ViewerRole, target: Member, owners: number): string | null {
  const why = roleReason(myRole, "members.manage");
  if (why) return why;
  if (target.role === "owner" && myRole !== "owner") return "Only owners can change an owner's role.";
  if (target.role === "owner" && owners <= 1) return "The only owner can't change role: make someone else an owner first.";
  return null;
}

function RoleCell({ orgId, member, myRole, owners, onChanged }: { orgId: string; member: Member; myRole: ViewerRole; owners: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const blocked = roleChangeBlocker(myRole, member, owners);
  if (blocked)
    return (
      <span>
        {ROLE_LABEL[member.role]}
        <span className="why block">{blocked}</span>
      </span>
    );
  const options = ROLES.filter((r) => r !== "owner" || myRole === "owner" || member.role === "owner");
  return (
    <span className="role-cell">
      <label htmlFor={id} className="visually-hidden">
        Role for {member.displayName}
      </label>
      <select
        id={id}
        value={member.role}
        disabled={busy}
        aria-busy={busy || undefined}
        onChange={async (e) => {
          const role = e.target.value as OrgRole;
          setBusy(true);
          setError(null);
          try {
            await api.setRole(orgId, member.userId, role);
            onChanged();
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <span className="action-error" role="alert">
        {error}
      </span>
    </span>
  );
}

function InviteForm({ orgId, disabledReason, onInvited }: { orgId: string; disabledReason: string | null; onInvited: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<OrgRole, "owner">>("member");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validate(InviteRequest, { email, role });
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.invite(orgId, email.trim(), role);
      onInvited(email.trim());
      setEmail("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="invite-form" onSubmit={submit} noValidate>
      <TextField label="Email" type="email" autoComplete="off" value={email} onValue={setEmail} error={errors.email} disabled={!!disabledReason} />
      <SelectField label="Role" value={role} onValue={(v) => setRole(v as Exclude<OrgRole, "owner">)} disabled={!!disabledReason}>
        <option value="member">Member</option>
        <option value="billing">Billing</option>
        <option value="admin">Admin</option>
      </SelectField>
      <div className="invite-submit">
        <Button type="submit" variant="primary" busy={busy} disabledReason={disabledReason}>
          Send invitation
        </Button>
      </div>
      <FormError error={error} />
    </form>
  );
}

export function Team({ scope }: { scope: OrgScope }) {
  useTitle("Team");
  const { orgId, role } = scope;
  const { me, refresh } = useSession();
  const team = useResource(`members:${orgId}`, () => api.members(orgId));
  const org = useResource(`org:${orgId}`, () => api.org(orgId));
  const [notice, setNotice] = useState<string | null>(null);
  const members = team.data?.members ?? [];
  const invites = team.data?.invites ?? [];
  const owners = members.filter((m) => m.role === "owner").length;
  const maxMembers = org.data?.plan.features.maxMembers;
  const seats = members.length + invites.length;
  const manageWhy = roleReason(role, "members.manage");
  const inviteWhy = manageWhy ?? (!me?.user.emailVerified ? "Verify your email address before inviting people." : maxMembers !== undefined && seats >= maxMembers ? `The ${org.data!.plan.name} plan allows ${maxMembers} members, counting pending invitations. Withdraw an invitation, remove someone or upgrade.` : null);

  return (
    <>
      <PageHeader title="Team" subtitle={maxMembers !== undefined ? `${members.length} ${members.length === 1 ? "member" : "members"} and ${invites.length} pending of ${maxMembers} on the ${org.data!.plan.name} plan.` : "Members, roles and invitations."} />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {team.error && <ErrorState error={team.error} onRetry={team.reload} />}
      {team.loading && !team.data && <Loading />}
      {team.data && (
        <div className="stack-lg">
          <Card title="Members">
            <table className="rtable">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Since</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isMe = m.userId === me?.user.id;
                  const soleOwner = m.role === "owner" && owners <= 1;
                  const removeWhy = isMe ? (soleOwner ? "You're the only owner: make someone else an owner before leaving." : null) : (manageWhy ?? (m.role === "owner" && role !== "owner" ? "Only owners can remove an owner." : null));
                  return (
                    <tr key={m.userId}>
                      <td data-label="Name">
                        <span className="strong">{m.displayName}</span>
                        {isMe && <Badge tone="info">You</Badge>}
                        <span className="muted small block">{m.email}</span>
                      </td>
                      <td data-label="Role">
                        <RoleCell orgId={orgId} member={m} myRole={role} owners={owners} onChanged={() => {
                          setNotice(`${m.displayName}'s role was changed.`);
                          void team.reload();
                          if (isMe) void refresh();
                        }} />
                      </td>
                      <td data-label="Since">{formatDate(m.since)}</td>
                      <td data-label="Actions" className="cell-actions">
                        {isMe ? (
                          <ConfirmButton
                            label="Leave"
                            confirmLabel="Leave"
                            question={`Leave ${org.data?.name ?? "this organisation"}? You'll lose access until someone invites you again.`}
                            disabledReason={removeWhy}
                            action={() => api.removeMember(orgId, m.userId)}
                            onDone={() => {
                              void refresh().then(() => navigate("/dashboard", { replace: true }));
                            }}
                          />
                        ) : (
                          <ConfirmButton
                            label="Remove"
                            confirmLabel="Remove"
                            question={`Remove ${m.displayName} from the organisation?`}
                            disabledReason={removeWhy}
                            action={() => api.removeMember(orgId, m.userId)}
                            onDone={() => {
                              setNotice(`${m.displayName} was removed.`);
                              void team.reload();
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <Card title="Invite someone">
            <InviteForm orgId={orgId} disabledReason={inviteWhy} onInvited={(email) => {
              setNotice(`Invitation sent to ${email}. It expires in 7 days.`);
              void team.reload();
            }} />
          </Card>

          <Card title="Pending invitations">
            {invites.length === 0 ? (
              <Empty title="No pending invitations" />
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <td data-label="Email">{i.email}</td>
                      <td data-label="Role">{ROLE_LABEL[i.role]}</td>
                      <td data-label="Expires">{formatDate(i.expiresAt)}</td>
                      <td data-label="Actions" className="cell-actions">
                        <ConfirmButton
                          label="Withdraw"
                          confirmLabel="Withdraw"
                          question={`Withdraw the invitation for ${i.email}?`}
                          disabledReason={manageWhy}
                          action={() => api.withdrawInvite(orgId, i.id)}
                          onDone={() => {
                            setNotice(`Invitation for ${i.email} withdrawn.`);
                            void team.reload();
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {org.data && <OrgNameCard org={org.data} role={role} onSaved={() => Promise.all([org.reload(), refresh()])} />}

          <Card title="Roles">
            <dl className="roles-dl">
              {ROLE_INFO.map((r) => (
                <div key={r.role}>
                  <dt>{ROLE_LABEL[r.role]}</dt>
                  <dd>{r.summary}</dd>
                </div>
              ))}
            </dl>
            <p className="small">
              <strong>Every organisation keeps at least one owner.</strong> The last owner can't leave, be removed or change role; make someone else an owner first. Only owners can grant or change the owner role.
            </p>
            {!can(role, "members.manage") && <p className="small muted">{manageWhy}</p>}
          </Card>
        </div>
      )}
    </>
  );
}
