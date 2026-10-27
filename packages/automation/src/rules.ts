import { z } from "zod";

export const PROGRAM_MODES = ["LIVE", "REPLAY_PREPARED", "REPLAY_PLAYING", "STUDIO", "BREAK", "MANUAL", "DEGRADED"] as const;
export type ProgramMode = (typeof PROGRAM_MODES)[number];

export const TRIGGERS = [
  "round_phase",
  "round_end",
  "bomb_state",
  "player_died",
  "kills_increased",
  "probable_kill_link",
  "game_phase",
  "observer_changed",
  "epoch_changed",
  "map_end",
  "utility_activated",
  "source_stale",
  "source_recovered",
  "timeout_called",
] as const;
export type TriggerKind = (typeof TRIGGERS)[number];

const Condition = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "gte", "lte", "in", "exists"]),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof Condition>;

export const ACTION_KINDS = ["hud_cue", "hud_variant", "obs_scene", "obs_source_visibility", "sponsor_show", "replay_bookmark", "alert"] as const;

export const AutomationRule = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  schemaVersion: z.literal(1).default(1),
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  trigger: z.object({ kind: z.enum(TRIGGERS), where: z.array(Condition).default([]) }),
  conditions: z.array(Condition).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  cooldownMs: z.number().int().min(0).default(0),
  debounceMs: z.number().int().min(0).default(0),
  /** Template for de-duplication, e.g. "{eventId}" or "{data.roundNumber}". */
  dedupeKey: z.string().default("{eventId}"),
  priority: z.number().int().min(0).max(100).default(50),
  allowedProgramModes: z.array(z.enum(PROGRAM_MODES)).default(["LIVE"]),
  /** Events for "program" rules are consumed on the delayed presentation timeline. */
  timeline: z.enum(["live", "program"]).default("program"),
  action: z.object({ kind: z.enum(ACTION_KINDS), params: z.record(z.string(), z.unknown()).default({}) }),
  timeoutMs: z.number().int().min(100).max(60000).default(3000),
  retry: z.object({ max: z.number().int().min(0).max(3).default(0), backoffMs: z.number().int().min(0).default(500) }).default({ max: 0, backoffMs: 500 }),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export interface TriggerEvent {
  eventId: string;
  kind: TriggerKind;
  epoch: number;
  /** Monotonic time the underlying source observed the event. */
  observedAtMs: number;
  data: Record<string, unknown>;
}

export interface RuleContext {
  programMode: ProgramMode;
  capabilities: Record<string, string>;
  phase: string | null;
  [key: string]: unknown;
}

export interface Execution {
  ruleId: string;
  eventId: string;
  dedupeKey: string;
  action: AutomationRule["action"];
  dryRun: boolean;
  status: "executed" | "dry_run" | "skipped" | "failed";
  reason: string | null;
  attempts: number;
  at: number;
}

export type ActionExecutor = (action: AutomationRule["action"], event: TriggerEvent, rule: AutomationRule) => Promise<void>;

function lookup(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function evaluateCondition(c: Condition, scope: Record<string, unknown>): boolean {
  const v = lookup(scope, c.field);
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "neq":
      return v !== c.value;
    case "gte":
      return typeof v === "number" && typeof c.value === "number" && v >= c.value;
    case "lte":
      return typeof v === "number" && typeof c.value === "number" && v <= c.value;
    case "in":
      return Array.isArray(c.value) && c.value.includes(v);
    case "exists":
      return v !== undefined && v !== null;
  }
}

function renderKey(template: string, event: TriggerEvent): string {
  return template.replace(/\{([\w.]+)\}/g, (_, path: string) => String(lookup({ ...event }, path) ?? ""));
}

const SUPPORT_OK = new Set(["supported", "partial"]);

/**
 * Typed signal automation tied to the canonical timeline. Old events (from before the engine
 * started, before a reconnect, or from a previous epoch) are never replayed.
 */
export class RuleEngine {
  private rules: AutomationRule[] = [];
  private readonly lastFired = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>();
  private acceptAfterMs: number;
  private epoch: number | null = null;
  readonly log: Execution[] = [];

  constructor(
    private readonly executor: ActionExecutor,
    private readonly now: () => number,
  ) {
    this.acceptAfterMs = now();
  }

