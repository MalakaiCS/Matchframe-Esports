import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api/index.ts";
import { setLastOrg } from "../lib/storage.ts";
import { navigate } from "../router.tsx";
import { useSession } from "../state/session.tsx";
import { Button, FormError, TextField } from "./ui.tsx";

export function CreateOrgForm() {
  const { me, refresh } = useSession();
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const why = me && !me.user.emailVerified ? "Verify your email address before creating organisations." : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setFieldError("Required.");
      setError("Please fix the highlighted field.");
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      const r = await api.createOrg(name.trim());
      setLastOrg(r.id);
      await refresh();
      navigate(`/orgs/${encodeURIComponent(r.id)}`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <form className="inline-form" onSubmit={submit} noValidate>
      <TextField label="New organisation name" value={name} onValue={setName} maxLength={80} error={fieldError} disabled={!!why} hint="You become its owner. It starts on the free plan with its own billing, computers and team." />
      <div>
        <Button type="submit" busy={busy} disabledReason={why}>
          Create organisation
        </Button>
      </div>
      <FormError error={error} />
    </form>
  );
}
