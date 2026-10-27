import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, describeError } from "../api/index.ts";
import type { CloudLoginOrg, CloudLoginResult, CloudStatus } from "../api/types.ts";
import { fmtTime } from "../lib/format.ts";
import { can } from "../lib/permissions.ts";
import { Link } from "../router.tsx";
import { Button, Field, Note } from "./ui.tsx";

/** Messages from the website arrive as sentences; network and engine problems get the usual explanation. */
function signInError(e: unknown): string {
  if (e instanceof ApiError && e.status !== 401 && e.status !== 403) return e.message;
  if (e instanceof ApiError && e.status === 403 && e.code !== "forbidden" && e.code !== "bad_origin") return e.message;
  return describeError(e);
}

const websiteLink = (status: CloudStatus, path: string) => (status.url ? `${status.url}${path}` : undefined);

function WebsiteAddress({ status, onSaved }: { status: CloudStatus; onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api
          .put("/api/v1/cloud/url", { url: url.trim() })
          .then(onSaved)
          .catch((err) => setError(signInError(err)))
          .finally(() => setBusy(false));
      }}
    >
      <p>Enter the address of the Matchframe website.</p>
      <Field label="Website address" hint="Development builds only; release builds have it built in.">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://matchframe.example" spellCheck={false} autoFocus disabled={status.urlFixed} />
      </Field>
      {error ? <Note tone="danger">{error}</Note> : null}
      <div>
        <Button type="submit" variant="primary" disabledReason={busy ? "Saving…" : url.trim() ? null : "Enter the address first"}>
          Continue
        </Button>
      </div>
    </form>
  );
}

