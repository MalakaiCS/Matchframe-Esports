/**
 * Response shapes of services/cloud-api (read from its route handlers). Request bodies and shared
 * entities come from @matchframe/cloud-contracts.
 */
import type { AutoDirectorAllowance, HourPack, OrgRole, OrgView, Plan, StaffRole, SubscriptionStatus, UserView } from "@matchframe/cloud-contracts";

export type { AutoDirectorAllowance, HourPack, OrgRole, OrgView, Plan, SubscriptionStatus, UserView };

/** GET /v1/auth/me — `user.staffRole` is "support" or "admin" for staff (`staff` is true for either). */
export interface Me {
  user: UserView;
  orgs: OrgView[];
  billingConfigured: boolean;
}

/** GET /v1/plans — public catalogue (Stripe price ids are not exposed). */
export type PublicPlan = Omit<Plan, "stripePriceId"> & { purchasable: boolean };
export type PublicHourPack = Omit<HourPack, "stripePriceId"> & { purchasable: boolean };
export interface PlansResponse {
  plans: PublicPlan[];
  hourPacks: PublicHourPack[];
  billingConfigured: boolean;
}

/** GET /v1/downloads */
export interface DownloadsResponse {
  windows: { url: string; sha256: string | null; version: string } | null;
  notesUrl: string | null;
  version: string;
}

/** GET /v1/orgs/:orgId — role is "staff" when a staff member views an organisation they do not belong to. */
export interface OrgDetails {
  id: string;
  name: string;
  createdAt: string;
  role: OrgRole | "staff";
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
}

export interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  since: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

/** GET /v1/orgs/:orgId/members */
export interface MembersResponse {
  members: Member[];
  invites: PendingInvite[];
}

