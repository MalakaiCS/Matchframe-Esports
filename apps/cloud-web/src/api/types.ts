/**
 * Response shapes of services/cloud-api (read from its route handlers). Request bodies and shared
 * entities come from @matchframe/cloud-contracts.
 */
import type { AutoDirectorAllowance, HourPack, OrgRole, OrgView, Plan, SubscriptionStatus, UserView } from "@matchframe/cloud-contracts";

export type { AutoDirectorAllowance, HourPack, OrgRole, OrgView, Plan, SubscriptionStatus, UserView };

/** GET /v1/auth/me */
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
