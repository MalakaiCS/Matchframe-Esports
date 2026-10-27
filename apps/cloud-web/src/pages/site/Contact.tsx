import { useState } from "react";
import type { FormEvent } from "react";
import { ContactRequest as ContactSchema } from "@matchframe/cloud-contracts";
import { api, describeError, fieldErrors, isApiError } from "../../api/index.ts";
import type { ContactTopic } from "../../api/types.ts";
import { Icon } from "../../components/icons.tsx";
import { PageHero } from "../../components/marketing.tsx";
import { Alert, Button, FieldShell, FormError, SelectField, TextField } from "../../components/ui.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { pickOrg } from "../../lib/storage.ts";
import { validate } from "../../lib/validate.ts";
import { Link, useLocation } from "../../router.tsx";
import { useSession } from "../../state/session.tsx";
import { useSite } from "../../state/site.ts";

export const CONTACT_TOPICS: { value: ContactTopic; label: string }[] = [
  { value: "support", label: "Help with my account or the program" },
  { value: "billing", label: "Billing, invoices or payments" },
  { value: "sales", label: "Plans, pricing or larger events" },
  { value: "legal", label: "Legal or privacy request" },
  { value: "other", label: "Something else" },
];

const isTopic = (t: string | null): t is ContactTopic => CONTACT_TOPICS.some((x) => x.value === t);
const MAX = 5000;

export function Contact() {
  useTitle("Contact", "Contact the Matchframe team about your account, billing, plans, legal or privacy questions, or anything else.");
  const { me } = useSession();
  const { site } = useSite();
  const { query } = useLocation();
  const initialTopic = query.get("topic");
  const orgs = me?.orgs ?? [];
  const [v, setV] = useState({
    name: me?.user.displayName ?? "",
    email: me?.user.email ?? "",
    topic: (isTopic(initialTopic) ? initialTopic : "support") as ContactTopic,
    message: "",
    orgId: me ? (pickOrg(orgs) ?? "") : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name: v.name.trim(), email: v.email.trim(), topic: v.topic, message: v.message.trim(), orgId: v.orgId || null };
    const errs = validate(ContactSchema, body);
    if (errs.message && body.message.length < 10) errs.message = "Please write at least 10 characters so we can help.";
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.contact(body);
      setSent(body.email);
      setV((s) => ({ ...s, message: "" }));
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(isApiError(err) && err.status === 429 ? "You've sent several messages in a short time. Please wait a few minutes and try again." : describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHero eyebrow="Contact" title="Get in touch" lead="Questions about your account, an invoice, a larger event or the program? Send us a message and we'll reply by email." />
      <div className="wrap section-top contact-layout">
        <section className="card contact-card" aria-labelledby="contact-form-title">
          <h2 id="contact-form-title" className="card-title">
            Send us a message
          </h2>
          {sent ? (
            <div className="contact-done">
              <Alert tone="ok" title="Thanks, we've received your message">
                We'll reply to {sent}. You don't need to send it again.
              </Alert>
              <Button onClick={() => setSent(null)}>Send another message</Button>
            </div>
          ) : (
            <form className="form" onSubmit={submit} noValidate>
              <div className="form-row">
                <TextField label="Your name" autoComplete="name" value={v.name} onValue={set("name")} maxLength={80} error={errors.name} required />
                <TextField label="Email" type="email" autoComplete="email" value={v.email} onValue={set("email")} error={errors.email} hint="We'll reply to this address." required />
              </div>
              <SelectField label="Topic" value={v.topic} onValue={set("topic")} error={errors.topic}>
                {CONTACT_TOPICS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SelectField>
              {orgs.length > 0 && (
                <SelectField label="Organisation" value={v.orgId} onValue={set("orgId")} hint="Helps us find your account faster.">
                  <option value="">Not about a specific organisation</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </SelectField>
              )}
              <FieldShell label="Message" error={errors.message} hint={`${v.message.trim().length.toLocaleString()} / ${MAX.toLocaleString()} characters. Please don't include passwords or card numbers.`}>
                {({ id, describedBy, invalid }) => <textarea id={id} rows={7} maxLength={MAX} value={v.message} aria-describedby={describedBy} aria-invalid={invalid || undefined} onChange={(e) => set("message")(e.target.value)} required />}
              </FieldShell>
              <FormError error={error} />
              <div>
                <Button type="submit" variant="primary" busy={busy}>
                  Send message
                </Button>
              </div>
              <p className="small muted">
                We use your details only to answer your message. See the <Link to="/legal/privacy">privacy policy</Link>.
              </p>
            </form>
          )}
        </section>
        <aside className="contact-side" aria-label="Other ways to get help">
          {site?.supportEmail && (
            <div className="side-card">
              <p className="side-card-title">
                <Icon name="mail" size={18} /> Email
              </p>
              <p>
                <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
              </p>
              <p className="small muted">For account questions, write from the address you use to sign in.</p>
            </div>
          )}
          <div className="side-card">
            <p className="side-card-title">
              <Icon name="book" size={18} /> Help centre
            </p>
            <p className="small muted">Most questions about accounts, hours and invoices are answered there.</p>
            <Link to="/help" className="link-arrow">
              Browse guides <Icon name="arrow" size={18} />
            </Link>
          </div>
          <div className="side-card">
            <p className="side-card-title">
              <Icon name="server" size={18} /> Service status
            </p>
            <p className="small muted">Check whether the website and API are running normally.</p>
            <Link to="/status" className="link-arrow">
              View status <Icon name="arrow" size={18} />
            </Link>
          </div>
          {site?.address && (
            <div className="side-card">
              <p className="side-card-title">Postal address</p>
              <address className="small">
                {site.companyName}
                <br />
                {site.address}
              </address>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
