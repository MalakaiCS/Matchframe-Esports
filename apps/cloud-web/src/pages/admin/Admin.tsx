import { useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { api, describeError } from "../../api/index.ts";
import type { AdminOrg } from "../../api/types.ts";
import { Alert, Badge, Button, Card, Empty, ErrorState, FormError, Hours, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDate, formatDateTime, fromDateInput } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { STATUS_LABEL, statusTone } from "../../lib/roles.ts";
import { Link } from "../../router.tsx";
import { CatalogEditor } from "./Catalog.tsx";

type TabId = "orgs" | "catalog" | "stripe" | "audit";
const TABS: { id: TabId; label: string }[] = [
  { id: "orgs", label: "Organisations" },
  { id: "catalog", label: "Catalogue" },
  { id: "stripe", label: "Stripe events" },
  { id: "audit", label: "Audit log" },
];

function Tabs({ active, onChange, children }: { active: TabId; onChange: (t: TabId) => void; children: ReactNode }) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.id === active);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const id = TABS[n]!.id;
    onChange(id);
    refs.current[id]?.focus();
  }
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Admin sections" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={active === t.id ? 0 : -1}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${active}`} className="tabpanel">
        {children}
      </div>
    </>
  );
}

function GrantForm({ org, onDone, onCancel }: { org: AdminOrg; onDone: (msg: string) => void; onCancel: () => void }) {
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const h = Number(hours);
    const errs: Record<string, string> = {};
    if (!Number.isFinite(h) || h <= 0 || h > 10000) errs.hours = "Between 0 and 10,000 hours (decimals allowed).";
    if (note.trim().length < 3) errs.note = "At least 3 characters, e.g. \"support credit, ticket 123\".";
    const exp = expires ? fromDateInput(expires, true) : null;
    if (expires && !exp) errs.expires = "Pick a valid date.";
    setErrors(errs);
    if (Object.keys(errs).length) return setError("Please fix the highlighted fields.");
    setBusy(true);
    setError(null);
    try {
      await api.grantHours(org.id, { hours: h, note: note.trim(), expiresAt: exp });
      onDone(`Granted ${h} h to ${org.name}.`);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }
  return (
    <form className="grant-form" onSubmit={submit} noValidate aria-label={`Grant hours to ${org.name}`}>
      <TextField label="Hours" type="number" inputMode="decimal" min={0} step="0.25" value={hours} onValue={setHours} error={errors.hours} />
      <TextField label="Note (shown to the organisation)" value={note} onValue={setNote} maxLength={200} error={errors.note} />
      <TextField label="Expires after" type="date" optional value={expires} onValue={setExpires} error={errors.expires} hint="Leave empty for credits that never expire." />
      <div className="button-row">
        <Button type="submit" variant="primary" busy={busy}>
          Grant hours
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FormError error={error} />
    </form>
  );
}

