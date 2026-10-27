import { useState } from "react";
import { api } from "../../api/index.ts";
import { Pagination } from "../../components/data.tsx";
import { Badge, Button, Card, Empty, ErrorState, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { CatalogEditor } from "./Catalog.tsx";
import { AdminOnlyNote, useStaffRole } from "./shared.tsx";

export function AdminCatalog() {
  useTitle("Catalogue · Admin");
  const { isAdmin, role } = useStaffRole();
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Catalogue" subtitle="Plans and hour packs shown on the pricing and billing pages, with their Stripe prices." />
      {!isAdmin && <AdminOnlyNote role={role} what="You can view the catalogue, but creating and editing plans and hour packs is hidden." />}
      <Card>
        <CatalogEditor readOnly={!isAdmin} />
      </Card>
    </>
  );
}

export function AdminStripe() {
  useTitle("Stripe events · Admin");
  const { isAdmin, role } = useStaffRole();
  const ev = useResource(isAdmin ? "stripe-events" : null, api.stripeEvents);
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Stripe events" subtitle="Webhook events received from Stripe and any processing errors." actions={isAdmin ? <Button size="sm" onClick={() => void ev.reload()} busy={ev.loading}>Refresh</Button> : undefined} />
      {!isAdmin ? (
        <AdminOnlyNote role={role} what="Stripe webhook events contain payment details and are only shown to admins." />
      ) : (
        <>
          {ev.error && <ErrorState error={ev.error} onRetry={ev.reload} />}
          {ev.loading && !ev.data && <Loading />}
          {ev.data && ev.data.length === 0 && <Empty title="No Stripe webhook events received yet" />}
          {ev.data && ev.data.length > 0 && (
            <div className="table-card">
              <table className="rtable data-table">
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
            </div>
          )}
        </>
      )}
    </>
  );
}

const AUDIT_PAGE = 50;

export function AdminAudit() {
  useTitle("Audit log · Admin");
  const [orgId, setOrgId] = useState("");
  const [filter, setFilter] = useState("");
  const [text, setText] = useState("");
  const [page, setPage] = useState(1);
  const log = useResource(`audit:${filter}`, () => api.audit(filter || undefined));
  const needle = text.trim().toLowerCase();
  const rows = (log.data ?? []).filter((a) => !needle || a.action.toLowerCase().includes(needle) || a.actor.toLowerCase().includes(needle));
  const shown = rows.slice((page - 1) * AUDIT_PAGE, page * AUDIT_PAGE);
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Audit log" subtitle="Security-relevant changes by customers and staff, newest first." />
      <div className="toolbar">
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(orgId.trim());
            setPage(1);
          }}
        >
          <TextField label="Organisation id" optional value={orgId} onValue={setOrgId} placeholder="org_…" />
          <Button type="submit">Load</Button>
        </form>
        <div className="search-form search-form-inline">
          <TextField
            label="Filter by action or actor"
            type="search"
            value={text}
            onValue={(v) => {
              setText(v);
              setPage(1);
            }}
            placeholder="e.g. admin.staff_role"
          />
        </div>
      </div>
      {log.error && <ErrorState error={log.error} onRetry={log.reload} />}
      {log.loading && !log.data && <Loading />}
      {log.data && rows.length === 0 && <Empty title="No audit events" />}
      {rows.length > 0 && (
        <div className="table-card">
          <table className="rtable data-table">
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
              {shown.map((a) => (
                <tr key={a.id}>
                  <td data-label="Time">{formatDateTime(a.at)}</td>
                  <td data-label="Action" className="mono small">
                    {a.action}
                  </td>
                  <td data-label="Actor" className="mono small">
                    {a.actor.startsWith("usr_") ? <Link to={`/admin/users/${encodeURIComponent(a.actor)}`}>{a.actor}</Link> : a.actor}
                  </td>
                  <td data-label="Organisation" className="mono small">
                    {a.orgId ? <Link to={`/admin/orgs/${encodeURIComponent(a.orgId)}`}>{a.orgId}</Link> : "—"}
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
          <Pagination page={page} pageSize={AUDIT_PAGE} total={rows.length} onPage={setPage} label="events" />
        </div>
      )}
      {log.data && log.data.length >= 300 && <p className="small muted">The server returns the latest 300 events{filter ? " for this organisation" : ""}.</p>}
    </>
  );
}
