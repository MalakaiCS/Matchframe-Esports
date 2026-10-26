import { useState } from "react";
import { api } from "../../api/index.ts";
import { ActionButton, Alert, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDate } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { ROLE_INFO, ROLE_LABEL } from "../../lib/roles.ts";
import { setLastOrg } from "../../lib/storage.ts";
import { Link, loginHref, navigate, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

export function Invite() {
  useTitle("Invitation");
  const loc = useLocation();
  const { me, status, refresh, clear } = useSession();
  const token = loc.query.get("token") ?? "";
  const preview = useResource(token ? `invite:${token}` : null, () => api.previewInvite(token));
  const [resent, setResent] = useState(false);
  const here = `/invite?token=${encodeURIComponent(token)}`;

  if (!token) {
    return (
      <div className="auth-card">
        <PageHeader title="Invitation" />
        <Alert tone="danger">This invitation link is missing its token. Open the full link from the email.</Alert>
      </div>
    );
  }

  const inv = preview.data;
  const role = inv ? ROLE_INFO.find((r) => r.role === inv.role) : undefined;
  const sameEmail = !!me && !!inv && me.user.email.toLowerCase() === inv.email.toLowerCase();

  return (
    <div className="auth-card">
      <PageHeader title={inv ? `Join ${inv.orgName}` : "Invitation"} />
      {preview.loading && !inv && <Loading label="Opening the invitation…" />}
      {preview.error && <ErrorState title="This invitation can't be used" error={`${preview.error} Ask whoever invited you to send a new invitation.`} />}
      {inv && (
        <>
          <dl className="kv">
            <div>
              <dt>Organisation</dt>
              <dd>{inv.orgName}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                {ROLE_LABEL[inv.role]}
                {role && <span className="muted small"> — {role.summary}</span>}
              </dd>
            </div>
            <div>
              <dt>For</dt>
              <dd>{inv.email}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatDate(inv.expiresAt)}</dd>
            </div>
          </dl>
          {status === "loading" ? (
            <Loading label="Checking your session…" />
          ) : !me ? (
            <>
              <p>
                Sign in or create an account with <strong>{inv.email}</strong> to accept.
              </p>
              <div className="stack">
                <Link className="btn btn-primary btn-block" to={loginHref(here)}>
                  Sign in to accept
                </Link>
                <Link className="btn btn-secondary btn-block" to={`/signup?email=${encodeURIComponent(inv.email)}&next=${encodeURIComponent(here)}`}>
                  Create an account
                </Link>
              </div>
            </>
          ) : !sameEmail ? (
            <Alert
              tone="warn"
              title="This invitation is for a different email"
              actions={
                <ActionButton size="sm" action={async () => {
                  await api.logout();
                  clear();
                  navigate(loginHref(here));
                }}>
                  Sign out and switch
                </ActionButton>
              }
            >
              You're signed in as <strong>{me.user.email}</strong>, but the invitation is for <strong>{inv.email}</strong>. Sign in with that email to accept it.
            </Alert>
          ) : (
            <div className="stack">
              {!me.user.emailVerified && (
                <Alert
                  tone="warn"
                  title="Verify your email first"
                  actions={
                    resent ? undefined : (
                      <ActionButton size="sm" action={async () => {
                        await api.resendVerification();
                        setResent(true);
                      }}>
                        Resend email
                      </ActionButton>
                    )
                  }
                >
                  {resent ? `A new link is on its way to ${me.user.email}. Come back to this page afterwards.` : "Open the verification link we emailed you, then come back to this page."}
                </Alert>
              )}
              <ActionButton
                variant="primary"
                block
                disabledReason={me.user.emailVerified ? null : "Verify your email address before accepting."}
                action={async () => {
                  const r = await api.acceptInvite(token);
                  setLastOrg(r.orgId);
                  await refresh();
                  navigate(`/orgs/${encodeURIComponent(r.orgId)}`);
                }}
              >
                Accept and join {inv.orgName}
              </ActionButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}
