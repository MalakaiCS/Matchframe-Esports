import type { StaffRole } from "../api/types.ts";

/**
 * Staff role of the signed-in user. Servers before staff roles existed only reported `staff`; every
 * staff member had full access there, so that maps to "admin". The API stays the authority.
 */
export function staffRoleOf(user: { staff: boolean; staffRole?: StaffRole | null } | null | undefined): StaffRole | null {
  if (!user) return null;
  if (user.staffRole === "admin" || user.staffRole === "support") return user.staffRole;
  if (user.staffRole === undefined && user.staff) return "admin";
  return user.staff ? "support" : null;
}

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = { support: "Support", admin: "Admin" };

/** Plain-language summary of each staff role for the user detail page. */
export const STAFF_ROLE_INFO: Record<StaffRole | "none", string> = {
  none: "A customer account without access to the staff console.",
  support: "Looks up users and organisations, answers the support inbox, resends verification and password-reset emails and signs users out. Can't change settings, roles, the catalogue or grant hours.",
  admin: "Everything support can do, plus staff roles, disabling accounts, editing users, the plan catalogue, hour grants, Stripe events and resending logged emails.",
};

/** Why an admin-only action isn't offered (null for admins). */
export function adminOnlyReason(role: StaffRole | null): string | null {
  if (role === "admin") return null;
  return `Needs the admin staff role (your role: ${role ? STAFF_ROLE_LABEL[role].toLowerCase() : "none"}).`;
}
