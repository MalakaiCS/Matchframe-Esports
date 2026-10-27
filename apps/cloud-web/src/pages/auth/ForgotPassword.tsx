import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../../api/index.ts";
import { Alert, Button, FormError, PageHeader, TextField } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

export function ForgotPassword() {
  useTitle("Reset password");
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setFieldError("Enter the email address you signed up with.");
      setError("Please fix the highlighted field.");
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <PageHeader title="Reset your password" subtitle="We'll email you a link to choose a new one." />
      {sentTo ? (
        <>
          <Alert tone="ok" title="Check your email">
            If an account exists for <strong>{sentTo}</strong>, a reset link is on its way. It works once and expires in 60 minutes.
          </Alert>
          <p className="auth-alt">
            <Link to="/login">Back to sign in</Link>
          </p>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="form">
          <TextField label="Email" name="email" type="email" autoComplete="email" value={email} onValue={setEmail} error={fieldError} required />
          <FormError error={error} />
          <Button type="submit" variant="primary" block busy={busy}>
            Send reset link
          </Button>
          <p className="auth-alt">
            <Link to="/login">Back to sign in</Link>
          </p>
        </form>
      )}
    </div>
  );
}
