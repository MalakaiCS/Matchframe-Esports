import { useState } from "react";
import { api } from "../../api/index.ts";
import type { ContactMessage, MessageStatus } from "../../api/types.ts";
import { Segmented } from "../../components/data.tsx";
import { useToast } from "../../components/overlay.tsx";
import { ActionButton, Badge, Button, Empty, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { useResource, useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { TOPIC_LABEL } from "./shared.tsx";

const FILTERS: { value: MessageStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "handled", label: "Handled" },
  { value: "all", label: "All" },
];

/** mailto: link that replies to a contact message with its text quoted. */
export function replyHref(m: ContactMessage, websiteName = "Matchframe"): string {
  const subject = `Re: your ${websiteName} ${TOPIC_LABEL[m.topic]?.toLowerCase() ?? ""} enquiry`.replace(/\s+/g, " ");
  const quoted = m.message
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const body = `Hi ${m.name},\n\n\n\nOn ${new Date(m.createdAt).toUTCString()} you wrote:\n${quoted}`;
  return `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function MessageCard({ m, onChanged }: { m: ContactMessage; onChanged: () => void }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const long = m.message.length > 420;
  const text = long && !expanded ? `${m.message.slice(0, 420).trimEnd()}…` : m.message;
  return (
    <li className={`message${m.handledAt ? " is-handled" : ""}`}>
      <header className="message-head">
        <div>
          <p className="message-from">
            <span className="strong">{m.name}</span> <a href={`mailto:${m.email}`}>{m.email}</a>
          </p>
          <p className="small muted">
            <span title={formatDateTime(m.createdAt)}>{formatRelative(m.createdAt)}</span> · #{m.id}
            {m.userId && (
              <>
                {" · "}
                <Link to={`/admin/users/${encodeURIComponent(m.userId)}`}>signed-in account</Link>
              </>
            )}
            {m.orgId && (
              <>
                {" · "}
                <Link to={`/admin/orgs/${encodeURIComponent(m.orgId)}`}>organisation</Link>
              </>
            )}
          </p>
        </div>
        <span className="badge-row">
          <Badge tone="info">{TOPIC_LABEL[m.topic] ?? m.topic}</Badge>
          {m.handledAt ? <Badge tone="ok">Handled</Badge> : <Badge tone="warn">Open</Badge>}
        </span>
      </header>
      <p className="message-text">{text}</p>
      {long && (
        <button type="button" className="link-button small" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? "Show less" : "Show the whole message"}
        </button>
      )}
      {m.handledAt && (
        <p className="small muted">
          Handled {formatDateTime(m.handledAt)}
          {m.handledBy ? ` by ${m.handledBy}` : ""}
        </p>
      )}
      <div className="button-row">
        <a className="btn btn-primary btn-sm" href={replyHref(m)}>
          Reply by email
        </a>
        <ActionButton
          size="sm"
          variant={m.handledAt ? "ghost" : "secondary"}
          action={async () => {
            await api.adminSetMessageHandled(m.id, !m.handledAt);
            toast(m.handledAt ? `Message #${m.id} reopened.` : `Message #${m.id} marked handled.`);
            onChanged();
          }}
        >
          {m.handledAt ? "Reopen" : "Mark handled"}
        </ActionButton>
      </div>
    </li>
  );
}

export function AdminInbox() {
  useTitle("Support inbox · Admin");
  const [status, setStatus] = useState<MessageStatus>("open");
  const list = useResource(`admin-messages:${status}`, () => api.adminMessages(status));
  const msgs = list.data?.messages ?? [];
  return (
    <>
      <PageHeader eyebrow="Staff console" title="Support inbox" subtitle="Messages from the contact form. Reply by email, then mark them handled." actions={<Button size="sm" onClick={() => void list.reload()} busy={list.loading}>Refresh</Button>} />
      <div className="toolbar">
        <Segmented label="Show messages" value={status} options={FILTERS} onChange={setStatus} />
      </div>
      {list.loading && !list.data && <Loading label="Loading messages…" />}
      {list.error && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && msgs.length === 0 && <Empty title={status === "open" ? "Inbox zero: no open messages" : "No messages here"}>New messages from the contact form appear here.</Empty>}
      {msgs.length > 0 && (
        <ul className="message-list">
          {msgs.map((m) => (
            <MessageCard key={m.id} m={m} onChanged={() => void list.reload()} />
          ))}
        </ul>
      )}
      {msgs.length >= 300 && <p className="small muted">Showing the latest 300 messages.</p>}
    </>
  );
}
