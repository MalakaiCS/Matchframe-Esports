import type { EvidenceType } from "@matchframe/contracts";
import type { DerivedEvent } from "../api/types.ts";
import { perLocale, t } from "../i18n/index.ts";

export const EVIDENCE_TEXT: Record<EvidenceType, { text: string; tone: "ok" | "info" | "warn" | "neutral"; hint: string }> = perLocale(() => ({
  measured: { text: "MEASURED", tone: "ok", hint: t("lib.takenDirectlyFromASource") },
  derived: { text: "DERIVED", tone: "info", hint: t("lib.computedDeterministicallyFromMeasuredFie") },
  estimated: { text: "ESTIMATED", tone: "warn", hint: t("lib.heuristicOrModelOutputMay") },
  operator: { text: "OPERATOR", tone: "neutral", hint: t("lib.manualOperatorCorrection") },
  unknown: { text: "UNKNOWN", tone: "neutral", hint: t("lib.noSupportingEvidence") },
}));

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
      return { ...base, category: "kill", title: t("lib.nameofDied", { nameOf: nameOf(str(d.steamId)) }), detail: t("lib.lifeStateChangeOnlyKiller"), notExactKill: true };
    case "kills_increased": {
      const delta = typeof d.delta === "number" ? d.delta : 1;
      return { ...base, category: "kill", title: t("lib.nameofKillCounterDelta", { nameOf: nameOf(str(d.steamId)), delta }), detail: t("lib.cumulativeCounterChangeVictimWeapon"), notExactKill: true };
    }
    case "probable_kill_link": {
      const hs = d.headshot === "probable" ? t("lib.probableHeadshotSuffix") : "";
      return { ...base, category: "kill", title: t("lib.probableNameofNameof2Hs", { nameOf: nameOf(str(d.killer)), nameOf2: nameOf(str(d.victim)), hs }), detail: t("lib.estimatedPairingFromSimultaneousCounter"), notExactKill: true };
    }
    case "damage_taken":
      return { ...base, category: "damage", title: t("lib.nameofLostVHp", { nameOf: nameOf(str(d.steamId)), v: typeof d.amount === "number" ? d.amount : "?" }), detail: t("lib.healthDeltaOnlyAttackerAnd") };
    case "player_respawned":
      return { ...base, category: "round", title: t("lib.nameofRespawned", { nameOf: nameOf(str(d.steamId)) }) };
    case "round_end": {
      const winner = str(d.winnerSide);
      const round = typeof d.roundNumber === "number" ? t("lib.roundRoundnumber", { roundNumber: d.roundNumber }) : t("lib.round");
      return { ...base, category: "round", title: t("lib.roundWonByV", { round, v: winner ?? t("lib.unknownSide") }), detail: str(d.reason) ? t("lib.reasonReplace", { replace: String(d.reason).replace(/_/g, " ") }) : null };
    }
    case "round_phase":
      return { ...base, category: "round", title: t("lib.roundPhaseVV2", { v: str(d.from) ?? "?", v2: str(d.to) ?? "?" }), detail: typeof d.roundNumber === "number" ? t("lib.roundRoundnumber", { roundNumber: d.roundNumber }) : null };
    case "game_phase":
      return { ...base, category: "round", title: t("lib.gamePhaseVV2", { v: str(d.from) ?? "?", v2: str(d.to) ?? "?" }) };
    case "bomb_state":
      return { ...base, category: "bomb", title: str(d.site) ? t("lib.bombToSite", { to: str(d.to) ?? "?", site: String(d.site) }) : t("lib.bombTo", { to: str(d.to) ?? "?" }), detail: str(d.from) ? t("lib.wasFrom", { from: String(d.from) }) : null };
    case "observer_changed":
      return { ...base, category: "observer", title: t("lib.observerPovV", { v: d.to ? nameOf(str(d.to)) : "none" }), detail: d.from ? t("lib.fromNameof", { nameOf: nameOf(str(d.from)) }) : null };
    case "epoch_changed":
      return { ...base, category: "system", title: t("lib.newTimelineEpoch"), detail: t("lib.mapChangeReconnectOrReset") };
    default:
      return { ...base, category: "system", title: ev.kind.replace(/_/g, " ") };
  }
}
