import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../../api/index.ts";
import { signOut } from "../../components/Layout.tsx";
import { ActionButton, Alert, Button, FormError, PageHeader, TextField } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { pickOrg } from "../../lib/storage.ts";
import { Link, navigate, safeNext, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

function homeFor(orgs: { id: string }[]): string {
  const id = pickOrg(orgs);
  return id ? `/orgs/${encodeURIComponent(id)}` : "/account";
}

export function Login() {
  useTitle("Sign in");
  const { query } = useLocation();
  const { me, refresh, clear } = useSession();
  const next = query.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) {
    return (
      <div className="auth-card">
        <PageHeader title="You're signed in" subtitle={`As ${me.user.displayName} (${me.user.email}).`} />
        <div className="stack">
          <Button variant="primary" block onClick={() => navigate(safeNext(next, homeFor(me.orgs)))}>
            Continue
          </Button>
          <ActionButton variant="ghost" block action={() => signOut(clear)}>
            Sign out to use another account
          </ActionButton>
        </div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = "Enter the email address you signed up with.";
    if (!password) errs.password = "Required.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login({ email: email.trim(), password });
      const m = await refresh();
      navigate(safeNext(next, homeFor(m?.orgs ?? [])));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const signupLink = `/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const linking = next?.startsWith("/link");
  return (
    <div className="auth-card">
      <PageHeader title="Sign in" subtitle={linking ? "Sign in to link your computer to your organisation." : "Welcome back."} />
      {query.get("expired") && <Alert tone="info">Your session ended. Sign in again to continue where you were.</Alert>}
      {query.get("signedOut") && <Alert tone="info">You've signed out of this browser.</Alert>}
      {query.get("reset") && <Alert tone="ok">Password changed. Sign in with your new password.</Alert>}
      <form onSubmit={submit} noValidate className="form">
        <TextField label="Email" name="email" type="email" autoComplete="email" value={email} onValue={setEmail} error={errors.email} required />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" value={password} onValue={setPassword} error={errors.password} required />
        <p className="small">
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
        <FormError error={error} />
        <Button type="submit" variant="primary" block busy={busy}>
          Sign in
        </Button>
      </form>
      <p className="auth-alt">
        New to Matchframe? <Link to={signupLink}>Create an account</Link>
      </p>
    </div>
  );
}
