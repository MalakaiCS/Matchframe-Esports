import { useState } from "react";
import type { FormEvent } from "react";
import { Password } from "@matchframe/cloud-contracts";
import { api, describeError, isApiError } from "../../api/index.ts";
import { Alert, Button, FormError, PageHeader, TextField } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link, navigate, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

export function ResetPassword() {
  useTitle("Choose a new password");
  const { query } = useLocation();
  const { clear } = useSession();
  const token = query.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!token || invalid) {
    return (
      <div className="auth-card">
        <PageHeader title="This reset link doesn't work" />
        <Alert tone="danger" live={!!invalid}>
          {token ? "The link is invalid, already used or expired (links last 60 minutes)." : "The link is missing its token. Open the full link from the email."}
        </Alert>
        <p className="auth-alt">
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const p = Password.safeParse(password);
    if (!p.success) errs.password = "At least 10 characters.";
    if (confirm !== password) errs.confirm = "The passwords don't match.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      // The API signs out every session of this account, including this browser's.
      clear();
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      if (isApiError(err, "invalid_token")) setInvalid(true);
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <PageHeader title="Choose a new password" subtitle="This signs you out on every device; sign in again afterwards." />
      <form onSubmit={submit} noValidate className="form">
        <TextField label="New password" name="password" type="password" autoComplete="new-password" value={password} onValue={setPassword} error={errors.password} hint="At least 10 characters." required minLength={10} />
        <TextField label="Repeat the new password" name="confirm" type="password" autoComplete="new-password" value={confirm} onValue={setConfirm} error={errors.confirm} required />
        <FormError error={error} />
        <Button type="submit" variant="primary" block busy={busy}>
          Set new password
        </Button>
      </form>
    </div>
  );
}
