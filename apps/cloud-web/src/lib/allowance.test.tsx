// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AutoDirectorAllowance } from "@matchframe/cloud-contracts";
import { AllowanceMeter } from "../components/AllowanceMeter.tsx";
import { allowanceView } from "./allowance.ts";

const base: AutoDirectorAllowance = {
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  includedSeconds: 7200,
  creditSeconds: 0,
  usedSeconds: 0,
  remainingSeconds: 7200,
  overageAllowed: false,
};
const a = (over: Partial<AutoDirectorAllowance>) => ({ ...base, ...over });

afterEach(cleanup);

describe("allowanceView", () => {
  it("is fine with time left", () => {
    expect(allowanceView(a({ usedSeconds: 3600, remainingSeconds: 3600 }))).toEqual({ budgetSeconds: 7200, usedSeconds: 3600, remainingSeconds: 3600, overSeconds: 0, fraction: 0.5, state: "ok", canArm: true });
  });

  it("warns when running low", () => {
    const v = allowanceView(a({ usedSeconds: 6500, remainingSeconds: 700 }));
    expect(v.state).toBe("low");
    expect(v.canArm).toBe(true);
  });

  it("is exhausted at exactly zero: automation can't be re-armed", () => {
    const v = allowanceView(a({ usedSeconds: 7200, remainingSeconds: 0 }));
    expect([v.state, v.canArm, v.fraction]).toEqual(["exhausted", false, 1]);
  });

  it("reports negative remaining as over the limit (a map is never cut off)", () => {
    const v = allowanceView(a({ usedSeconds: 8000, remainingSeconds: -800 }));
    expect(v).toMatchObject({ state: "over", overSeconds: 800, remainingSeconds: 0, budgetSeconds: 7200, fraction: 1, canArm: false });
  });

  it("counts hour credits in the budget (used + remaining = included + credits drawn + credits left)", () => {
    // From the API's own test: 3.5 h used of 2 h included, 1.5 h of credits drawn, 1.5 h left.
    const v = allowanceView(a({ usedSeconds: 12_600, creditSeconds: 5400, remainingSeconds: 5400 }));
    expect(v).toMatchObject({ budgetSeconds: 18_000, fraction: 0.7, state: "ok" });
  });

  it("has nothing to show when the plan has no automatic direction", () => {
    const v = allowanceView(a({ includedSeconds: 0, remainingSeconds: 0 }));
    expect([v.state, v.fraction, v.canArm]).toEqual(["none", 0, false]);
  });
});

describe("AllowanceMeter", () => {
  it("shows remaining time big, the bar and exact values", () => {
    render(<AllowanceMeter allowance={a({ usedSeconds: 3600, remainingSeconds: 3600 })} planName="Free" />);
    const bar = screen.getByRole("progressbar", { name: "Auto-director hours used this period" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuetext")).toBe("1 h 00 used of 2 h 00; 1 h 00 remaining");
    expect(screen.getByText("remaining this period")).toBeTruthy();
    expect(screen.getByText("Included with Free")).toBeTruthy();
    expect(screen.getAllByText("7,200 s (2 h)").length).toBeGreaterThan(0);
    const big = document.querySelector(".meter-big time")!;
    expect(big.textContent).toBe("1 h 00");
    expect(big.getAttribute("datetime")).toBe("PT1H0M0S");
    expect(big.getAttribute("title")).toBe("3,600 s (1 h)");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains being over the limit without surprise charges", () => {
    render(<AllowanceMeter allowance={a({ usedSeconds: 8000, remainingSeconds: -800 })} />);
    expect(screen.getByText("over the limit")).toBeTruthy();
    expect(document.querySelector(".meter-big")!.textContent).toBe("−0 h 13");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Over the limit by 0 h 13/);
    expect(alert.textContent).toMatch(/never stops in the middle of a map/);
    expect(alert.textContent).toMatch(/no charge for the overrun/);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("2 h 13 used; 0 h 13 over the limit");
  });

  it("says when hours are used up and when they run low", () => {
    const { unmount } = render(<AllowanceMeter allowance={a({ usedSeconds: 7200, remainingSeconds: 0 })} />);
    expect(screen.getByText("No auto-director hours left")).toBeTruthy();
    unmount();
    render(<AllowanceMeter allowance={a({ usedSeconds: 6600, remainingSeconds: 600 })} />);
    expect(screen.getByText("Running low")).toBeTruthy();
  });
});
