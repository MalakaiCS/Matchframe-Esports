import type { MatchState, PlayerState } from "@matchframe/contracts";

/** Name lookup for SteamIDs from the live state; unknown IDs are shown shortened, never invented. */
export function makeNameOf(state: MatchState | null | undefined): (steamId: string | null | undefined) => string {
  const map = new Map<string, string>();
  for (const p of state?.players ?? []) map.set(p.steamId, p.name);
  return (id) => {
    if (!id) return "unknown";
    return map.get(id) ?? `#${id.slice(-5)}`;
  };
}

export function playersBySide(state: MatchState | null | undefined): { CT: PlayerState[]; T: PlayerState[]; none: PlayerState[] } {
  const out = { CT: [] as PlayerState[], T: [] as PlayerState[], none: [] as PlayerState[] };
  for (const p of state?.players ?? []) {
    if (p.side === "CT") out.CT.push(p);
    else if (p.side === "T") out.T.push(p);
    else out.none.push(p);
  }
  const bySlot = (a: PlayerState, b: PlayerState) => (a.observerSlot ?? 99) - (b.observerSlot ?? 99) || a.name.localeCompare(b.name);
  out.CT.sort(bySlot);
  out.T.sort(bySlot);
  out.none.sort(bySlot);
  return out;
}

/** A player's spectator number key (PlayerState.observerKey: 1–9, 0) as text. */
export function slotKey(slot: number | null | undefined): string | null {
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 9) return null;
  return String(slot);
}

export function slotFromKey(key: string): number | null {
  if (!/^[0-9]$/.test(key)) return null;
  return Number(key);
}
