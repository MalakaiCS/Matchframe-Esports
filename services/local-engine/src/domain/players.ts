import type { Player } from "@matchframe/contracts";

/** Splits a full name on its first space ("Kai Brown" → Kai / Brown; one word → first name only). */
export function splitRealName(realName: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const v = (realName ?? "").trim();
  if (!v) return { firstName: null, lastName: null };
  const at = v.indexOf(" ");
  if (at < 0) return { firstName: v, lastName: null };
  return { firstName: v.slice(0, at), lastName: v.slice(at + 1).trim() || null };
}

/** The compatibility realName for a first and last name. */
export function joinRealName(firstName: string | null | undefined, lastName: string | null | undefined): string | null {
  const v = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
  return v || null;
}

/**
 * A player's first and last name for display and for the imported-HUD API (`firstName`,
 * `lastName`): the stored names, or the split realName of a record from an older version.
 */
export function playerNames(p: Pick<Player, "firstName" | "lastName" | "realName">): { firstName: string; lastName: string } {
  if (p.firstName || p.lastName) return { firstName: p.firstName ?? "", lastName: p.lastName ?? "" };
  const s = splitRealName(p.realName);
  return { firstName: s.firstName ?? "", lastName: s.lastName ?? "" };
}

/**
 * Name fields for a write: firstName/lastName win; a body with only realName (older clients and
 * imports) is split; realName is always derived from the two.
 */
export function normalizePlayerNames(body: Record<string, unknown>, current?: Pick<Player, "firstName" | "lastName" | "realName">): Record<string, unknown> {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  let first = has("firstName") ? clean(body.firstName) : (current?.firstName ?? null);
  let last = has("lastName") ? clean(body.lastName) : (current?.lastName ?? null);
  if (!has("firstName") && !has("lastName") && has("realName")) {
    const s = splitRealName(typeof body.realName === "string" ? body.realName : null);
    first = s.firstName;
    last = s.lastName;
  } else if (!current && !has("firstName") && !has("lastName")) {
    first = null;
    last = null;
  }
  const touched = has("firstName") || has("lastName") || has("realName");
  if (!touched && current) return body;
  return { ...body, firstName: first, lastName: last, realName: joinRealName(first, last) };
}
