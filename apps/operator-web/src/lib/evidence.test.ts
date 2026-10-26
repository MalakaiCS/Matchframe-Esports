// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DerivedEvent } from "../api/types.ts";
import { describeEvent, EVIDENCE_TEXT, evidenceText } from "./evidence.ts";

const ev = (kind: string, data: Record<string, unknown>, evidence: DerivedEvent["evidence"] = "derived"): DerivedEvent => ({
  eventId: `ev_${kind}`,
  kind,
  sessionId: "s",
  epoch: 1,
  roundAttemptId: "e1.r4.a1",
  sequence: 10,
  receivedAtMonotonicMs: 1000,
  matchTimeMs: 61000,
  timeUncertaintyMs: 150,
  evidence,
  confidence: 0.9,
  data,
});
const names: Record<string, string> = { "1": "frost", "2": "kindle" };
const nameOf = (id: string | null | undefined) => (id ? (names[id] ?? `#${id}`) : "unknown");

describe("timeline evidence", () => {
  it("labels deaths as derived and NOT exact kill events", () => {
    const r = describeEvent(ev("player_died", { steamId: "1" }), nameOf);
    expect(r.title).toBe("frost died");
    expect(r.notExactKill).toBe(true);
    expect(r.evidence).toBe("derived");
    expect(r.detail).toMatch(/killer, weapon and headshot are not reported/);
  });

  it("labels probable kill pairings as estimated, never exact", () => {
    const r = describeEvent(ev("probable_kill_link", { killer: "2", victim: "1", headshot: "probable" }, "estimated"), nameOf);
    expect(r.title).toBe("Probable: kindle → frost (probable headshot)");
    expect(r.notExactKill).toBe(true);
    expect(evidenceText(r.evidence).text).toBe("ESTIMATED");
  });

  it("does not invent a victim for kill counter changes", () => {
    const r = describeEvent(ev("kills_increased", { steamId: "2", delta: 1, victim: null }), nameOf);
    expect(r.title).toBe("kindle kill counter +1");
    expect(r.title).not.toMatch(/frost/);
    expect(r.notExactKill).toBe(true);
  });

  it("describes measured round and bomb events without the kill caveat", () => {
    const end = describeEvent(ev("round_end", { roundNumber: 4, winnerSide: "CT", reason: "ct_win_defuse" }, "measured"), nameOf);
    expect(end.title).toBe("Round 4 won by CT");
    expect(end.detail).toBe("Reason: ct win defuse");
    expect(end.notExactKill).toBe(false);
    expect(describeEvent(ev("bomb_state", { from: "carried", to: "planted", site: "B" }, "measured"), nameOf).title).toBe("Bomb planted (site B)");
  });

  it("maps every evidence type to a text badge (never colour alone)", () => {
    for (const [k, v] of Object.entries(EVIDENCE_TEXT)) expect(v.text, k).toBe(k.toUpperCase());
    expect(evidenceText("something-else").text).toBe("UNKNOWN");
  });
});
