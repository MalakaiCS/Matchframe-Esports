import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import { Badge, Button, Empty, ErrorState, Hours, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDate } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { STATUS_LABEL, statusTone } from "../../lib/roles.ts";
import { Link, navigate, useLocation } from "../../router.tsx";

export function AdminOrgs() {
  useTitle("Organisations · Admin");
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const orgs = useResource(`admin-orgs:${q}`, () => api.adminOrgs(q));
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Organisations" subtitle="Plans, subscriptions, members, computers and this period's auto-director usage." />
      <div className="toolbar">
        <form
          className="search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            navigate(`/admin/orgs${t ? `?q=${encodeURIComponent(t)}` : ""}`, { replace: true });
          }}
        >
          <TextField label="Search organisations" type="search" value={text} onValue={setText} placeholder="Name, member email or org id" />
          <Button type="submit">Search</Button>
        </form>
      </div>
      {orgs.loading && !orgs.data && <Loading label="Loading organisations…" />}
      {orgs.error && <ErrorState error={orgs.error} onRetry={orgs.reload} />}
      {orgs.data && orgs.data.length === 0 && <Empty title="No organisations match">{q ? "Try a different search." : "No organisations exist yet."}</Empty>}
      {orgs.data && orgs.data.length > 0 && (
        <div className={`table-card${orgs.loading ? " is-loading" : ""}`}>
          <table className="rtable data-table">
            <thead>
              <tr>
                <th scope="col">Organisation</th>
                <th scope="col">Owner</th>
                <th scope="col">Plan</th>
                <th scope="col">Members</th>
                <th scope="col">Computers</th>
                <th scope="col">Used</th>
                <th scope="col">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {orgs.data.map((o) => (
                <tr key={o.id}>
                  <td data-label="Organisation">
                    <Link to={`/admin/orgs/${encodeURIComponent(o.id)}`} className="strong">
                      {o.name}
                    </Link>
                    <span className="mono small block muted">{o.id}</span>
                    <span className="small block muted">created {formatDate(o.createdAt)}</span>
                  </td>
                  <td data-label="Owner">{o.ownerEmail ?? "—"}</td>
                  <td data-label="Plan">
                    <span className="badge-row">
                      <span>{o.planId}</span> <Badge tone={statusTone(o.subscriptionStatus)}>{STATUS_LABEL[o.subscriptionStatus]}</Badge>
                      {o.overridden && <Badge tone="info">Set by staff</Badge>}
                    </span>
                  </td>
                  <td data-label="Members">{o.members}</td>
                  <td data-label="Computers">{o.devices}</td>
                  <td data-label="Used">
                    <Hours seconds={o.usedSeconds} />
                  </td>
                  <td data-label="Remaining" className={o.remainingSeconds < 0 ? "text-danger" : undefined}>
                    <Hours seconds={o.remainingSeconds} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {orgs.data.length >= 200 && <p className="small muted table-foot">Showing the newest 200 matches; refine the search.</p>}
        </div>
      )}
    </>
  );
}
