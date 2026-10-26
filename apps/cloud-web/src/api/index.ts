import type { HourPack, OrgRole, Plan } from "@matchframe/cloud-contracts";
import { createClient, seg } from "./client.ts";
import type {
  AdminCatalog,
  AdminOrg,
  AuditEvent,
  BillingResponse,
  Device,
  DeviceLinkPreview,
  DownloadsResponse,
  InvitePreview,
  Me,
  MembersResponse,
  OrgDetails,
  PlansResponse,
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
};

/** Usage JSON (and, with format=csv, the CSV download link) for an optional from/to range. */
export function usagePath(orgId: string, range: { from?: string; to?: string; format?: "csv" } = {}): string {
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  if (range.format) q.set("format", range.format);
  const s = q.toString();
  return `/v1/orgs/${seg(orgId)}/usage${s ? `?${s}` : ""}`;
}
