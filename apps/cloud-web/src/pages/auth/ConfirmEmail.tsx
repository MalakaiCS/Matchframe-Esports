import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { Alert, Loading, PageHeader } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

/** Tokens are single-use: remember in-flight/finished submissions so a re-render or StrictMode re-run never posts twice. */
const submissions = new Map<string, Promise<string>>();

export function ConfirmEmail() {
  useTitle("Confirm new email");
  const { query } = useLocation();
  const { me, refresh } = useSession();
  const token = query.get("token") ?? "";
  const [state, setState] = useState<{ kind: "working" } | { kind: "ok"; email: string } | { kind: "error"; message: string }>(token ? { kind: "working" } : { kind: "error", message: "The link is missing its token. Open the full link from the email." });

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let p = submissions.get(token);
    if (!p) {
      p = api.confirmEmailChange(token).then((r) => r.email);
      submissions.set(token, p);
    }
    p.then(
      (email) => {
        if (!alive) return;
        setState({ kind: "ok", email });
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
      <PageHeader title="Confirm your new email" />
      {state.kind === "working" && <Loading label="Confirming your new email address…" />}
      {state.kind === "ok" && (
        <>
          <Alert tone="ok" title="Email address changed">
            You now sign in with {state.email}.
          </Alert>
          <p className="auth-alt">{me ? <Link to="/account">Back to your account</Link> : <Link to="/login">Sign in</Link>}</p>
        </>
      )}
      {state.kind === "error" && (
        <>
          <Alert tone="danger" title="This link doesn't work">
            {state.message} Confirmation links last 48 hours and work once; you can request a new one on your account page.
          </Alert>
          <p className="auth-alt">{me ? <Link to="/account">Go to your account</Link> : <Link to="/login?next=%2Faccount">Sign in</Link>}</p>
        </>
      )}
    </div>
  );
}
