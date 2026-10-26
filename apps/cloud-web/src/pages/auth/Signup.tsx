import { useState } from "react";
import type { FormEvent } from "react";
import { SignupRequest } from "@matchframe/cloud-contracts";
import { api, describeError, fieldErrors, isApiError } from "../../api/index.ts";
import { Button, FormError, PageHeader, TextField } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { validate } from "../../lib/validate.ts";
import { Link, navigate, safeNext, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";

export function Signup() {
  useTitle("Create account");
  const { query } = useLocation();
  const { refresh } = useSession();
  const next = query.get("next");
  const plan = query.get("plan");
  const [v, setV] = useState({ displayName: "", email: query.get("email") ?? "", password: "", orgName: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState(false);
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validate(SignupRequest, v);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.signup({ ...v, email: v.email.trim() });
      await refresh();
      const fallback = plan ? `/orgs/${encodeURIComponent(r.orgId)}/billing?plan=${encodeURIComponent(plan)}#plans` : `/orgs/${encodeURIComponent(r.orgId)}`;
      navigate(safeNext(next, fallback));
    } catch (err) {
      const isTaken = isApiError(err, "email_taken");
      setTaken(isTaken);
      setErrors(isTaken ? { email: "An account with this email already exists." } : fieldErrors(err));
      setError(describeError(err));
      setBusy(false);
    }
  }

  const loginLink = `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <div className="auth-card">
      <PageHeader title="Create your account" subtitle="Free to start. You'll get an organisation for your team; invite others later." />
      <form onSubmit={submit} noValidate className="form">
        <TextField label="Your name" name="displayName" autoComplete="name" value={v.displayName} onValue={set("displayName")} error={errors.displayName} required maxLength={80} />
        <TextField label="Email" name="email" type="email" autoComplete="email" value={v.email} onValue={set("email")} error={errors.email} required />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" value={v.password} onValue={set("password")} error={errors.password} hint="At least 10 characters." required minLength={10} />
        <TextField label="Team or organisation name" name="orgName" autoComplete="organization" value={v.orgName} onValue={set("orgName")} error={errors.orgName} hint="Usually your production team or league. You can rename it later." required maxLength={80} />
        <FormError error={error} />
        {taken && (
          <p className="small">
            <Link to={loginLink}>Sign in</Link> or <Link to="/forgot-password">reset your password</Link>.
          </p>
        )}
        <Button type="submit" variant="primary" block busy={busy}>
          Create account
        </Button>
        <p className="small muted">We'll email you a link to confirm your address.</p>
      </form>
      <p className="auth-alt">
        Already have an account? <Link to={loginLink}>Sign in</Link>
      </p>
    </div>
  );
}
