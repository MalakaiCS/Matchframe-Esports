import { createContext, useContext } from "react";
import type { Me } from "../api/types.ts";
import type { Permission } from "../lib/permissions.ts";
import { can, permissionReason } from "../lib/permissions.ts";

export interface Session {
  me: Me;
}

export const SessionContext = createContext<Session>({ me: { role: null } });

export function useSession(): Session {
  return useContext(SessionContext);
}

/** Returns null when the current role has the permission, else a readable reason. */
export function usePermission(p: Permission): string | null {
  const { me } = useSession();
  return permissionReason(me.role, p);
}

export function useCan(p: Permission): boolean {
  const { me } = useSession();
  return can(me.role, p);
}
