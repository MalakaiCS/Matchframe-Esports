import { z } from "zod";

/** Demo ingest job state machine (spec §15.2). */
export const DEMO_JOB_STATES = [
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
] as const;
export const DemoJobState = z.enum(DEMO_JOB_STATES);
export type DemoJobState = z.infer<typeof DemoJobState>;

/** Allowed transitions. Anything else is rejected by the job store. */
export const DEMO_JOB_TRANSITIONS: Record<DemoJobState, readonly DemoJobState[]> = {
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

export const RetentionPolicy = z.enum([
  "keep_originals",
  "quarantine_then_remove",
  "keep_curated_sample",
  "keep_until_backup_confirmed",
  "remove_after_validation",
  /** Removed (after the quarantine period) once the dataset is uploaded to the storage and checked there. */
  "remove_after_upload",
]);
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const JobProgress = z.object({
  jobId: z.string(),
  kind: z.enum(["demo_import", "training", "evaluation", "export", "feature_build"]),
  state: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  message: z.string().nullable(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export type JobProgress = z.infer<typeof JobProgress>;
