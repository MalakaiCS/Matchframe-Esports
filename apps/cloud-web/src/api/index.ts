import type { HourPack, OrgRole, Plan } from "@matchframe/cloud-contracts";
import { createClient, seg } from "./client.ts";
import type {
  AdminCatalog,
  AdminOrg,
  AdminOrgDetail,
  AdminOverview,
  AdminUserDetail,
  AdminUserFilter,
  AdminUsersResponse,
  AuditEvent,
  AuthSession,
  BillingResponse,
  ContactMessage,
  ContactRequest,
  Device,
  DeviceLinkPreview,
  DownloadsResponse,
  EmailLogResponse,
  HealthResponse,
  InvitePreview,
  Me,
  MembersResponse,
  MessageStatus,
  OrgDetails,
  PlansResponse,
  SiteInfo,
  StaffRole,
  StripeEventRow,
  UsageResponse,
} from "./types.ts";

export * from "./client.ts";
export type * from "./types.ts";

/** The app-wide client (fetch is looked up per call so tests can stub it). */
export const client = createClient();

const pub = { public: true } as const;

/** Every website route of services/cloud-api, typed. */
export const api = {
  // public
  plans: () => client.get<PlansResponse>("/v1/plans", pub),
  downloads: () => client.get<DownloadsResponse>("/v1/downloads", pub),
  site: () => client.get<SiteInfo>("/v1/site", pub),
  health: () => client.get<HealthResponse>("/v1/health", pub),
  contact: (b: ContactRequest) => client.post<{ received: true }>("/v1/contact", b, pub),

  // accounts
  me: () => client.get<Me>("/v1/auth/me", pub),
  signup: (b: { email: string; password: string; displayName: string; orgName: string }) => client.post<{ userId: string; orgId: string }>("/v1/auth/signup", b, pub),
  login: (b: { email: string; password: string }) => client.post<{ userId: string }>("/v1/auth/login", b, pub),
  logout: () => client.post<{ ok: true }>("/v1/auth/logout", {}, pub),
  verifyEmail: (token: string) => client.post<{ verified: true }>("/v1/auth/verify-email", { token }, pub),
  resendVerification: () => client.post<{ sent: boolean; alreadyVerified?: boolean }>("/v1/auth/resend-verification"),
  requestPasswordReset: (email: string) => client.post<{ ok: true }>("/v1/auth/request-password-reset", { email }, pub),
  resetPassword: (token: string, password: string) => client.post<{ ok: true }>("/v1/auth/reset-password", { token, password }, pub),
  changePassword: (currentPassword: string, newPassword: string) => client.post<{ ok: true }>("/v1/auth/change-password", { currentPassword, newPassword }),
  updateProfile: (displayName: string) => client.patch<{ ok: true; displayName: string }>("/v1/auth/me", { displayName }),
  changeEmail: (newEmail: string, password: string) => client.post<{ sent: true }>("/v1/auth/change-email", { newEmail, password }),
  confirmEmailChange: (token: string) => client.post<{ changed: true; email: string }>("/v1/auth/confirm-email-change", { token }, pub),
  sessions: () => client.get<{ sessions: AuthSession[] }>("/v1/auth/sessions"),
  revokeSession: (id: string) => client.del<{ ok: true }>(`/v1/auth/sessions/${seg(id)}`),
  revokeOtherSessions: () => client.post<{ revoked: number }>("/v1/auth/sessions/revoke-others"),
  exportData: () => client.get<unknown>("/v1/auth/export"),

  // organisations & members
  createOrg: (name: string) => client.post<{ id: string; name: string }>("/v1/orgs", { name }),
  org: (orgId: string) => client.get<OrgDetails>(`/v1/orgs/${seg(orgId)}`),
  renameOrg: (orgId: string, name: string) => client.patch<{ ok: true }>(`/v1/orgs/${seg(orgId)}`, { name }),
  members: (orgId: string) => client.get<MembersResponse>(`/v1/orgs/${seg(orgId)}/members`),
  invite: (orgId: string, email: string, role: Exclude<OrgRole, "owner">) => client.post<{ invited: true }>(`/v1/orgs/${seg(orgId)}/invites`, { email, role }),
  withdrawInvite: (orgId: string, inviteId: string) => client.del<{ ok: true }>(`/v1/orgs/${seg(orgId)}/invites/${seg(inviteId)}`),
  setRole: (orgId: string, userId: string, role: OrgRole) => client.patch<{ ok: true }>(`/v1/orgs/${seg(orgId)}/members/${seg(userId)}`, { role }),
  removeMember: (orgId: string, userId: string) => client.del<{ ok: true }>(`/v1/orgs/${seg(orgId)}/members/${seg(userId)}`),
  previewInvite: (token: string) => client.get<InvitePreview>(`/v1/invites/${seg(token)}`, pub),
  acceptInvite: (token: string) => client.post<{ orgId: string; role: OrgRole }>(`/v1/invites/${seg(token)}/accept`),

  // billing
  billing: (orgId: string) => client.get<BillingResponse>(`/v1/orgs/${seg(orgId)}/billing`),
  checkout: (orgId: string, body: { kind: "subscription"; planId: string } | { kind: "hour_pack"; packId: string }) => client.post<{ url: string }>(`/v1/orgs/${seg(orgId)}/billing/checkout`, body),
  portal: (orgId: string) => client.post<{ url: string }>(`/v1/orgs/${seg(orgId)}/billing/portal`),

  // computers & usage
  previewLink: (userCode: string) => client.get<DeviceLinkPreview>(`/v1/device-link/${seg(userCode)}`),
  approveLink: (userCode: string, orgId: string) => client.post<{ approved: true; deviceName: string }>("/v1/device-link/approve", { userCode, orgId }),
  denyLink: (userCode: string) => client.post<{ denied: true }>("/v1/device-link/deny", { userCode }),
  devices: (orgId: string) => client.get<Device[]>(`/v1/orgs/${seg(orgId)}/devices`),
  unlinkDevice: (orgId: string, deviceId: string) => client.del<{ ok: true }>(`/v1/orgs/${seg(orgId)}/devices/${seg(deviceId)}`),
  usage: (orgId: string, range: { from?: string; to?: string } = {}) => client.get<UsageResponse>(usagePath(orgId, range)),

  // staff
  adminOrgs: (q: string) => client.get<AdminOrg[]>(`/v1/admin/orgs?q=${encodeURIComponent(q)}`),
  grantHours: (orgId: string, b: { hours: number; note: string; expiresAt: string | null }) => client.post<{ id: string }>(`/v1/admin/orgs/${seg(orgId)}/credits`, b),
  catalog: () => client.get<AdminCatalog>("/v1/admin/catalog"),
  savePlan: (p: Plan) => client.put<Plan>(`/v1/admin/plans/${seg(p.id)}`, p),
  saveHourPack: (h: HourPack) => client.put<HourPack>(`/v1/admin/hour-packs/${seg(h.id)}`, h),
  audit: (orgId?: string) => client.get<AuditEvent[]>(`/v1/admin/audit${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
  stripeEvents: () => client.get<StripeEventRow[]>("/v1/admin/stripe-events"),
  adminOverview: () => client.get<AdminOverview>("/v1/admin/overview"),
  adminUsers: (q: { q?: string; filter?: AdminUserFilter; page?: number; pageSize?: number } = {}) => client.get<AdminUsersResponse>(`/v1/admin/users?${adminUsersQuery(q)}`),
  adminUser: (id: string) => client.get<AdminUserDetail>(`/v1/admin/users/${seg(id)}`),
  adminVerifyEmail: (id: string) => client.post<{ ok: true }>(`/v1/admin/users/${seg(id)}/verify-email`),
  adminResendVerification: (id: string) => client.post<{ sent: boolean; alreadyVerified?: boolean }>(`/v1/admin/users/${seg(id)}/resend-verification`),
  adminPasswordReset: (id: string) => client.post<{ sent: true }>(`/v1/admin/users/${seg(id)}/password-reset`),
  adminSignOutUser: (id: string) => client.post<{ revoked: number; computers?: number }>(`/v1/admin/users/${seg(id)}/sign-out`),
  adminSetStaffRole: (id: string, role: StaffRole | null) => client.put<{ ok: true; staffRole: StaffRole | null }>(`/v1/admin/users/${seg(id)}/staff-role`, { role }),
  adminDisableUser: (id: string, reason: string) => client.post<{ ok: true }>(`/v1/admin/users/${seg(id)}/disable`, { reason }),
  adminEnableUser: (id: string) => client.post<{ ok: true }>(`/v1/admin/users/${seg(id)}/enable`),
  adminUpdateUser: (id: string, b: { displayName?: string; email?: string }) => client.patch<{ ok: true }>(`/v1/admin/users/${seg(id)}`, b),
  adminOrg: (id: string) => client.get<AdminOrgDetail>(`/v1/admin/orgs/${seg(id)}`),
  adminMessages: (status: MessageStatus) => client.get<{ messages: ContactMessage[] }>(`/v1/admin/messages?status=${status}`),
  adminSetMessageHandled: (id: string, handled: boolean) => client.post<{ ok: true }>(`/v1/admin/messages/${seg(id)}/handled`, { handled }),
  adminEmails: (limit = 100) => client.get<EmailLogResponse>(`/v1/admin/emails?limit=${limit}`),
  adminResendEmail: (id: string) => client.post<{ sent: boolean; error: string | null }>(`/v1/admin/emails/${seg(id)}/resend`),
};

/** Query string for the staff user list (empty values are left out). */
export function adminUsersQuery(q: { q?: string; filter?: AdminUserFilter; page?: number; pageSize?: number }): string {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  p.set("filter", q.filter ?? "all");
  p.set("page", String(q.page ?? 1));
  p.set("pageSize", String(q.pageSize ?? 25));
  return p.toString();
}

/** Usage JSON (and, with format=csv, the CSV download link) for an optional from/to range. */
export function usagePath(orgId: string, range: { from?: string; to?: string; format?: "csv" } = {}): string {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  if (range.format) q.set("format", range.format);
  const s = q.toString();
  return `/v1/orgs/${seg(orgId)}/usage${s ? `?${s}` : ""}`;
}
