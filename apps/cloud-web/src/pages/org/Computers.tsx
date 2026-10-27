import { useState } from "react";
import type { OrgScope } from "../../App.tsx";
import { api } from "../../api/index.ts";
import { Alert, Badge, Card, ConfirmButton, Empty, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDate, formatDateTime, formatRelative, platformLabel } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { can, roleReason } from "../../lib/roles.ts";
import { Link } from "../../router.tsx";

export function Computers({ scope }: { scope: OrgScope }) {
  useTitle("Computers");
  const { orgId, role } = scope;
  const devices = useResource(`devices:${orgId}`, () => api.devices(orgId));
  const org = useResource(`org:${orgId}`, () => api.org(orgId));
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = devices.data ?? [];
  const active = list.filter((d) => !d.revokedAt);
  const unlinked = list.filter((d) => d.revokedAt);
  const max = org.data?.plan.features.maxDevices;
  const unlinkWhy = roleReason(role, "devices.revoke");
  const shown = showUnlinked ? list : active;

  return (
    <>
      <PageHeader
        title="Computers"
        subtitle={max !== undefined ? `${active.length} of ${max} linked on the ${org.data!.plan.name} plan.` : "Desktop computers linked to this organisation."}
        actions={
          can(role, "devices.link") ? (
            <Link className="btn btn-primary" to="/link">
              Link a computer
            </Link>
          ) : undefined
        }
      />
      <div className="stack-lg">
        <Card title="How to link a computer">
          <ol className="plain-steps">
            <li>
              Install the Matchframe program from the <Link to="/download">download page</Link>.
            </li>
            <li>
              Start the program and sign in with your Matchframe email and password. If you're in several organisations, choose this one.
            </li>
            <li>
              Or choose <strong>Sign in with a code from the website</strong> in the program, enter the code at <Link to="/link">/link</Link>, choose this organisation and approve.
            </li>
          </ol>
          <p className="small muted">Unlinking stops that computer's credential immediately and frees its slot. Plan details it already downloaded expire on their own schedule.</p>
        </Card>
        {notice && <Alert tone="ok">{notice}</Alert>}
        <Card
          title="Linked computers"
          actions={
            unlinked.length > 0 ? (
              <label className="inline-check">
                <input type="checkbox" checked={showUnlinked} onChange={(e) => setShowUnlinked(e.target.checked)} /> Show {unlinked.length} unlinked
              </label>
            ) : undefined
          }
        >
          {devices.loading && !devices.data && <Loading />}
          {devices.error && <ErrorState error={devices.error} onRetry={devices.reload} />}
          {devices.data && shown.length === 0 && (
            <Empty title="No computers linked yet">Follow the steps above to link a computer that runs the Matchframe program.</Empty>
          )}
          {shown.length > 0 && (
            <table className="rtable">
              <thead>
                <tr>
                  <th scope="col">Computer</th>
                  <th scope="col">Platform</th>
                  <th scope="col">App version</th>
                  <th scope="col">Linked</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id} className={d.revokedAt ? "is-muted" : undefined}>
                    <td data-label="Computer" className="strong">
                      {d.name}
                    </td>
                    <td data-label="Platform">{platformLabel(d.platform)}</td>
                    <td data-label="App version">{d.appVersion || "—"}</td>
                    <td data-label="Linked">
                      <span title={formatDateTime(d.linkedAt)}>{formatDate(d.linkedAt)}</span>
                      {d.approvedBy && <span className="muted small block">by {d.approvedBy}</span>}
                    </td>
                    <td data-label="Last seen">
                      <span title={formatDateTime(d.lastSeenAt)}>{formatRelative(d.lastSeenAt)}</span>
                    </td>
                    <td data-label="Status">{d.revokedAt ? <Badge tone="neutral">Unlinked {formatDate(d.revokedAt)}</Badge> : <Badge tone="ok">Linked</Badge>}</td>
                    <td data-label="Actions" className="cell-actions">
                      {!d.revokedAt && (
                        <ConfirmButton
                          label="Unlink"
                          confirmLabel="Unlink"
                          question={`Unlink ${d.name}? It stops working with this organisation until it's linked again.`}
                          disabledReason={unlinkWhy}
                          action={() => api.unlinkDevice(orgId, d.id)}
                          onDone={() => {
                            setNotice(`${d.name} was unlinked.`);
                            void devices.reload();
                          }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
