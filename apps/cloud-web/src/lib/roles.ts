import type { OrgRole, SubscriptionStatus } from "@matchframe/cloud-contracts";

/**
 * Mirror of the API's role matrix (services/cloud-api/src/domain/roles.ts) so the site can hide or
 * disable what a role cannot do. The API stays the authority and answers 403 regardless.
 */
export type OrgAction = "org.view" | "org.rename" | "members.manage" | "billing.manage" | "billing.view" | "devices.link" | "devices.revoke" | "usage.view";

/** "staff" = a Matchframe staff member viewing an organisation they are not a member of (read-only). */
export type ViewerRole = OrgRole | "staff";

const MATRIX: Record<ViewerRole, readonly OrgAction[]> = {
  owner: ["org.view", "org.rename", "members.manage", "billing.manage", "billing.view", "devices.link", "devices.revoke", "usage.view"],
  admin: ["org.view", "org.rename", "members.manage", "billing.view", "devices.link", "devices.revoke", "usage.view"],
  billing: ["org.view", "billing.manage", "billing.view", "usage.view"],
  member: ["org.view", "devices.link", "usage.view"],
  staff: ["org.view", "billing.view", "usage.view"],
};

export const can = (role: ViewerRole | null | undefined, action: OrgAction): boolean => !!role && MATRIX[role].includes(action);

export const ROLE_LABEL: Record<ViewerRole, string> = { owner: "Owner", admin: "Admin", billing: "Billing", member: "Member", staff: "Staff (view only)" };

/** Plain-language summary for the Team page. */
export const ROLE_INFO: { role: OrgRole; summary: string }[] = [
  { role: "owner", summary: "Everything: billing and plan, members and roles (including other owners), renaming, linking and unlinking computers." },
  { role: "admin", summary: "Members and invites (not owners), renaming, linking and unlinking computers, viewing billing and usage. Can't buy or change the plan." },
  { role: "billing", summary: "Plan, payment and hour packs through Stripe, invoices, usage. Can't link computers or manage members." },
  { role: "member", summary: "Links computers to the organisation and sees usage. Can't see billing or manage anyone." },
];

/** Who may do something, for disabled-button explanations. */
const WHO: Record<OrgAction, string> = {
  "org.view": "members",
  "org.rename": "owners and admins",
  "members.manage": "owners and admins",
  "billing.manage": "owners and billing members",
  "billing.view": "owners, admins and billing members",
  "devices.link": "owners, admins and members",
  "devices.revoke": "owners and admins",
  "usage.view": "members",
};

/** "Only owners and billing members can do this (your role: admin)." — null when allowed. */
export function roleReason(role: ViewerRole | null | undefined, action: OrgAction): string | null {
  if (can(role, action)) return null;
  if (role === "staff") return "Staff view: you're not a member of this organisation, so this is read-only.";
  return `Only ${WHO[action]} can do this (your role: ${role ? ROLE_LABEL[role].toLowerCase() : "none"}).`;
}

/** Statuses in which the organisation has a live Stripe subscription (checkout refuses a second one). */
export const SUBSCRIBED: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  none: "No subscription",
  trialing: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  canceled: "Cancelled",
  incomplete: "Payment not completed",
  incomplete_expired: "Expired before payment",
  unpaid: "Unpaid",
  paused: "Paused",
};

export type Tone = "ok" | "warn" | "danger" | "neutral" | "info";
export function statusTone(s: SubscriptionStatus): Tone {
  if (s === "active" || s === "trialing") return "ok";
  if (s === "past_due" || s === "incomplete" || s === "paused") return "warn";
  if (s === "unpaid" || s === "incomplete_expired") return "danger";
  return "neutral";
}
