// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { REASON_CODES } from "@matchframe/contracts";
import { REASON_INFO, reasonInfo, reasonLabel } from "./reasons.ts";

describe("reason code labels", () => {
  it("has a human-readable label and hint for every contract reason code", () => {
    for (const code of REASON_CODES) {
      const info = REASON_INFO[code];
      expect(info, code).toBeDefined();
      expect(info.label.length, code).toBeGreaterThan(3);
      expect(info.label, code).not.toMatch(/_/);
      expect(info.hint.length, code).toBeGreaterThan(10);
    }
  });

  it("uses distinct labels", () => {
    const labels = REASON_CODES.map((c) => REASON_INFO[c].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("flags unsafe states with danger/warn tones", () => {
    expect(reasonInfo("STALE_DATA").tone).toBe("danger");
    expect(reasonInfo("EMERGENCY_STOP").tone).toBe("danger");
    expect(reasonInfo("MANUAL_OWNERSHIP").tone).toBe("warn");
  });

  it("falls back gracefully for codes newer than the console", () => {
    expect(reasonLabel("SOMETHING_NEW")).toBe("Unrecognised reason (SOMETHING_NEW)");
    expect(reasonLabel("CONTACT_IMMINENT")).toBe("Contact imminent");
  });
});