function OrgsTab() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [granting, setGranting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const orgs = useResource(`admin-orgs:${query}`, () => api.adminOrgs(query));
  return (
    <div className="stack">
      <form
        className="search-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <TextField label="Search organisations" type="search" value={q} onValue={setQ} placeholder="Name, member email or org id" />
        <Button type="submit">Search</Button>
      </form>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {orgs.loading && !orgs.data && <Loading />}
      {orgs.error && <ErrorState error={orgs.error} onRetry={orgs.reload} />}
      {orgs.data && orgs.data.length === 0 && <Empty title="No organisations match" />}
      {orgs.data && orgs.data.length > 0 && (
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Organisation</th>
              <th scope="col">Owner</th>
              <th scope="col">Plan</th>
              <th scope="col">Members</th>
              <th scope="col">Computers</th>
              <th scope="col">Used</th>
              <th scope="col">Remaining</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {orgs.data.map((o) => (
              <tr key={o.id}>
                <td data-label="Organisation">
                  <span className="strong">{o.name}</span>
                  <span className="mono small block muted">{o.id}</span>
                  <span className="small block muted">created {formatDate(o.createdAt)}</span>
                </td>
                <td data-label="Owner">{o.ownerEmail ?? "—"}</td>
                <td data-label="Plan">
                  {o.planId} <Badge tone={statusTone(o.subscriptionStatus)}>{STATUS_LABEL[o.subscriptionStatus]}</Badge>
                </td>
                <td data-label="Members">{o.members}</td>
                <td data-label="Computers">{o.devices}</td>
                <td data-label="Used">
                  <Hours seconds={o.usedSeconds} />
                </td>
                <td data-label="Remaining" className={o.remainingSeconds < 0 ? "text-danger" : undefined}>
                  <Hours seconds={o.remainingSeconds} />
                </td>
                <td data-label="Actions" className="cell-actions">
                  {granting === o.id ? (
                    <GrantForm
                      org={o}
                      onCancel={() => setGranting(null)}
                      onDone={(m) => {
                        setGranting(null);
                        setNotice(m);
                        void orgs.reload();
                      }}
                    />
                  ) : (
                    <span className="button-row">
                      <Button size="sm" onClick={() => setGranting(o.id)}>
                        Grant hours
                      </Button>
                      <Link className="btn btn-ghost btn-sm" to={`/orgs/${encodeURIComponent(o.id)}`}>
                        View
                      </Link>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {orgs.data && orgs.data.length >= 200 && <p className="small muted">Showing the newest 200 matches; refine the search.</p>}
    </div>
  );
}

function StripeTab() {
  const ev = useResource("stripe-events", api.stripeEvents);
  return (
    <div className="stack">
      <div className="button-row">
        <Button size="sm" onClick={() => void ev.reload()} busy={ev.loading}>
          Refresh
        </Button>
      </div>
      {ev.error && <ErrorState error={ev.error} onRetry={ev.reload} />}
      {ev.loading && !ev.data && <Loading />}
      {ev.data && ev.data.length === 0 && <Empty title="No Stripe webhook events received yet" />}
      {ev.data && ev.data.length > 0 && (
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Type</th>
              <th scope="col">Event</th>
              <th scope="col">Processed</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {ev.data.map((e) => (
              <tr key={e.id}>
                <td data-label="Received">{formatDateTime(e.receivedAt)}</td>
                <td data-label="Type" className="mono">
                  {e.type}
                </td>
                <td data-label="Event" className="mono small">
                  {e.id}
                </td>
                <td data-label="Processed">{e.processedAt ? formatDateTime(e.processedAt) : <Badge tone={e.error ? "danger" : "warn"}>{e.error ? "Failed" : "Pending"}</Badge>}</td>
                <td data-label="Error" className="small">
                  {e.error ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuditTab() {
  const [orgId, setOrgId] = useState("");
  const [filter, setFilter] = useState("");
  const log = useResource(`audit:${filter}`, () => api.audit(filter || undefined));
  return (
    <div className="stack">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(orgId.trim());
        }}
      >
        <TextField label="Organisation id" optional value={orgId} onValue={setOrgId} placeholder="org_…" />
        <Button type="submit">Filter</Button>
      </form>
      {log.error && <ErrorState error={log.error} onRetry={log.reload} />}
      {log.loading && !log.data && <Loading />}
      {log.data && log.data.length === 0 && <Empty title="No audit events" />}
      {log.data && log.data.length > 0 && (
        <table className="rtable">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Organisation</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {log.data.map((a) => (
              <tr key={a.id}>
                <td data-label="Time">{formatDateTime(a.at)}</td>
                <td data-label="Action" className="mono">
                  {a.action}
                </td>
                <td data-label="Actor" className="mono small">
                  {a.actor}
                </td>
                <td data-label="Organisation" className="mono small">
                  {a.orgId ?? "—"}
                </td>
                <td data-label="Detail">
                  {a.detail && typeof a.detail === "object" && Object.keys(a.detail as object).length > 0 ? (
                    <details>
                      <summary>Show</summary>
                      <pre className="json">{JSON.stringify(a.detail, null, 2)}</pre>
                    </details>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {log.data && log.data.length >= 300 && <p className="small muted">Showing the latest 300 events.</p>}
    </div>
  );
}

export function Admin() {
  useTitle("Admin");
  const [tab, setTab] = useState<TabId>("orgs");
  return (
    <>
      <PageHeader title="Admin" subtitle="Staff tools: organisations, hour grants, the plan catalogue, Stripe webhooks and the audit log." eyebrow="Matchframe staff" />
      <Card>
        <Tabs active={tab} onChange={setTab}>
          {tab === "orgs" && <OrgsTab />}
          {tab === "catalog" && <CatalogEditor />}
          {tab === "stripe" && <StripeTab />}
          {tab === "audit" && <AuditTab />}
        </Tabs>
      </Card>
    </>
  );
}