/** GET /v1/invites/:token */
export interface InvitePreview {
  orgName: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

export interface CreditGrant {
  id: string;
  /** "hour_pack" (bought) or "grant" (support credit). */
  source: string;
  seconds: number;
  remainingSeconds: number;
  expiresAt: string | null;
  expired: boolean;
  note: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

/** GET /v1/orgs/:orgId/billing */
export interface BillingResponse {
  plan: Plan;
  subscription: { status: SubscriptionStatus; cancelAtPeriodEnd: boolean; periodStart: string; periodEnd: string };
  allowance: AutoDirectorAllowance;
  credits: CreditGrant[];
  invoices: Invoice[];
  invoicesError: string | null;
  billingConfigured: boolean;
  hasCustomer: boolean;
}

/** GET /v1/device-link/:userCode */
export interface DeviceLinkPreview {
  deviceName: string;
  platform: string;
  appVersion: string;
  requestedAt: string;
  expiresAt: string;
}

/** GET /v1/orgs/:orgId/devices */
export interface Device {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  linkedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  approvedBy: string | null;
}

export interface UsageSession {
  recordId: string;
  deviceId: string;
  deviceName: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  matchRef: string | null;
  mapName: string | null;
}

/** GET /v1/orgs/:orgId/usage */
export interface UsageResponse {
  allowance: AutoDirectorAllowance;
  range: { from: string; to: string };
  daily: { day: string; seconds: number }[];
  byDevice: { deviceId: string; name: string; seconds: number }[];
  sessions: UsageSession[];
}

/** GET /v1/admin/orgs */
export interface AdminOrg {
  id: string;
  name: string;
  createdAt: string;
  ownerEmail: string | null;
  members: number;
  devices: number;
  planId: string;
  subscriptionStatus: SubscriptionStatus;
  /** Status and plan set by staff (wins over Stripe until removed). */
  overridden: boolean;
  usedSeconds: number;
  remainingSeconds: number;
}

/** GET /v1/admin/catalog */
export interface AdminCatalog {
  plans: Plan[];
  hourPacks: HourPack[];
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  orgId: string | null;
  action: string;
  detail: unknown;
}

export interface StripeEventRow {
  id: string;
  type: string;
  receivedAt: string;
  processedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------- site, contact, sessions

/** Staff role of a user: "support" looks things up and helps customers; "admin" can also change settings. */
export type { StaffRole };

/** GET /v1/site — public company details for the footer, contact page and legal documents. */
export interface SiteInfo {
  companyName: string;
  websiteName: string;
  supportEmail: string | null;
  address: string | null;
  jurisdiction: string;
  /** YYYY-MM-DD */
  legalEffectiveDate: string;
}

export type ContactTopic = "sales" | "support" | "billing" | "legal" | "other";

/** POST /v1/contact */
export interface ContactRequest {
  name: string;
  email: string;
  topic: ContactTopic;
  message: string;
  orgId?: string | null;
}

/** GET /v1/auth/sessions */
export interface AuthSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** GET /v1/health (public). */
export interface HealthResponse {
  ok: boolean;
  version?: string;
  database?: string;
  billingConfigured?: boolean;
  email?: string;
}

// ---------------------------------------------------------------------------- staff console

/** GET /v1/admin/overview */
export interface AdminOverview {
  users: { total: number; verified: number; staff: number; disabled: number; newLast30Days: number };
  orgs: { total: number; paying: number; byPlan: Record<string, number> };
  devices: { linked: number };
  usage: { secondsThisMonth: number };
  revenue: { mrrCents: number; currency: string };
  recentSignups: { id: string; email: string; displayName: string; createdAt: string; emailVerified: boolean }[];
}

export type AdminUserFilter = "all" | "unverified" | "staff" | "disabled";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  staffRole: StaffRole | null;
  disabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  orgCount: number;
  /** Listed in the server's MF_STAFF_EMAILS: always admin, can't be demoted or disabled. */
  bootstrapAdmin: boolean;
}

/** GET /v1/admin/users */
export interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminSessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** GET /v1/admin/users/:id */
export interface AdminUserDetail {
  user: AdminUser;
  memberships: { orgId: string; orgName: string; role: OrgRole; planName: string }[];
  sessions: AdminSessionRow[];
  /** Rate limits this account is over right now ("too many attempts"), until when. */
  lockouts: { label: string; until: string }[];
  audit: { at: string; action: string; orgId: string | null; detail: unknown }[];
}

/** GET /v1/admin/orgs/:id */
export interface AdminOrgDetail {
  org: { id: string; name: string; createdAt: string; stripeCustomerId: string | null };
  plan: { id: string; name: string };
  subscription: {
    status: SubscriptionStatus;
    periodStart: string;
    periodEnd: string;
    cancelAtPeriodEnd: boolean;
    /** Set by staff: wins over Stripe until removed. */
    override: { planId: string; status: SubscriptionStatus; note: string; createdBy: string; createdAt: string } | null;
    /** What Stripe last reported (null when the organisation never subscribed). */
    stripe: { planId: string; status: SubscriptionStatus } | null;
  };
  limits: { maxDevices: number; maxMembers: number };
  allowance: { periodStart: string; periodEnd: string; includedSeconds: number; creditSeconds: number; usedSeconds: number; remainingSeconds: number };
  /** Staff resets of this period's usage. */
  usageResets: { id: string; seconds: number; note: string; createdBy: string; createdAt: string }[];
  members: { userId: string; email: string; displayName: string; role: OrgRole }[];
  devices: { id: string; name: string; platform: string; appVersion: string; linkedAt: string; lastSeenAt: string | null; revokedAt: string | null }[];
  credits: { id: string; seconds: number; remainingSeconds: number; source: string; note: string | null; expiresAt: string | null; createdAt: string }[];
}

export type MessageStatus = "open" | "handled" | "all";

/** GET /v1/admin/messages */
export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  orgId: string | null;
  userId: string | null;
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
}

/** GET /v1/admin/emails — `delivery` is "outbox" when no SMTP server is configured (emails are only logged). */
export interface EmailLogResponse {
  emails: EmailLogRow[];
  delivery?: "smtp" | "outbox";
}

/** One logged email: metadata only, never bodies. */
export interface EmailLogRow {
  id: string;
  to: string;
  subject: string;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
}
