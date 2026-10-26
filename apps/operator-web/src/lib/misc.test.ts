// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DirectorDecision } from "@matchframe/contracts";
import { backoffDelay } from "../api/ws.ts";
import { composeSettings } from "../screens/huds/Composer.tsx";
import { simplifyPoints } from "../screens/huds/Annotations.tsx";
import { routableSources } from "../screens/PlayerCameras.tsx";
import { programModeForCue } from "../screens/Studio.tsx";
import { EngineClock, phaseRemaining } from "./clock.ts";
import { parseCsv, parseRosterImport } from "./csv.ts";
import { explainDecision } from "./director.ts";
import { fmtClock, fmtMs, shotLabel, weaponName } from "./format.ts";
import { slotFromKey, slotKey } from "./players.ts";
import { retryable } from "./demos.ts";

describe("csv import", () => {
  it("parses quoted fields, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("maps header aliases and keeps SteamIDs as strings", () => {
    const rows = parseRosterImport("Nickname,Real Name,SteamID64,Team\nkaizen,Kai Brown,76561198000000001,Blue\n,,,\n");
    expect(rows).toEqual([{ displayName: "kaizen", realName: "Kai Brown", steamId: "76561198000000001", team: "Blue" }]);
    expect(typeof rows[0]!.steamId).toBe("string");
  });

  it("accepts JSON arrays", () => {
    expect(parseRosterImport('[{"displayName":"a","steamId":"76561198000000002","ignored":1}]')).toEqual([{ displayName: "a", steamId: "76561198000000002" }]);
  });
});

describe("reconnect backoff", () => {
  it("doubles from 0.5 s and caps at 10 s (no jitter at rand=0.5)", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
  it("applies ±20 % jitter", () => {
    expect(backoffDelay(3, () => 0)).toBe(1600);
    expect(backoffDelay(3, () => 1)).toBe(2400);
  });
});

describe("engine clock estimate", () => {
  it("uses the minimum offset to estimate data age", () => {
    const c = new EngineClock();
    c.observe(10_050, 50, "s:1"); // offset 10000 (fresh packet)
    c.observe(11_300, 1_000, "s:1"); // offset 10300 (snapshot pushed later)
    expect(c.offset).toBe(10_000);
    expect(c.ageOf(1_000, 12_000)).toBe(1_000);
  });
  it("resets when the session or epoch changes", () => {
    const c = new EngineClock();
    c.observe(10_000, 0, "s:1");
    c.observe(5_000, 4_000, "s:2");
    expect(c.offset).toBe(1_000);
  });
  it("advances the phase clock only while running", () => {
    expect(phaseRemaining(30, 1_000, 6_000, true)).toBe(25);
    expect(phaseRemaining(30, 1_000, 6_000, false)).toBe(30);
    expect(phaseRemaining(2, 0, 10_000, true)).toBe(0);
    expect(phaseRemaining(null, 0, 10_000, true)).toBeNull();
  });
});

describe("hold vs cut explanation", () => {
  const d = (over: Partial<DirectorDecision>): DirectorDecision =>
    ({
      decisionId: "d",
      sessionId: "s",
      epoch: 1,
      basedOnSequence: 1,
      decidedAtMonotonicMs: 0,
      mode: "advisory",
      controlHealth: "disarmed",
      currentShot: "pov:1",
      desiredShot: "pov:2",
      action: "recommend",
      reasonCodes: ["MANUAL_OWNERSHIP", "CONTACT_IMMINENT"],
      supportingFeatures: { candidateUtility: 0.65, currentUtility: 0.35 },
      confidence: 0.8,
      evidenceType: "estimated",
      policyVersion: "baseline-1",
      modelVersion: null,
      expiresInMs: 450,
      topCandidates: [],
      effectiveWeights: {},
      ...over,
    }) as DirectorDecision;
  const nameOf = (id: string) => ({ "1": "frost", "2": "kindle" })[id] ?? id;

  it("explains why a recommendation is not executed", () => {
    const ex = explainDecision(d({}), nameOf, 0.08);
    expect(ex.headline).toBe("RECOMMEND POV · kindle");
    expect(ex.lines[0]).toMatch(/operator owns the camera/);
    expect(ex.lines[0]).toMatch(/advisory mode only recommends/);
    expect(ex.lines.join(" ")).toContain("+0.30; cut threshold +0.08");
  });
  it("explains holds with their reasons", () => {
    const ex = explainDecision(d({ action: "hold", desiredShot: "pov:1", reasonCodes: ["MIN_SHOT_DURATION"], supportingFeatures: {} }), nameOf);
    expect(ex.headline).toBe("HOLD POV · frost");
    expect(ex.lines[0]).toMatch(/^Minimum shot duration/);
  });
  it("handles a missing decision", () => {
    expect(explainDecision(null, nameOf).headline).toBe("No decision yet");
  });
});

describe("composer settings", () => {
  it("writes hide flags, offsets and reduced motion while preserving other settings", () => {
    const next = composeSettings({ custom: 1, "hide.radar": true, layout: { radar: { dx: 5, dy: 0 } } }, { "hide.radar": false, "hide.killfeed": true }, { scoreboard: { dx: 10.4, dy: -3 }, radar: { dx: 0, dy: 0 } }, true);
    expect(next).toEqual({ custom: 1, "hide.killfeed": true, layout: { scoreboard: { dx: 10, dy: -3 } }, reducedMotion: true });
  });
});

describe("small helpers", () => {
  it("routes only consenting players with a source", () => {
    expect(routableSources({ a: "CamA", b: "CamB", c: "" }, [{ id: "a", cameraConsent: true }, { id: "b", cameraConsent: false }, { id: "c", cameraConsent: true }])).toEqual({ a: "CamA" });
  });
  it("simplifies telestrator strokes within the engine's point limit", () => {
    const pts = Array.from({ length: 2000 }, (_, i) => [i / 2000, 0.5] as [number, number]);
    const out = simplifyPoints(pts, 0);
    expect(out.length).toBe(500);
    expect(simplifyPoints([[0, 0], [0.001, 0], [0.5, 0.5]])).toEqual([[0, 0], [0.5, 0.5]]);
  });
  it("maps rundown kinds to program modes", () => {
    expect(programModeForCue("live_match")).toBe("LIVE");
    expect(programModeForCue("break")).toBe("BREAK");
    expect(programModeForCue("caster_card")).toBe("STUDIO");
  });
  it("maps observer slots to number keys", () => {
    expect(slotKey(0)).toBe("0");
    expect(slotKey(7)).toBe("7");
    expect(slotKey(null)).toBeNull();
    expect(slotFromKey("3")).toBe(3);
    expect(slotFromKey("x")).toBeNull();
  });
  it("formats values without inventing data", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(1500)).toBe("1.5 s");
    expect(fmtClock(84.2)).toBe("1:25");
    expect(weaponName("weapon_m4a1_silencer")).toBe("M4A1-S");
    expect(shotLabel("pov:2", (id) => (id === "2" ? "kindle" : id))).toBe("POV · kindle");
    expect(shotLabel(null, (id) => id)).toBe("—");
  });
  it("knows which demo job states can be retried", () => {
    expect(retryable("FAILED")).toBe(true);
    expect(retryable("RECOVERABLE")).toBe(true);
    expect(retryable("COMMITTED")).toBe(false);
  });
});
