// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { ownershipView } from "./ownership.ts";

const base: OwnershipState = { owner: "operator", generation: 3, holder: "local-operator", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: true, emergencyStopped: false };

describe("ownershipView", () => {
  it("shows sticky MANUAL with an explicit resume action", () => {
    const v = ownershipView(base, null);
    expect(v.kind).toBe("manual");
    expect(v.badge).toBe("MANUAL");
    expect(v.actions).toEqual(["resume"]);
    expect(v.detail).toMatch(/sticky/);
  });

  it("shows the resume countdown with cancel", () => {
    const v = ownershipView(base, 2350);
    expect(v.kind).toBe("resuming");
    expect(v.badge).toBe("RESUMING IN 2.4 s");
    expect(v.actions).toEqual(["cancel_resume"]);
  });

  it("gives emergency stop precedence over everything and only offers clearing it", () => {
    const v = ownershipView({ ...base, owner: "director", manualSticky: false, emergencyStopped: true }, 1000);
    expect(v.kind).toBe("emergency");
    expect(v.badge).toBe("EMERGENCY STOP");
    expect(v.tone).toBe("danger");
    expect(v.actions).toEqual(["clear_emergency"]);
  });

  it("shows AUTOMATION when the director owns the camera", () => {
    const v = ownershipView({ ...base, owner: "director", manualSticky: false }, null);
    expect(v.kind).toBe("automation");
    expect(v.actions).toEqual(["takeover"]);
  });

  it("names device and remote holders", () => {
    expect(ownershipView({ ...base, owner: "device", holder: "streamdeck-1" }, null).detail).toContain("streamdeck-1");
    expect(ownershipView({ ...base, owner: "remote", holder: "producer" }, null).badge).toBe("REMOTE CONTROL");
  });

  it("is neutral before the engine reports ownership", () => {
    expect(ownershipView(null, null).kind).toBe("unknown");
  });
});
