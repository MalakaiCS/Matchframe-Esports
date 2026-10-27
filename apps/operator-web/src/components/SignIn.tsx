import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, describeError, NetworkError } from "../api/index.ts";
import type { CloudLoginOrg, CloudLoginResult, CloudStatus } from "../api/types.ts";
import { fmtTime } from "../lib/format.ts";
import { can } from "../lib/permissions.ts";
import { Logo } from "./icons.tsx";
import { Button, Field, Loading, Note } from "./ui.tsx";

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
      <p>This build does not know the Matchframe website yet. Enter its address (development builds only; release builds have it built in).</p>
      <Field label="Website address">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://matchframe.example" spellCheck={false} autoFocus disabled={status.urlFixed} />
      </Field>
      {error ? <Note tone="danger">{error}</Note> : null}
      <div>
        <Button type="submit" variant="primary" disabledReason={busy ? "Saving…" : url.trim() ? null : "Enter the address first"} reasonPlacement="tooltip">
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
        <p>Your account belongs to more than one organisation. Which one is this computer for? Its plan provides the auto-director hours.</p>
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
          <Button type="submit" variant="primary" disabledReason={busy ? "Signing in…" : orgId ? null : "Choose an organisation"} reasonPlacement="tooltip">
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
        <Button type="submit" variant="primary" disabledReason={busy ? "Signing in…" : email.trim() && password ? null : "Enter your email and password"} reasonPlacement="tooltip">
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
        · <button type="button" className="link-button" onClick={() => setUseCode(true)}>Sign in with a code from the website</button>
      </p>
    </form>
  );
}

function GateCard({ children }: { children: ReactNode }) {
  return (
    <div className="gate">
      <div className="gate-card signin-card">
        <div className="gate-brand">
          <Logo /> <span>Matchframe</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const PASSES = new Set(["not_required", "signed_in"]);

/**
 * The program asks to sign in to a Matchframe account when it opens (release builds). Once past
 * this screen it is never locked again while open: being signed out on the website mid-broadcast
 * only shows a notice (the camera and HUDs keep running), and the next start asks to sign in again.
 */
export function SignInGate({ role, children }: { role: string | null; children: (notice: ReactNode) => ReactNode }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const refreshed = useRef(false);

  const load = useCallback(async () => {
    try {
      const st = await api.get<CloudStatus>("/api/v1/cloud/status");
      setStatus(st);
      setError(null);
      if (PASSES.has(st.signIn.state)) setUnlocked(true);
      return st;
    } catch (e) {
      setError(describeError(e));
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const st = await api.post<CloudStatus>("/api/v1/cloud/refresh");
      setStatus(st);
      if (PASSES.has(st.signIn.state)) setUnlocked(true);
    } catch (e) {
      setError(e instanceof NetworkError ? describeError(e) : signInError(e));
    }
  }, []);

  useEffect(() => {
    void load().then((st) => {
      // Signed in but no licence yet (e.g. first start after an update): check online once.
      if (st && st.signIn.state === "unchecked" && !refreshed.current && can(role, "settings.manage")) {
        refreshed.current = true;
        void refresh();
      }
    });
  }, [load, refresh, role]);

  // Poll while the gate is shown (a code approved on the website); slowly afterwards for the notice.
  useEffect(() => {
    const t = setInterval(() => void load(), unlocked ? 30_000 : 3000);
    return () => clearInterval(t);
  }, [load, unlocked]);

  if (unlocked) {
    const st = status?.signIn.state;
    const notice =
      status && st && !PASSES.has(st) ? (
        <Note tone="warn" title={st === "offline_expired" ? "Matchframe needs to go online" : "Signed out of Matchframe"}>
          {st === "offline_expired"
            ? "This computer has not reached the Matchframe website within the offline period. Everything keeps running until you close the program; connect to the internet so the next start does not ask you to sign in."
            : `${status.lastError ? `${status.lastError.charAt(0).toUpperCase()}${status.lastError.slice(1)}. ` : ""}Everything keeps running until you close the program. Sign in again on Account & Hours.`}
        </Note>
      ) : null;
    return <>{children(notice)}</>;
  }

  if (!status)
    return (
      <GateCard>
        {error ? (
          <>
            <Note tone="danger" title="Cannot read the sign-in state">
              {error}
            </Note>
            <div>
              <Button variant="primary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <Loading label="Checking your Matchframe sign-in…" />
        )}
      </GateCard>
    );

  const st = status.signIn.state;
  if (!can(role, "settings.manage"))
    return (
      <GateCard>
        <h1 className="signin-title">The production computer is not signed in</h1>
        <p>Sign in to Matchframe on the production computer first; this program is connected to it.</p>
        <div className="row">
          <Button variant="primary" onClick={() => void load()}>
            Check again
          </Button>
          {window.matchframe?.openConnection ? <Button onClick={() => void window.matchframe!.openConnection!()}>Connection settings</Button> : null}
        </div>
      </GateCard>
    );

  const user = status.signIn.user;
  if (st === "offline_expired" || st === "unchecked" || st === "invalid")
    return (
      <GateCard>
        <h1 className="signin-title">{st === "offline_expired" ? "Matchframe needs to go online" : "Checking your sign-in"}</h1>
        <p>
          {st === "offline_expired"
            ? `Matchframe works offline for ${status.entitlement ? `up to ${Math.round((Date.parse(status.entitlement.graceUntil) - Date.parse(status.entitlement.issuedAt)) / 86_400_000)} days` : "a limited time"} after its last check. Connect this computer to the internet and try again.`
            : "Your sign-in has to be confirmed by the Matchframe website once. Make sure this computer is online."}
        </p>
        {user ? (
          <p className="muted">
            Signed in as <strong>{user.displayName}</strong> ({user.email}){status.device ? ` · ${status.device.orgName}` : ""}
          </p>
        ) : null}
        {status.lastError ? <Note tone="warn">{status.lastError}</Note> : null}
        {error ? <Note tone="danger">{error}</Note> : null}
        <div className="row">
          <Button variant="primary" onClick={() => void refresh()}>
            Try again
          </Button>
          <Button onClick={() => void api.post("/api/v1/cloud/unlink").then(load)}>Sign in as someone else</Button>
        </div>
      </GateCard>
    );

  return (
    <GateCard>
      <h1 className="signin-title">Sign in to Matchframe</h1>
      <p className="muted">Use the email and password of your Matchframe website account.</p>
      {st === "revoked" ? (
        <Note tone="warn" title="You were signed out">
          {status.lastError ? `${status.lastError.charAt(0).toUpperCase()}${status.lastError.slice(1)}.` : "This computer was signed out on the website."} Sign in again to continue.
        </Note>
      ) : null}
      <SignInForm status={status} onSignedIn={() => void load()} onChange={() => void load()} autoFocus />
      <p className="gate-foot">The password is sent to the Matchframe website once and never stored on this computer. Works offline for up to 7 days after each check.</p>
    </GateCard>
  );
}
