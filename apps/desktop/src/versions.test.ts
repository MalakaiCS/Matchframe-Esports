import { describe, expect, it } from "vitest";
import { compareVersions, fitsChannel, isPrerelease, parseChannel, updaterSettings } from "./versions.ts";

describe("version comparison", () => {
  it("orders versions as semantic versions, a beta before its release", () => {
    const sorted = ["0.13.0", "0.12.4", "0.13.0-beta.10", "0.13.0-beta.2", "0.2.0", "0.13.0-beta.1", "1.0.0", "0.12.10"].sort(compareVersions);
    expect(sorted).toEqual(["0.2.0", "0.12.4", "0.12.10", "0.13.0-beta.1", "0.13.0-beta.2", "0.13.0-beta.10", "0.13.0", "1.0.0"]);
    expect(compareVersions("v0.12.4", "0.12.4")).toBe(0);
    expect(compareVersions("0.13.0-alpha.1", "0.13.0-beta.1")).toBe(-1);
    expect(compareVersions("0.13.0-beta", "0.13.0-beta.1")).toBe(-1);
    expect(() => compareVersions("latest", "0.12.4")).toThrow();
  });

  it("knows a prerelease", () => {
    expect(isPrerelease("0.13.0-beta.1")).toBe(true);
    expect(isPrerelease("0.12.4")).toBe(false);
    expect(isPrerelease("nonsense")).toBe(false);
  });
});

describe("update channels", () => {
  it("Stable reads latest.yml without prereleases or downgrades", () => {
    expect(updaterSettings("stable", "0.12.4")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false });
  });

  it("Beta reads beta.yml with prereleases, never downgrading", () => {
    expect(updaterSettings("beta", "0.12.4")).toEqual({ channel: "beta", allowPrerelease: true, allowDowngrade: false });
    expect(updaterSettings("beta", "0.13.0-beta.1")).toEqual({ channel: "beta", allowPrerelease: true, allowDowngrade: false });
  });

  it("back on Stable while running a beta, the latest Stable version is found even when older", () => {
    expect(updaterSettings("stable", "0.13.0-beta.2")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: true });
  });

  it("a Stable program never installs a beta it downloaded before switching", () => {
    expect(fitsChannel("0.13.0-beta.1", "stable")).toBe(false);
    expect(fitsChannel("0.13.0", "stable")).toBe(true);
    expect(fitsChannel("0.13.0-beta.1", "beta")).toBe(true);
    expect(fitsChannel("0.13.0", "beta")).toBe(true);
  });

  it("reads the saved setting, Stable unless Beta", () => {
    expect(parseChannel("beta")).toBe("beta");
    expect(parseChannel("stable")).toBe("stable");
    expect(parseChannel(undefined)).toBe("stable");
    expect(parseChannel("nightly")).toBe("stable");
  });
});
