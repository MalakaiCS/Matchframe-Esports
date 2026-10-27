// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DerivedEvent, OperatorSnapshot } from "../api/types.ts";
import { LiveStore } from "./live.ts";

const env = (topic: string, payload: unknown, sessionId = "s1") => ({ schemaVersion: 1, topic, sessionId, epoch: 1, sequence: 1, sourceId: "x", matchTimeMs: null, timeUncertaintyMs: null, payload });
const ev = (id: string, t: number): DerivedEvent => ({ eventId: id, kind: "round_phase", sessionId: "s1", epoch: 1, roundAttemptId: null, sequence: 1, receivedAtMonotonicMs: t, matchTimeMs: null, timeUncertaintyMs: null, evidence: "measured", confidence: 1, data: {} });
const snap = (sequence: number, receivedAt: number) => ({ state: { sessionId: "s1", epoch: 1, sequence, time: { receivedAtMonotonicMs: receivedAt } } }) as unknown as OperatorSnapshot;

describe("LiveStore", () => {
  it("keeps the latest snapshot and tracks when telemetry last advanced", () => {
    const s = new LiveStore();
    s.handle(env("state.snapshot", snap(5, 100)), 1_000);
    s.handle(env("state.snapshot", snap(5, 100)), 1_500);
    expect(s.state.sequenceChangedAt).toBe(1_000);
    s.handle(env("state.snapshot", snap(6, 200)), 2_000);
    expect(s.state.sequenceChangedAt).toBe(2_000);
    expect(s.state.snapshotAt).toBe(2_000);
  });

  it("de-duplicates and orders events from the socket and REST history", () => {
    const s = new LiveStore();
    s.handle(env("events", [ev("b", 20), ev("a", 10)]));
    s.mergeEvents([ev("a", 10), ev("c", 5)]);
    expect(s.state.events.map((e) => e.eventId)).toEqual(["c", "a", "b"]);
  });

  it("groups repeated alerts instead of flooding", () => {
    const s = new LiveStore();
    const a = { level: "warn", code: "stale_telemetry", message: "Telemetry is stale" };
    s.handle(env("alerts", a), 1);
    s.handle(env("alerts", a), 2);
    expect(s.state.alerts).toHaveLength(1);
    expect(s.state.alerts[0]!.count).toBe(2);
  });

  it("drops the previous session's events when the engine session changes (resync)", () => {
    const s = new LiveStore();
    s.handle(env("state.snapshot", snap(1, 1)), 1);
    s.handle(env("events", [ev("old", 1)]));
    s.handle(env("state.snapshot", snap(1, 1), "s2"), 2);
    expect(s.state.events).toHaveLength(0);
    expect(s.state.sessionId).toBe("s2");
  });

  it("ignores non-envelope messages such as pong", () => {
    const s = new LiveStore();
    s.handle({ type: "pong", at: 1 });
    expect(s.state.snapshot).toBeNull();
  });
});
