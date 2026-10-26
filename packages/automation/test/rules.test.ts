import { describe, expect, it } from "vitest";
import type { AutomationRule, TriggerEvent } from "../src/index.ts";
import { AutomationRule as RuleSchema, exampleRules, RuleEngine } from "../src/index.ts";

function setup() {
  let now = 1000;
  const executed: string[] = [];
  const engine = new RuleEngine(async (a) => void executed.push(String(a.params.cue ?? a.kind)), () => now);
  return { engine, executed, advance: (ms: number) => (now += ms), now: () => now };
}

const rule = (over: Partial<AutomationRule> = {}): AutomationRule =>
  RuleSchema.parse({ id: "r1", name: "r1", trigger: { kind: "round_phase", where: [{ field: "data.to", op: "eq", value: "freezetime" }] }, action: { kind: "hud_cue", params: { cue: "economy" } }, ...over });

const ev = (id: string, at: number, data: Record<string, unknown> = { to: "freezetime", roundNumber: 3 }, epoch = 1): TriggerEvent => ({ eventId: id, kind: "round_phase", epoch, observedAtMs: at, data });
const ctx = { programMode: "LIVE" as const, capabilities: {}, phase: "freezetime" };

describe("RuleEngine", () => {
  it("executes a matching rule once and de-duplicates the same event", async () => {
    const { engine, executed, now } = setup();
    engine.setRules([rule()]);
    await engine.onEvent(ev("e1", now() + 1), ctx);
    await engine.onEvent(ev("e1", now() + 1), ctx);
    expect(executed).toEqual(["economy"]);
  });

  it("never replays events observed before the engine started or before a reconnect", async () => {
    const { engine, executed, advance, now } = setup();
    engine.setRules([rule()]);
    expect(await engine.onEvent(ev("old", 500), ctx)).toEqual([]);
    advance(1000);
    engine.resetWatermark();
    await engine.onEvent(ev("before-reconnect", now() - 10), ctx);
    expect(executed).toEqual([]);
  });

  it("respects cooldown, program mode and required capabilities", async () => {
    const { engine, executed, advance, now } = setup();
    engine.setRules([rule({ cooldownMs: 5000, dedupeKey: "{eventId}" })]);
    await engine.onEvent(ev("a", now() + 1), ctx);
    advance(1000);
    const r = await engine.onEvent(ev("b", now()), ctx);
    expect(r[0]!.reason).toBe("cooldown");
    advance(5000);
    const r2 = await engine.onEvent(ev("c", now()), { ...ctx, programMode: "REPLAY_PLAYING" });
    expect(r2[0]!.reason).toMatch(/program mode/);
    engine.setRules([rule({ id: "r2", requiredCapabilities: ["exactKillEvents"] })]);
    const r3 = await engine.onEvent(ev("d", now()), ctx);
    expect(r3[0]!.reason).toMatch(/missing capabilities/);
    expect(executed).toEqual(["economy"]);
  });

  it("ignores events from an older epoch", async () => {
    const { engine, executed, now } = setup();
    engine.setRules([rule({ dedupeKey: "{eventId}" })]);
    await engine.onEvent(ev("x", now() + 1, undefined, 3), ctx);
    await engine.onEvent(ev("y", now() + 2, undefined, 2), ctx);
    expect(executed).toEqual(["economy"]);
  });

  it("supports dry-run and records failures with bounded retries", async () => {
    let now = 1000;
    let calls = 0;
    const engine = new RuleEngine(async () => {
      calls++;
      throw new Error("mixer offline");
    }, () => now);
    engine.setRules([rule({ id: "dry", dryRun: true }), rule({ id: "fail", retry: { max: 1, backoffMs: 1 } })]);
    const r = await engine.onEvent(ev("z", now + 1), ctx);
    expect(r.find((x) => x.ruleId === "dry")!.status).toBe("dry_run");
    const f = r.find((x) => x.ruleId === "fail")!;
    expect(f.status).toBe("failed");
    expect(f.attempts).toBe(2);
    expect(calls).toBe(2);
    now++;
  });

  it("ships the specification's example rules as valid, mostly disabled definitions", () => {
    const rules = exampleRules();
    expect(rules.length).toBeGreaterThanOrEqual(6);
    expect(rules.filter((r) => r.enabled).map((r) => r.id)).toEqual(["rule-observer-disconnect"]);
  });
});
