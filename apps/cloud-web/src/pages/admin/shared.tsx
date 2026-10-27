import type { ReactNode } from "react";
import type { AdminUser, StaffRole } from "../../api/types.ts";
import { Alert, Badge } from "../../components/ui.tsx";
import { STAFF_ROLE_LABEL, adminOnlyReason, staffRoleOf } from "../../lib/staff.ts";
import { useSession } from "../../state/session.tsx";

/** The signed-in staff member's role ("support" or "admin"). */
export function useStaffRole(): { role: StaffRole | null; isAdmin: boolean; userId: string | null } {
  const { me } = useSession();
  const role = staffRoleOf(me?.user);
  return { role, isAdmin: role === "admin", userId: me?.user.id ?? null };
}

/** Explains, in place of hidden controls, that an action needs the admin staff role. */
export function AdminOnlyNote({ what, role }: { what: ReactNode; role: StaffRole | null }) {
  return (
    <Alert tone="neutral" live={false} title="Admin staff only">
      {what} {adminOnlyReason(role)}
    </Alert>
  );
}

export function StaffRoleBadge({ role }: { role: StaffRole | null }) {
  if (!role) return null;
  return <span className={`badge ${role === "admin" ? "badge-brand" : "badge-info-plain"}`}>{STAFF_ROLE_LABEL[role]}</span>;
}

export function UserBadges({ u }: { u: Pick<AdminUser, "emailVerified" | "staffRole" | "disabled" | "bootstrapAdmin"> }) {
  return (
    <span className="badge-row">
      {u.disabled && <Badge tone="danger">Disabled</Badge>}
      {u.emailVerified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}
      <StaffRoleBadge role={u.staffRole} />
      {u.bootstrapAdmin && <Badge tone="neutral">Bootstrap</Badge>}
    </span>
  );
}

export const TOPIC_LABEL: Record<string, string> = { sales: "Sales", support: "Support", billing: "Billing", legal: "Legal", other: "Other" };