/** Code approved on the website instead of a password (for accounts that prefer it). */
function CodeSignIn({ status, onChange }: { status: CloudStatus; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (status.linkState === "linking" && status.linking)
    return (
      <div className="stack">
        <p>
          On the website, open <strong>Link a computer</strong> and enter this code, or open the link and approve it:
        </p>
        <div className="link-code" aria-label="Link code">
          {status.linking.userCode}
        </div>
        <p>
          <a href={status.linking.verificationUriComplete} target="_blank" rel="noreferrer">
            {status.linking.verificationUriComplete}
          </a>
        </p>
        <p className="muted">The code expires {fmtTime(status.linking.expiresAt)}. This updates by itself once it is approved.</p>
        <div>
          <Button onClick={() => void api.post("/api/v1/cloud/link/cancel").then(onChange)}>Cancel</Button>
        </div>
      </div>
    );
  return (
    <div className="stack">
      {error ? <Note tone="danger">{error}</Note> : null}
      <div>
        <Button
          onClick={() =>
            void api
              .post("/api/v1/cloud/link/start", {})
              .then(onChange)
              .catch((e) => setError(signInError(e)))
          }
        >
          Get a code
        </Button>
      </div>
    </div>
  );
}

/**
 * Email and password of the Matchframe website account. The password goes to the website once
 * (through the engine) and is never stored; the computer keeps only its own sign-in credential.
 */
export function SignInForm({ status, onSignedIn, onChange, autoFocus = false }: { status: CloudStatus; onSignedIn: () => void; onChange: () => void; autoFocus?: boolean }) {
  const [email, setEmail] = useState(status.signIn.user?.email ?? "");
  const [password, setPassword] = useState("");
  const [orgs, setOrgs] = useState<CloudLoginOrg[] | null>(null);
  const [orgId, setOrgId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useCode, setUseCode] = useState(status.linkState === "linking");

  if (!status.url) return <WebsiteAddress status={status} onSaved={onChange} />;
  if (useCode)
    return (
      <div className="stack">
        <CodeSignIn status={status} onChange={onChange} />
        <div>
          <Button variant="ghost" onClick={() => setUseCode(false)}>
            Sign in with email and password instead
          </Button>
        </div>
      </div>
    );

  const submit = (chosenOrg?: string) => {
    setBusy(true);
    setError(null);
    api
      .post<CloudLoginResult>("/api/v1/cloud/login", { email: email.trim(), password, ...(chosenOrg ? { orgId: chosenOrg } : {}) })
      .then((r) => {
        if (r.status === "choose_org") {
          setOrgs(r.orgs);
          setOrgId(r.orgs[0]?.id ?? "");
          return;
        }
        setPassword("");
        setOrgs(null);
        onSignedIn();
      })
      .catch((e) => {
        setError(signInError(e));
        if (e instanceof ApiError && e.code === "invalid_credentials") setPassword("");
      })
      .finally(() => setBusy(false));
  };

  if (orgs)
    return (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit(orgId);
        }}
      >
        <p>Which organisation is this computer for? Its plan provides the auto-director hours.</p>
        <fieldset className="choice-list">
          <legend className="sr-only">Organisation</legend>
          {orgs.map((o) => (
            <label key={o.id} className={`choice ${orgId === o.id ? "is-selected" : ""}`}>
              <input type="radio" name="org" value={o.id} checked={orgId === o.id} onChange={() => setOrgId(o.id)} />
              <span>
                <strong>{o.name}</strong>
                <span className="muted">
                  {" "}
                  · {o.planName} plan · {o.role}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {error ? <Note tone="danger">{error}</Note> : null}
        <div className="row">
          <Button type="submit" variant="primary" disabledReason={busy ? "Signing in…" : orgId ? null : "Choose an organisation"}>
            Continue
          </Button>
          <Button
            onClick={() => {
              setOrgs(null);
              setPassword("");
            }}
          >
            Back
          </Button>
        </div>
      </form>
    );

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Email">
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={autoFocus && !email} required />
      </Field>
      <Field label="Password">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={autoFocus && !!email} required />
      </Field>
      {error ? (
        <Note tone="danger" title="Could not sign in">
          {error}
        </Note>
      ) : null}
      <div className="row signin-actions">
        <Button type="submit" variant="primary" disabledReason={busy ? "Signing in…" : email.trim() && password ? null : "Enter your email and password"}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <a href={websiteLink(status, "/forgot-password")} target="_blank" rel="noreferrer">
          Forgot password?
        </a>
      </div>
      <p className="muted signin-alt">
        No account?{" "}
        <a href={websiteLink(status, "/signup")} target="_blank" rel="noreferrer">
          Create one on the website
        </a>{" "}
        · <button type="button" className="link-btn" onClick={() => setUseCode(true)} title="Approve this computer on the website with a short code instead of a password">Sign in with a code</button>
      </p>
    </form>
  );
}

/** States in which this computer counts as signed in (or does not need to be). */
const PASSES = new Set(["not_required", "signed_in"]);
/** States that mean the sign-in was lost after it had worked in this session. */
const LOST = new Set(["signed_out", "revoked", "offline_expired", "invalid"]);

/**
 * Sign-in is optional: the program opens straight into the HUD Library, and the library and HUD
 * runtime work offline without an account. Only the Auto Director needs one (the engine's arming gate
 * enforces it; the sidebar marks it). Sign in under Settings → Account. When this computer is signed
 * out on the website mid-session, a non-blocking notice says so; nothing is ever locked.
 */
export function SignInNotice({ role }: { role: string | null }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [wasSignedIn, setWasSignedIn] = useState(false);
  const refreshed = useRef(false);

  const load = useCallback(async () => {
    try {
      const st = await api.get<CloudStatus>("/api/v1/cloud/status");
      setStatus(st);
      return st;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void load().then((st) => {
      // Signed in but no licence check yet (e.g. first start after an update): check online once, in the background.
      if (st && st.signIn.state === "unchecked" && !refreshed.current && can(role, "settings.manage")) {
        refreshed.current = true;
        api
          .post<CloudStatus>("/api/v1/cloud/refresh")
          .then(setStatus)
          .catch(() => undefined);
      }
    });
  }, [load, role]);

  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const st = status?.signIn.state;
  useEffect(() => {
    if (st && PASSES.has(st) && st !== "not_required") setWasSignedIn(true);
  }, [st]);

  if (!status || !st || !wasSignedIn || !LOST.has(st)) return null;
  const lastError = status.lastError ? `${status.lastError.charAt(0).toUpperCase()}${status.lastError.slice(1)}. ` : "";
  return (
    <Note tone="warn" title={st === "offline_expired" ? "Matchframe needs to go online" : "Signed out of Matchframe"}>
      {st === "offline_expired" ? "Connect to the internet to keep using the Auto Director. " : lastError}
      The HUD Library, HUDs and manual control keep working. {st === "offline_expired" ? null : <>The Auto Director needs you to sign in again under <Link to="/settings/account">Settings → Account</Link>.</>}
    </Note>
  );
}
