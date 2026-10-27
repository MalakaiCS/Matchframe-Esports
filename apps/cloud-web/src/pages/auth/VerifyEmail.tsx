import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { ActionButton, Alert, Loading, PageHeader } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

/** Tokens are single-use: remember in-flight/finished submissions so a re-render or StrictMode re-run never posts twice. */
const submissions = new Map<string, Promise<void>>();

export function VerifyEmail() {
  useTitle("Verify email");
  const { query } = useLocation();
  const { me, refresh } = useSession();
  const token = query.get("token") ?? "";
  const [state, setState] = useState<{ kind: "working" } | { kind: "ok" } | { kind: "error"; message: string }>(token ? { kind: "working" } : { kind: "error", message: "The link is missing its token. Open the full link from the email." });
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let p = submissions.get(token);
    if (!p) {
      p = api.verifyEmail(token).then(() => undefined);
      submissions.set(token, p);
    }
    p.then(
      () => {
        if (!alive) return;
        setState({ kind: "ok" });
        void refresh();
      },
      (e: unknown) => alive && setState({ kind: "error", message: describeError(e) }),
    );
    return () => {
      alive = false;
    };
  }, [token, refresh]);

  return (
    <div className="auth-card">
      <PageHeader title="Verify your email" />
      {state.kind === "working" && <Loading label="Confirming your email address…" />}
      {state.kind === "ok" && (
        <>
          <Alert tone="ok" title="Email address confirmed">
            You can now buy plans and hours, invite people, link computers and create organisations.
          </Alert>
          <p className="auth-alt">{me ? <Link to="/dashboard">Go to your dashboard</Link> : <Link to="/login">Sign in</Link>}</p>
        </>
      )}
      {state.kind === "error" && (
        <>
          {me?.user.emailVerified ? (
            <Alert tone="ok" title="Your email is already verified">
              This link was already used. Nothing else to do.
            </Alert>
          ) : (
            <Alert tone="danger" title="This link doesn't work">
              {state.message} Verification links last 48 hours and work once.
            </Alert>
          )}
          <div className="auth-alt">
            {me && !me.user.emailVerified ? (
              resent ? (
                <Alert tone="ok">A new link is on its way to {me.user.email}.</Alert>
              ) : (
                <ActionButton variant="primary" action={async () => {
                  await api.resendVerification();
                  setResent(true);
                }}>
                  Send a new link
                </ActionButton>
              )
            ) : me ? (
              <Link to="/dashboard">Go to your dashboard</Link>
            ) : (
              <span>
                <Link to="/login?next=%2Faccount">Sign in</Link> to send a new link.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
