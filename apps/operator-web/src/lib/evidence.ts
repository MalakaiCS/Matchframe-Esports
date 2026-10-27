import type { EvidenceType } from "@matchframe/contracts";
import type { DerivedEvent } from "../api/types.ts";

export const EVIDENCE_TEXT: Record<EvidenceType, { text: string; tone: "ok" | "info" | "warn" | "neutral"; hint: string }> = {
  measured: { text: "MEASURED", tone: "ok", hint: "Taken directly from a source field." },
  derived: { text: "DERIVED", tone: "info", hint: "Computed deterministically from measured fields (e.g. a counter change)." },
  estimated: { text: "ESTIMATED", tone: "warn", hint: "Heuristic or model output — may be wrong." },
  operator: { text: "OPERATOR", tone: "neutral", hint: "Manual operator correction." },
  unknown: { text: "UNKNOWN", tone: "neutral", hint: "No supporting evidence." },
};

export function evidenceText(e: string): (typeof EVIDENCE_TEXT)[EvidenceType] {
  return (EVIDENCE_TEXT as Record<string, (typeof EVIDENCE_TEXT)[EvidenceType] | undefined>)[e] ?? EVIDENCE_TEXT.unknown;
}

export type TimelineCategory = "kill" | "damage" | "round" | "bomb" | "observer" | "system";

export interface TimelineEntry {
  id: string;
  category: TimelineCategory;
  title: string;
  detail: string | null;
  evidence: EvidenceType;
  confidence: number;
  /** Set for killfeed-like entries that are NOT exact source kill events. */
  notExactKill: boolean;
  matchTimeMs: number | null;
  roundAttemptId: string | null;
}

type NameOf = (steamId: string | null | undefined) => string;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Turns a derived engine event into an operator timeline row with honest labelling. */
export function describeEvent(ev: DerivedEvent, nameOf: NameOf): TimelineEntry {
  const d = ev.data;
  const base = { id: ev.eventId, evidence: ev.evidence, confidence: ev.confidence, matchTimeMs: ev.matchTimeMs, roundAttemptId: ev.roundAttemptId, notExactKill: false, detail: null as string | null };
  switch (ev.kind) {
    case "player_died":
      return { ...base, category: "kill", title: `${nameOf(str(d.steamId))} died`, detail: "Life-state change only: killer, weapon and headshot are not reported by this source.", notExactKill: true };
    case "kills_increased": {
      const delta = typeof d.delta === "number" ? d.delta : 1;
      return { ...base, category: "kill", title: `${nameOf(str(d.steamId))} kill counter +${delta}`, detail: "Cumulative counter change: victim, weapon and order are not reported.", notExactKill: true };
    }
    case "probable_kill_link": {
      const hs = d.headshot === "probable" ? " (probable headshot)" : "";
      return { ...base, category: "kill", title: `Probable: ${nameOf(str(d.killer))} → ${nameOf(str(d.victim))}${hs}`, detail: "Estimated pairing from simultaneous counter changes — not an exact kill event.", notExactKill: true };
    }
    case "damage_taken":
      return { ...base, category: "damage", title: `${nameOf(str(d.steamId))} lost ${typeof d.amount === "number" ? d.amount : "?"} HP`, detail: "Health delta only: attacker and cause are not reported." };
    case "player_respawned":
      return { ...base, category: "round", title: `${nameOf(str(d.steamId))} respawned` };
    case "round_end": {
      const winner = str(d.winnerSide);
      const round = typeof d.roundNumber === "number" ? `Round ${d.roundNumber}` : "Round";
      return { ...base, category: "round", title: `${round} won by ${winner ?? "unknown side"}`, detail: str(d.reason) ? `Reason: ${String(d.reason).replace(/_/g, " ")}` : null };
    }
    case "round_phase":
      return { ...base, category: "round", title: `Round phase: ${str(d.from) ?? "?"} → ${str(d.to) ?? "?"}`, detail: typeof d.roundNumber === "number" ? `Round ${d.roundNumber}` : null };
    case "game_phase":
      return { ...base, category: "round", title: `Game phase: ${str(d.from) ?? "?"} → ${str(d.to) ?? "?"}` };
    case "bomb_state":
      return { ...base, category: "bomb", title: `Bomb ${str(d.to) ?? "?"}${str(d.site) ? ` (site ${d.site})` : ""}`, detail: str(d.from) ? `was ${d.from}` : null };
    case "observer_changed":
      return { ...base, category: "observer", title: `Observer POV → ${d.to ? nameOf(str(d.to)) : "none"}`, detail: d.from ? `from ${nameOf(str(d.from))}` : null };
    case "epoch_changed":
      return { ...base, category: "system", title: "New timeline epoch", detail: "Map change, reconnect or reset: earlier state is not mixed into the new epoch." };
    default:
      return { ...base, category: "system", title: ev.kind.replace(/_/g, " ") };
  }
}
