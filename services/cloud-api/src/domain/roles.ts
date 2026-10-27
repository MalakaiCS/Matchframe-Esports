import type { OrgRole } from "@matchframe/cloud-contracts";

export type OrgAction = "org.view" | "org.rename" | "members.manage" | "billing.manage" | "billing.view" | "devices.link" | "devices.revoke" | "usage.view";

const MATRIX: Record<OrgRole, readonly OrgAction[]> = {
  owner: ["org.view", "org.rename", "members.manage", "billing.manage", "billing.view", "devices.link", "devices.revoke", "usage.view"],
  admin: ["org.view", "org.rename", "members.manage", "billing.view", "devices.link", "devices.revoke", "usage.view"],
  billing: ["org.view", "billing.manage", "billing.view", "usage.view"],
  member: ["org.view", "devices.link", "usage.view"],
};

export const roleCan = (role: OrgRole, action: OrgAction) => MATRIX[role].includes(action);
