import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError, isApiError } from "../api/index.ts";
import type { DeviceLinkPreview, OrgView } from "../api/types.ts";
import { ActionButton, Alert, Button, Card, ErrorState, FormError, Loading, PageHeader, TextField } from "../components/ui.tsx";
import { formatCountdown, formatDateTime, platformLabel } from "../lib/format.ts";
import { useNow, useResource, useTitle } from "../lib/hooks.ts";
import { ROLE_LABEL, can } from "../lib/roles.ts";
import { getLastOrg } from "../lib/storage.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { useSession } from "../state/session.tsx";

const CODE_RE = /^[A-Z]{4}-[A-Z]{4}$/;

/** Uppercases, keeps letters only and inserts the hyphen: "bcdf ghjk" → "BCDF-GHJK". */
export function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function CodeEntry({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const [code, setCode] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const c = normalizeCode(code);
    if (!CODE_RE.test(c)) {
      setError("Enter the 8-letter code shown in the Matchframe program, like BCDF-GHJK.");
      return;
    }
    setError(null);
    navigate(`/link?code=${c}`);
  }
  return (
    <form onSubmit={submit} noValidate className="form code-form">
      <TextField
        label="Code from the Matchframe program"
        name="code"
        value={code}
        onValue={(v) => setCode(normalizeCode(v))}
        placeholder="XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={9}
        className="code-input"
        error={error}
        hint="In the program open Account & Hours → Link this computer to see it. Codes expire after 10 minutes."
        autoFocus={autoFocus}
      />
      <Button type="submit" variant="primary">
        Continue
      </Button>
    </form>
  );
}

type Outcome = { kind: "approved"; deviceName: string; orgId: string; orgName: string } | { kind: "denied" };

function OrgCapacity({ orgId }: { orgId: string }) {
  const info = useResource(`cap:${orgId}`, async () => {
    const [org, devices] = await Promise.all([api.org(orgId), api.devices(orgId)]);
    return { plan: org.plan, active: devices.filter((d) => !d.revokedAt).length };
  });
  if (!info.data) return null;
  const { plan, active } = info.data;
  const full = active >= plan.features.maxDevices;
  return (
    <p className={`small ${full ? "text-warn" : "muted"}`}>
      {active} of {plan.features.maxDevices} linked {plan.features.maxDevices === 1 ? "computer" : "computers"} on the {plan.name} plan.
      {full && " Approving a new computer will fail unless you unlink one first (re-linking a computer that was linked before is fine)."}
    </p>
  );
}

