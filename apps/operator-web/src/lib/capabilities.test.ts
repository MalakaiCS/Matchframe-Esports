// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Capability, SourceCapabilities } from "@matchframe/contracts";
import { capabilityGate, capabilityMeta, flattenCapabilities } from "./capabilities.ts";

const cap = (support: Capability["support"], limitations: string[] = []): Capability => ({ key: "k", support, sourceId: null, testedGameBuild: null, lastVerifiedAt: null, limitations, precision: null });

describe("capabilityGate", () => {
  it("disables unverified static cameras with the setup hint", () => {
    const g = capabilityGate("staticCameraControl", cap("unverified"));
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe("Static cameras: unverified — press Start Auto Director: it shows a camera and checks it with getpos");
  });

  it("lets a manual request through while unverified: the request is the check", () => {
    const g = capabilityGate("playerSelectionControl", cap("unverified"), { allowUnverified: true });
    expect(g).toMatchObject({ enabled: true, support: "unverified" });
    expect(g.reason).toMatch(/your first request confirms it/);
    expect(capabilityGate("playerSelectionControl", cap("unsupported"), { allowUnverified: true }).enabled).toBe(false);
  });

  it("disables unsupported capabilities using the first limitation", () => {
    const g = capabilityGate("cameraPathControl", cap("unsupported", ["paths not simulated", "second"]));
    expect(g).toEqual({ enabled: false, reason: "Camera paths: unsupported — paths not simulated", support: "unsupported" });
  });

  it("enables partial support but keeps the caveat visible", () => {
    const g = capabilityGate("staticCameraControl", cap("partial", ["operator-confirmed visual check only"]));
    expect(g.enabled).toBe(true);
    expect(g.reason).toContain("partial — operator-confirmed visual check only");
  });

  it("can treat partial support as insufficient", () => {
    expect(capabilityGate("playerSelectionControl", cap("partial"), { allowPartial: false }).enabled).toBe(false);
  });

  it("labels simulation-only support so it never reads as certified", () => {
    const g = capabilityGate("playerSelectionControl", cap("supported"), { simulated: true });
    expect(g.enabled).toBe(true);
    expect(g.reason).toMatch(/SIMULATION adapter only/);
  });

  it("is disabled with an explanation before any capability report exists", () => {
    const g = capabilityGate("staticCameraControl", null);
    expect(g.enabled).toBe(false);
    expect(g.support).toBe("unknown");
    expect(g.reason).toMatch(/no capability report yet/);
  });
});

describe("flattenCapabilities", () => {
  it("expands per-grenade-type entries with readable labels", () => {
    const base = cap("unverified");
    const caps = { allPlayerState: base, grenadeTypeSupport: { he: base, smoke: base } } as unknown as SourceCapabilities;
    const rows = flattenCapabilities(caps).map(([k]) => k);
    expect(rows).toEqual(["allPlayerState", "grenadeTypeSupport.he", "grenadeTypeSupport.smoke"]);
    expect(capabilityMeta("grenadeTypeSupport.he").label).toBe("HE grenade telemetry");
  });
});