  setRules(rules: AutomationRule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  /** After reconnect/restart only events observed from now on are eligible. */
  resetWatermark(): void {
    this.acceptAfterMs = this.now();
    for (const t of this.debounced.values()) clearTimeout(t);
    this.debounced.clear();
  }

  private record(e: Execution): Execution {
    this.log.push(e);
    if (this.log.length > 1000) this.log.shift();
    return e;
  }

  async onEvent(event: TriggerEvent, ctx: RuleContext): Promise<Execution[]> {
    if (event.observedAtMs < this.acceptAfterMs) return [];
    if (this.epoch !== null && event.epoch < this.epoch) return [];
    this.epoch = Math.max(this.epoch ?? event.epoch, event.epoch);
    const out: Execution[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.kind !== event.kind) continue;
      const scope = { ...event, data: event.data, ctx };
      if (!rule.trigger.where.every((c) => evaluateCondition(c, scope))) continue;
      const base = { ruleId: rule.id, eventId: event.eventId, action: rule.action, dryRun: rule.dryRun, attempts: 0, at: this.now() };
      const dedupeKey = `${rule.id}:${renderKey(rule.dedupeKey, event)}`;
      if (this.seen.has(dedupeKey)) {
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: "duplicate" }));
        continue;
      }
      if (!rule.allowedProgramModes.includes(ctx.programMode)) {
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: `program mode ${ctx.programMode} not allowed` }));
        continue;
      }
      const missing = rule.requiredCapabilities.filter((c) => !SUPPORT_OK.has(ctx.capabilities[c] ?? "unverified"));
      if (missing.length > 0) {
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: `missing capabilities: ${missing.join(", ")}` }));
        continue;
      }
      if (!rule.conditions.every((c) => evaluateCondition(c, { ctx, data: event.data }))) {
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: "conditions not met" }));
        continue;
      }
      const last = this.lastFired.get(rule.id);
      if (last !== undefined && this.now() - last < rule.cooldownMs) {
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: "cooldown" }));
        continue;
      }
      this.markSeen(dedupeKey);
      if (rule.debounceMs > 0) {
        const prev = this.debounced.get(rule.id);
        if (prev) clearTimeout(prev);
        this.debounced.set(
          rule.id,
          setTimeout(() => {
            this.debounced.delete(rule.id);
            void this.execute(rule, event, dedupeKey);
          }, rule.debounceMs),
        );
        out.push(this.record({ ...base, dedupeKey, status: "skipped", reason: "debounced (pending)" }));
        continue;
      }
      out.push(await this.execute(rule, event, dedupeKey));
    }
    return out;
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
  }

  private async execute(rule: AutomationRule, event: TriggerEvent, dedupeKey: string): Promise<Execution> {
    this.lastFired.set(rule.id, this.now());
    const base = { ruleId: rule.id, eventId: event.eventId, dedupeKey, action: rule.action, dryRun: rule.dryRun, at: this.now() };
    if (rule.dryRun) return this.record({ ...base, status: "dry_run", reason: null, attempts: 0 });
    let attempts = 0;
    let lastErr: unknown = null;
    while (attempts <= rule.retry.max) {
      attempts++;
      try {
        await withTimeout(this.executor(rule.action, event, rule), rule.timeoutMs);
        return this.record({ ...base, status: "executed", reason: null, attempts });
      } catch (e) {
        lastErr = e;
        if (attempts <= rule.retry.max) await new Promise((r) => setTimeout(r, rule.retry.backoffMs));
      }
    }
    return this.record({ ...base, status: "failed", reason: lastErr instanceof Error ? lastErr.message : String(lastErr), attempts });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`action timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Example rules from the specification (disabled until the operator maps actions). */
export function exampleRules(): AutomationRule[] {
  const r = (x: Partial<AutomationRule> & Pick<AutomationRule, "id" | "name" | "trigger" | "action">) => AutomationRule.parse(x);
  return [
    r({ id: "rule-freeze-economy", name: "Freeze time → economy graphic", enabled: false, trigger: { kind: "round_phase", where: [{ field: "data.to", op: "eq", value: "freezetime" }] }, action: { kind: "hud_cue", params: { cue: "economy", durationMs: 8000 } }, dedupeKey: "{data.roundNumber}" }),
    r({ id: "rule-map-end", name: "Map ends → prepare post-map screen", enabled: false, trigger: { kind: "map_end", where: [] }, allowedProgramModes: ["LIVE", "MANUAL"], action: { kind: "hud_variant", params: { variant: "post-map" } } }),
    r({ id: "rule-multikill-bookmark", name: "Multikill → bookmark replay candidate", enabled: false, trigger: { kind: "kills_increased", where: [{ field: "data.roundKills", op: "gte", value: 3 }] }, timeline: "live", allowedProgramModes: ["LIVE", "MANUAL", "REPLAY_PREPARED"], action: { kind: "replay_bookmark", params: { preRollMs: 8000, postRollMs: 3000 } } }),
    r({ id: "rule-timeout", name: "Tactical timeout → timeout graphic", enabled: false, trigger: { kind: "game_phase", where: [{ field: "data.to", op: "in", value: ["timeout_ct", "timeout_t"] }] }, action: { kind: "hud_cue", params: { cue: "timeout" } } }),
    r({ id: "rule-round-sponsor", name: "Round win → short sponsor bug (safe window only)", enabled: false, trigger: { kind: "round_end", where: [] }, cooldownMs: 60000, action: { kind: "sponsor_show", params: { zone: "bottom_right", durationMs: 6000 } } }),
    r({ id: "rule-observer-disconnect", name: "Observer disconnect → alert and manual recovery", enabled: true, trigger: { kind: "source_stale", where: [] }, timeline: "live", allowedProgramModes: [...PROGRAM_MODES], action: { kind: "alert", params: { level: "error", message: "Observer telemetry lost — automation held; recover manually." } } }),
  ];
}