function Pending({ code, preview, orgs, verified, onOutcome, onInvalid }: { code: string; preview: DeviceLinkPreview; orgs: OrgView[]; verified: boolean; onOutcome: (o: Outcome) => void; onInvalid: (message: string) => void }) {
  const now = useNow(1000);
  const linkable = orgs.filter((o) => can(o.role, "devices.link"));
  const last = getLastOrg();
  const [orgId, setOrgId] = useState<string>(() => (linkable.find((o) => o.id === last) ?? linkable[0])?.id ?? "");
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const groupId = useId();
  const expired = new Date(preview.expiresAt).getTime() <= now;
  const org = orgs.find((o) => o.id === orgId);

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const r = await api.approveLink(code, orgId);
      onOutcome({ kind: "approved", deviceName: r.deviceName, orgId, orgName: org?.name ?? "" });
    } catch (e) {
      if (isApiError(e, "invalid_code")) return onInvalid(describeError(e));
      setError({ message: describeError(e), code: isApiError(e) ? e.code : null });
      setBusy(null);
    }
  }

  async function deny() {
    setBusy("deny");
    setError(null);
    try {
      await api.denyLink(code);
      onOutcome({ kind: "denied" });
    } catch (e) {
      setError({ message: describeError(e), code: isApiError(e) ? e.code : null });
      setBusy(null);
    }
  }

  const approveReason = expired ? "This code has expired. Start linking again in the program." : !verified ? "Verify your email address before linking computers." : linkable.length === 0 ? "None of your organisations lets your role link computers." : !orgId ? "Choose an organisation first." : null;

  return (
    <Card title="A computer wants to link to your account">
      <dl className="kv device-kv">
        <div>
          <dt>Computer</dt>
          <dd className="strong">{preview.deviceName}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{platformLabel(preview.platform)}</dd>
        </div>
        <div>
          <dt>App version</dt>
          <dd>{preview.appVersion || "—"}</dd>
        </div>
        <div>
          <dt>Code</dt>
          <dd className="mono">{code}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{formatDateTime(preview.requestedAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            {expired ? (
              <span className="text-danger">Expired</span>
            ) : (
              <>
                in <span className="mono">{formatCountdown(preview.expiresAt, now)}</span>
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="small muted">Only approve if this is your computer and the code matches the one shown in the Matchframe program.</p>

      <fieldset className="org-pick">
        <legend id={groupId}>Link it to</legend>
        {orgs.map((o) => {
          const allowed = can(o.role, "devices.link");
          return (
            <label key={o.id} className={`org-option${allowed ? "" : " is-disabled"}`}>
              <input type="radio" name="org" value={o.id} checked={orgId === o.id} disabled={!allowed} onChange={() => setOrgId(o.id)} />
              <span>
                <span className="org-option-name">{o.name}</span>
                <span className="muted small">
                  {" "}
                  {ROLE_LABEL[o.role]}
                  {!allowed && " — billing members can't link computers"}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {orgId && <OrgCapacity orgId={orgId} />}

      {!verified && (
        <Alert tone="warn" title="Verify your email first">
          Linking computers needs a verified email address. Open the link we emailed you, then reload this page. <ResendLink />
        </Alert>
      )}
      {error && error.code === "device_limit" && (
        <Alert tone="danger" title="This organisation has no free computer slot">
          {error.message}{" "}
          <span className="inline-links">
            <Link to={`/orgs/${encodeURIComponent(orgId)}/computers`}>Unlink a computer</Link> · <Link to={`/orgs/${encodeURIComponent(orgId)}/billing#plans`}>Upgrade the plan</Link>
          </span>
        </Alert>
      )}
      {error && error.code === "email_unverified" && (
        <Alert tone="warn" title="Verify your email first">
          {error.message} <ResendLink />
        </Alert>
      )}
      <FormError error={error && error.code !== "device_limit" && error.code !== "email_unverified" ? error.message : null} />
      <div className="button-row">
        <Button variant="primary" busy={busy === "approve"} disabled={busy !== null} disabledReason={approveReason} onClick={approve}>
          Approve and link
        </Button>
        <Button variant="danger" busy={busy === "deny"} disabled={busy !== null} disabledReason={expired ? "This code has already expired." : null} onClick={deny}>
          Deny
        </Button>
      </div>
    </Card>
  );
}

function ResendLink() {
  const [sent, setSent] = useState(false);
  if (sent) return <span>Sent — check your inbox.</span>;
  return (
    <ActionButton size="sm" variant="ghost" action={async () => {
      await api.resendVerification();
      setSent(true);
    }}>
      Resend the email
    </ActionButton>
  );
}

export function LinkComputer() {
  useTitle("Link a computer");
  const { query } = useLocation();
  const { me } = useSession();
  const raw = query.get("code") ?? "";
  const code = normalizeCode(raw);
  const valid = CODE_RE.test(code);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const preview = useResource(valid && !outcome ? `link:${code}` : null, () => api.previewLink(code));

  useEffect(() => {
    setOutcome(null);
    setInvalid(null);
  }, [code]);

  if (!me) return null;

  const invalidMessage = invalid ?? (isApiError(preview.cause, "invalid_code") ? describeError(preview.cause) : null);

  return (
    <div className="link-page">
      <PageHeader title="Link a computer" subtitle="Approve which computer uses your organisation's plan and auto-director hours." />
      {outcome?.kind === "approved" && (
        <Card>
          <Alert tone="ok" title={`${outcome.deviceName} is approved`}>
            Return to the Matchframe program: it finishes linking within a few seconds and then uses the {outcome.orgName} plan.
          </Alert>
          <p className="button-row">
            <Link className="btn btn-primary" to={`/orgs/${encodeURIComponent(outcome.orgId)}/computers`}>
              See linked computers
            </Link>
            <Link className="btn btn-ghost" to="/link">
              Link another computer
            </Link>
          </p>
        </Card>
      )}
      {outcome?.kind === "denied" && (
        <Card>
          <Alert tone="info" title="Request denied">
            The program will report that linking was refused. If that was a mistake, start linking again in the program.
          </Alert>
          <p>
            <Link to="/link">Enter another code</Link>
          </p>
        </Card>
      )}
      {!outcome && raw && !valid && (
        <>
          <Alert tone="danger" title="That doesn't look like a link code">
            Codes have 8 letters, like BCDF-GHJK. Check the code in the Matchframe program.
          </Alert>
          <Card title="Enter the code">
            <CodeEntry initial={code} autoFocus />
          </Card>
        </>
      )}
      {!outcome && !raw && (
        <Card title="Enter the code">
          <ol className="plain-steps">
            <li>
              In the Matchframe program open <strong>Account &amp; Hours → Link this computer</strong>.
            </li>
            <li>Type the code it shows below (or click the link the program opens, which fills it in).</li>
          </ol>
          <CodeEntry autoFocus />
        </Card>
      )}
      {!outcome && valid && (
        <>
          {invalidMessage ? (
            <>
              <Alert tone="danger" title="This code can't be used">
                {invalidMessage}
              </Alert>
              <Card title="Try another code">
                <CodeEntry />
              </Card>
            </>
          ) : preview.loading && !preview.data ? (
            <Loading label="Looking up the computer…" />
          ) : preview.error ? (
            <ErrorState error={preview.error} onRetry={preview.reload} />
          ) : preview.data ? (
            <Pending code={code} preview={preview.data} orgs={me.orgs} verified={me.user.emailVerified} onOutcome={setOutcome} onInvalid={setInvalid} />
          ) : null}
        </>
      )}
    </div>
  );
}
