import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import type { AdminUserFilter } from "../../api/types.ts";
import { Initials, Pagination, Segmented } from "../../components/data.tsx";
import { Button, Empty, ErrorState, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDate, formatRelative } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link, navigate, useLocation } from "../../router.tsx";
import { UserBadges } from "./shared.tsx";

const FILTERS: { value: AdminUserFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unverified", label: "Unverified" },
  { value: "staff", label: "Staff" },
  { value: "disabled", label: "Disabled" },
];

const PAGE_SIZE = 25;
const isFilter = (v: string | null): v is AdminUserFilter => FILTERS.some((f) => f.value === v);

export function AdminUsers() {
  useTitle("Users · Admin");
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const rawFilter = query.get("filter");
  const filter: AdminUserFilter = isFilter(rawFilter) ? rawFilter : "all";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const go = (next: { q?: string; filter?: AdminUserFilter; page?: number }) => {
    const p = new URLSearchParams();
    const nq = next.q ?? q;
    const nf = next.filter ?? filter;
    const np = next.page ?? 1;
    if (nq) p.set("q", nq);
    if (nf !== "all") p.set("filter", nf);
    if (np > 1) p.set("page", String(np));
    const s = p.toString();
    navigate(`/admin/users${s ? `?${s}` : ""}`, { replace: true });
  };

  const users = useResource(`admin-users:${q}:${filter}:${page}`, () => api.adminUsers({ q, filter, page, pageSize: PAGE_SIZE }));
  const data = users.data;
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Users" subtitle="Search accounts, check verification and staff roles, and open an account to help its owner." />
      <div className="toolbar">
        <form
          className="search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: text.trim(), page: 1 });
          }}
        >
          <TextField label="Search users" type="search" value={text} onValue={setText} placeholder="Email, name or user id" />
          <Button type="submit">Search</Button>
        </form>
        <Segmented label="Filter users" value={filter} options={FILTERS} onChange={(f) => go({ filter: f, page: 1 })} />
      </div>
      {users.loading && !data && <Loading label="Loading users…" />}
      {users.error && <ErrorState error={users.error} onRetry={users.reload} />}
      {data && data.users.length === 0 && (
        <Empty title="No users match">{q || filter !== "all" ? "Try a different search or filter." : "Nobody has signed up yet."}</Empty>
      )}
      {data && data.users.length > 0 && (
        <div className={`table-card${users.loading ? " is-loading" : ""}`}>
          <table className="rtable data-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Status</th>
                <th scope="col">Organisations</th>
                <th scope="col">Signed up</th>
                <th scope="col">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td data-label="User">
                    <span className="person-cell">
                      <Initials name={u.displayName || u.email} />
                      <span>
                        <Link to={`/admin/users/${encodeURIComponent(u.id)}`} className="strong">
                          {u.displayName || "(no name)"}
                        </Link>
                        <span className="small muted block">{u.email}</span>
                      </span>
                    </span>
                  </td>
                  <td data-label="Status">
                    <UserBadges u={u} />
                  </td>
                  <td data-label="Organisations">{u.orgCount}</td>
                  <td data-label="Signed up">{formatDate(u.createdAt)}</td>
                  <td data-label="Last sign-in">{u.lastLoginAt ? <span title={formatDate(u.lastLoginAt)}>{formatRelative(u.lastLoginAt)}</span> : <span className="muted">Never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => go({ page: p })} label="users" />
        </div>
      )}
    </>
  );
}
