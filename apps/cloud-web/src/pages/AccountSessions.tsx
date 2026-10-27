import { useState } from "react";
import { api } from "../api/index.ts";
import type { AuthSession } from "../api/types.ts";
import { ConfirmDialog, useToast } from "../components/overlay.tsx";
import { ActionButton, Badge, Button, Card, Empty, ErrorState, Loading } from "../components/ui.tsx";
import { exportFileName, fileSaver } from "../lib/download.ts";
import { formatDateTime, formatRelative } from "../lib/format.ts";
import { useResource } from "../lib/hooks.ts";
import { describeUserAgent } from "../lib/useragent.ts";
import { Link } from "../router.tsx";

function SessionRow({ s, onRevoked }: { s: AuthSession; onRevoked: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const dev = describeUserAgent(s.userAgent);
  return (
    <li className={`session${s.current ? " is-current" : ""}`}>
      <div className="session-main">
        <p className="session-device">
          {dev.label} {s.current && <Badge tone="ok">This device</Badge>}
        </p>
        <p className="small muted">
          {s.ip ?? "Unknown IP address"} · signed in {formatDateTime(s.createdAt)} · last active <span title={s.lastSeenAt ? formatDateTime(s.lastSeenAt) : undefined}>{s.current ? "now" : formatRelative(s.lastSeenAt ?? s.createdAt)}</span>
        </p>
      </div>
      {!s.current && (
        <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setAsking(true)}>
          Sign out<span className="visually-hidden"> {dev.label}</span>
        </Button>
      )}
      {asking && (
        <ConfirmDialog
          title="Sign out this session?"
          description={
            <>
              {dev.label} ({s.ip ?? "unknown IP"}) will be signed out and needs to sign in again.
            </>
          }
          confirmLabel="Sign out session"
          onConfirm={() => api.revokeSession(s.id)}
          onClose={() => setAsking(false)}
          onDone={() => {
            toast(`Signed out ${dev.label}.`);
            onRevoked();
          }}
        />
      )}
    </li>
  );
}

/** Account page: browsers signed in to this account. */
export function SessionsCard() {
  const toast = useToast();
  const list = useResource("sessions", api.sessions);
  const [askAll, setAskAll] = useState(false);
  const sessions = list.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Card
      title="Active sessions"
      id="sessions"
      actions={
        <Button size="sm" onClick={() => setAskAll(true)} disabledReason={list.data && others === 0 ? "No other sessions are signed in." : null} disabled={!list.data}>
          Sign out all other sessions
        </Button>
      }
    >
      <p className="muted small">Browsers where your account is signed in. If you don't recognise one, sign it out and change your password.</p>
      {list.loading && !list.data && <Loading label="Loading sessions…" />}
      {list.error && <ErrorState error={list.error} onRetry={list.reload} title="Couldn't load your sessions" />}
      {list.data && sessions.length === 0 && <Empty title="No active sessions" />}
      {sessions.length > 0 && (
        <ul className="session-list">
          {[...sessions]
            .sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt))
            .map((s) => (
              <SessionRow key={s.id} s={s} onRevoked={() => void list.reload()} />
            ))}
        </ul>
      )}
      {askAll && (
        <ConfirmDialog
          title="Sign out all other sessions?"
          description={`${others} other ${others === 1 ? "session" : "sessions"} will be signed out. This browser stays signed in.`}
          confirmLabel="Sign out others"
          onConfirm={() => api.revokeOtherSessions()}
          onClose={() => setAskAll(false)}
          onDone={(r) => {
            const n = (r as { revoked?: number } | undefined)?.revoked ?? 0;
            toast(`Signed out ${n} other ${n === 1 ? "session" : "sessions"}.`);
            void list.reload();
          }}
        />
      )}
    </Card>
  );
}

/** Account page: download a JSON copy of the account's data. */
export function DataExportCard() {
  const toast = useToast();
  return (
    <Card title="Your data">
      <p className="muted">Download a copy of your profile, memberships, sessions and the other account data we hold about you, as a JSON file.</p>
      <ActionButton
        action={async () => {
          const data = await api.exportData();
          fileSaver.saveJson(exportFileName(), data);
          toast("Your data was downloaded.");
        }}
      >
        Download my data
      </ActionButton>
      <p className="small muted">
        To delete your account, <Link to="/contact?topic=support">contact support</Link>.
      </p>
    </Card>
  );
}
