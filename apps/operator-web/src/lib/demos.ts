import type { DemoJobState, RetentionPolicy } from "@matchframe/contracts";

/** Demo ingest states in pipeline order (mirrors DEMO_JOB_STATES in the contracts). */
export const DEMO_STATES = [
  "DISCOVERED",
  "HASHED",
  "QUEUED",
  "PARSING",
  "EXTRACTED",
  "VALIDATING",
  "COMMITTED",
  "RETENTION_ELIGIBLE",
  "QUARANTINED_RAW",
  "RAW_REMOVED",
  "FAILED",
  "QUARANTINED",
  "RECOVERABLE",
  "DUPLICATE",
] as const satisfies readonly DemoJobState[];

// Compile-time completeness check: every contract state is listed above.
type _Missing = Exclude<DemoJobState, (typeof DEMO_STATES)[number]>;
const _complete: _Missing extends never ? true : false = true;
void _complete;

export const DEMO_TRANSITIONS: Record<DemoJobState, readonly DemoJobState[]> = {
  DISCOVERED: ["HASHED", "FAILED", "QUARANTINED"],
  HASHED: ["QUEUED", "DUPLICATE", "FAILED", "QUARANTINED"],
  QUEUED: ["PARSING", "FAILED"],
  PARSING: ["EXTRACTED", "FAILED", "QUARANTINED", "RECOVERABLE"],
  EXTRACTED: ["VALIDATING", "FAILED", "RECOVERABLE"],
  VALIDATING: ["COMMITTED", "FAILED", "QUARANTINED", "RECOVERABLE"],
  COMMITTED: ["RETENTION_ELIGIBLE"],
  RETENTION_ELIGIBLE: ["QUARANTINED_RAW"],
  QUARANTINED_RAW: ["RAW_REMOVED", "RETENTION_ELIGIBLE"],
  RAW_REMOVED: [],
  FAILED: ["QUEUED"],
  QUARANTINED: [],
  RECOVERABLE: ["QUEUED"],
  DUPLICATE: [],
};

export function demoStateTone(s: DemoJobState): "ok" | "info" | "warn" | "danger" | "neutral" {
  if (s === "COMMITTED" || s === "RETENTION_ELIGIBLE" || s === "RAW_REMOVED") return "ok";
  if (s === "FAILED" || s === "QUARANTINED") return "danger";
  if (s === "RECOVERABLE" || s === "QUARANTINED_RAW" || s === "DUPLICATE") return "warn";
  if (s === "PARSING" || s === "EXTRACTED" || s === "VALIDATING" || s === "QUEUED" || s === "HASHED") return "info";
  return "neutral";
}

export const RETENTION_POLICIES: { id: RetentionPolicy; label: string; hint: string }[] = [
  { id: "keep_originals", label: "Keep originals", hint: "Never delete raw demos." },
  { id: "quarantine_then_remove", label: "Quarantine, then remove", hint: "Move raw demos to quarantine after validation; delete after the quarantine period." },
  { id: "keep_curated_sample", label: "Keep a curated sample", hint: "Keep an audit sample of raw demos; quarantine the rest." },
  { id: "keep_until_backup_confirmed", label: "Keep until backup confirmed", hint: "Raw demos are only removed after you confirm a backup of their SHA-256." },
  { id: "remove_after_validation", label: "Remove after validation", hint: "Delete raw demos right after the dataset validates (irreversible)." },
];

export function retryable(s: DemoJobState): boolean {
  return DEMO_TRANSITIONS[s].includes("QUEUED");
}
