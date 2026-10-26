import type { Sql } from "./sql.ts";

/** Append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "accounts, orgs, billing, devices, usage",
    sql: `
CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  staff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE email_tokens (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  stripe_customer_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'billing', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE invites (
  token_hash text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  invited_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE TABLE plans (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE hour_packs (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE subscriptions (
  org_id text PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  plan_id text NOT NULL,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_grants (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seconds bigint NOT NULL CHECK (seconds > 0),
  source text NOT NULL CHECK (source IN ('hour_pack', 'grant')),
  reference text UNIQUE,
  expires_at timestamptz,
  created_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_debits (
  grant_id text NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  record_id uuid NOT NULL,
  seconds bigint NOT NULL CHECK (seconds > 0),
  period_start timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, device_id, record_id)
);
CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);
CREATE TABLE device_auth (
  device_code_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  install_id text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  org_id text REFERENCES orgs(id) ON DELETE CASCADE,
  approved_by text,
  poll_interval integer NOT NULL DEFAULT 5,
  last_poll_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE devices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  install_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX devices_org ON devices(org_id);
CREATE TABLE usage_records (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  kind text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  seconds integer NOT NULL CHECK (seconds > 0),
  session_id text NOT NULL,
  match_ref text,
  map_name text,
  app_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, record_id)
);
CREATE INDEX usage_org_time ON usage_records(org_id, started_at);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  org_id text,
  action text NOT NULL,
  detail jsonb
);
CREATE INDEX audit_org ON audit_log(org_id, at);
CREATE TABLE outbox_emails (
  id bigserial PRIMARY KEY,
  to_addr text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text
);
`,
  },
  {
    version: 2,
    name: "email address changes",
    sql: `
ALTER TABLE email_tokens DROP CONSTRAINT email_tokens_purpose_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('verify', 'reset', 'email_change'));
ALTER TABLE email_tokens ADD COLUMN new_email text;
`,
  },
];

export async function migrate(sql: Sql): Promise<{ from: number; to: number }> {
  await sql.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const { rows } = await sql.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations");
  const from = rows[0]?.v ?? 0;
  for (const m of MIGRATIONS.filter((x) => x.version > from)) {
    await sql.transaction(async (tx) => {
      for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
      await tx.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
    });
  }
  return { from, to: MIGRATIONS[MIGRATIONS.length - 1]!.version };
}
