import { useState } from "react";
import { api } from "../../api/index.ts";
import type { EmailLogRow } from "../../api/types.ts";
import { Segmented } from "../../components/data.tsx";
import { useToast } from "../../components/overlay.tsx";
import { ActionButton, Alert, Badge, Button, Empty, ErrorState, Loading, PageHeader, TextField } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { AdminOnlyNote, useStaffRole } from "./shared.tsx";

type StateFilter = "all" | "sent" | "failed" | "pending";
type RowState = "sent" | "failed" | "logged" | "pending";

function rowState(e: EmailLogRow, outbox: boolean): RowState {
  if (e.sentAt) return "sent";
  if (e.error) return "failed";
  return outbox ? "logged" : "pending";
}

const STATE_BADGE: Record<RowState, { tone: "ok" | "danger" | "neutral" | "warn"; label: string }> = {
  sent: { tone: "ok", label: "Sent" },
  failed: { tone: "danger", label: "Failed" },
  logged: { tone: "neutral", label: "Logged only" },
  pending: { tone: "warn", label: "Pending" },
};

export function AdminEmails() {
  useTitle("Email log · Admin");
  const toast = useToast();
  const { isAdmin, role } = useStaffRole();
  const log = useResource("admin-emails", () => api.adminEmails(200));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  const outbox = log.data?.delivery === "outbox";
  const all = log.data?.emails ?? [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((e) => {
    const st = rowState(e, outbox);
    if (filter === "sent" && st !== "sent") return false;
    if (filter === "failed" && st !== "failed") return false;
    if (filter === "pending" && st !== "pending" && st !== "logged") return false;
    return !needle || e.to.toLowerCase().includes(needle) || e.subject.toLowerCase().includes(needle);
  });
  const count = (f: StateFilter) => all.filter((e) => (f === "all" ? true : f === "pending" ? ["pending", "logged"].includes(rowState(e, outbox)) : rowState(e, outbox) === f)).length;
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Email log" subtitle="Emails the website has sent: recipient, subject and delivery state. Message bodies aren't stored here." actions={<Button size="sm" onClick={() => void log.reload()} busy={log.loading}>Refresh</Button>} />
      {outbox && (
        <Alert tone="info" title="Email delivery isn't configured" live={false}>
          No SMTP server is set on this server, so emails are logged here but not delivered.
        </Alert>
      )}
      {!isAdmin && <AdminOnlyNote role={role} what="Resending emails is hidden." />}
      <div className="toolbar">
        <div className="search-form search-form-inline">
          <TextField label="Filter by recipient or subject" type="search" value={q} onValue={setQ} placeholder="e.g. owner@example.com or password" />
        </div>
        <Segmented
          label="Delivery state"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count("all") },
            { value: "sent", label: "Sent", count: count("sent") },
            { value: "failed", label: "Failed", count: count("failed") },
            { value: "pending", label: outbox ? "Not delivered" : "Pending", count: count("pending") },
          ]}
        />
      </div>
      {log.loading && !log.data && <Loading label="Loading the email log…" />}
      {log.error && <ErrorState error={log.error} onRetry={log.reload} />}
      {log.data && rows.length === 0 && <Empty title={all.length === 0 ? "No emails sent yet" : "No emails match"} />}
      {rows.length > 0 && (
        <div className="table-card">
          <table className="rtable data-table">
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col">State</th>
                {isAdmin && (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const st = rowState(e, outbox);
                return (
                  <tr key={e.id}>
                    <td data-label="Created">{formatDateTime(e.createdAt)}</td>
                    <td data-label="To">{e.to}</td>
                    <td data-label="Subject">{e.subject}</td>
                    <td data-label="State">
                      <Badge tone={STATE_BADGE[st].tone}>{STATE_BADGE[st].label}</Badge>
                      {e.sentAt && <span className="small muted block">{formatDateTime(e.sentAt)}</span>}
                      {e.error && <span className="small text-danger block">{e.error}</span>}
                    </td>
                    {isAdmin && (
                      <td data-label="Actions" className="cell-actions">
                        <ActionButton
                          size="sm"
                          action={async () => {
                            const r = await api.adminResendEmail(e.id);
                            if (r.sent) toast(`Email resent to ${e.to}.`);
                            else toast(r.error ? `Not resent: ${r.error}` : "The email wasn't resent.", r.error && /not configured|SMTP_URL/i.test(r.error) ? "info" : "warn");
                            void log.reload();
                          }}
                        >
                          Resend <span className="visually-hidden">to {e.to}</span>
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
