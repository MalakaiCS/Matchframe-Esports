import { z } from "zod";

/** Versioned WebSocket envelope (spec §25.2). Deltas are never applied across epochs. */
export const EventEnvelope = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    schemaVersion: z.number().int(),
    topic: z.string(),
    sessionId: z.string(),
    epoch: z.number().int(),
    sequence: z.number().int(),
    sourceId: z.string(),
    matchTimeMs: z.number().nullable(),
    timeUncertaintyMs: z.number().nullable(),
    payload,
  });

export interface EventEnvelope<T> {
  schemaVersion: number;
  topic: string;
  sessionId: string;
  epoch: number;
  sequence: number;
  sourceId: string;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
  payload: T;
}

/** Topics on the operator socket (privileged) and public overlay socket (approved projection only). */
export const OPERATOR_TOPICS = [
  "state.snapshot",
  "state.delta",
  "director.decision",
  "director.status",
  "observer.command",
  "observer.state",
  "capabilities",
  "program.state",
  "obs.status",
  "alerts",
  "jobs",
  "replay.queue",
  "audit",
] as const;

export const PUBLIC_TOPICS = ["hud.snapshot", "hud.config", "hud.annotation", "hud.cue"] as const;
export type OperatorTopic = (typeof OPERATOR_TOPICS)[number];
export type PublicTopic = (typeof PUBLIC_TOPICS)[number];
