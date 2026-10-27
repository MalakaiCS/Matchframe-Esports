// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { at, err, fakeFetch, makeMe, renderWithSession } from "../test/helpers.tsx";
import { LinkComputer, normalizeCode } from "./LinkComputer.tsx";

const preview = { deviceName: "OBSERVER-01", platform: "win32", appVersion: "0.1.0", requestedAt: "2026-10-26T12:00:00.000Z", expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() };
const free = { id: "free", name: "Free", description: "", priceMonthlyCents: 0, currency: "usd", includedAutoDirectorHours: 2, features: { autoDirector: true, learnedDirectorShadow: false, fullActionObserver: false, maxDevices: 1, maxMembers: 2 }, stripePriceId: null, public: true, sortOrder: 0 };
const orgDetails = { id: "org_1", name: "Northside Broadcast", createdAt: "2026-10-01T00:00:00.000Z", role: "owner", plan: free, subscriptionStatus: "none" };

function routes(extra: Record<string, Parameters<typeof fakeFetch>[0][string]> = {}) {
  return fakeFetch({
    "GET /v1/device-link/BCDF-GHJK": { body: preview },
    "GET /v1/orgs/org_1": { body: orgDetails },
    "GET /v1/orgs/org_1/devices": { body: [] },
    ...extra,
  });
}

beforeEach(() => at("/link?code=BCDF-GHJK"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("normalizeCode", () => {
  it("accepts what people type", () => {
    expect(normalizeCode("bcdfghjk")).toBe("BCDF-GHJK");
    expect(normalizeCode(" bcdf - ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeCode("BCD")).toBe("BCD");
    expect(normalizeCode("BCDFGHJKLMN")).toBe("BCDF-GHJK");
  });
});

describe("link page", () => {
  it("shows the pending computer, the organisation picker and capacity", async () => {
    routes();
    renderWithSession(<LinkComputer />, makeMe());
    await screen.findByText("OBSERVER-01");
    expect(screen.getByText("Windows")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
    const radio = screen.getByRole("radio", { name: /Northside Broadcast/ }) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    await screen.findByText(/0 of 1 linked computer on the Free plan/);
    const approve = screen.getByRole("button", { name: "Approve and link" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });

  it("normalises a lowercase code from the URL before looking it up", async () => {
    at("/link?code=bcdfghjk");
    const f = routes();
    renderWithSession(<LinkComputer />, makeMe());
    await screen.findByText("OBSERVER-01");
    expect(f.calls[0]!.url).toBe("/v1/device-link/BCDF-GHJK");
  });

  it("approves for the chosen organisation and says what happens next", async () => {
    const f = routes({ "POST /v1/device-link/approve": { body: { approved: true, deviceName: "OBSERVER-01" } } });
    renderWithSession(<LinkComputer />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Approve and link" }));
    await screen.findByText("OBSERVER-01 is approved");
    expect(screen.getByText(/Return to the Matchframe program/)).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ userCode: "BCDF-GHJK", orgId: "org_1" });
    expect(screen.getByRole("link", { name: "See linked computers" }).getAttribute("href")).toBe("/orgs/org_1/computers");
  });

  it("explains device_limit with ways out and keeps the request open", async () => {
    routes({ "POST /v1/device-link/approve": err(409, "device_limit", "the Free plan allows 1 linked computer(s); unlink one or upgrade") });
    renderWithSession(<LinkComputer />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Approve and link" }));
    await screen.findByText("This organisation has no free computer slot");
    expect(screen.getByText(/The Free plan allows 1 linked computer\(s\); unlink one or upgrade\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Unlink a computer" }).getAttribute("href")).toBe("/orgs/org_1/computers");
    expect(screen.getByRole("link", { name: "Upgrade the plan" }).getAttribute("href")).toBe("/orgs/org_1/billing#plans");
    expect((screen.getByRole("button", { name: "Approve and link" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers manual entry when the code is invalid or expired", async () => {
    routes({ "GET /v1/device-link/BCDF-GHJK": err(404, "invalid_code", "this code is invalid or expired; start linking again in the desktop app") });
    renderWithSession(<LinkComputer />, makeMe());
    await screen.findByText("This code can't be used");
    const input = screen.getByLabelText("Code from the Matchframe program") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzzzqqqq" } });
    expect(input.value).toBe("ZZZZ-QQQQ");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(window.location.search).toBe("?code=ZZZZ-QQQQ");
  });

  it("handles an approve that races the code's expiry", async () => {
    routes({ "POST /v1/device-link/approve": err(404, "invalid_code", "this code is invalid or expired; start linking again in the desktop app") });
    renderWithSession(<LinkComputer />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Approve and link" }));
    await screen.findByText("This code can't be used");
  });

  it("requires a verified email before approving, and says so", async () => {
    routes();
    renderWithSession(<LinkComputer />, makeMe({ user: { emailVerified: false } }));
    const approve = (await screen.findByRole("button", { name: "Approve and link" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const why = document.getElementById(approve.getAttribute("aria-describedby")!)!;
    expect(why.textContent).toBe("Verify your email address before linking computers.");
    expect(screen.getByRole("button", { name: "Resend the email" })).toBeTruthy();
  });

  it("shows email_unverified from the API with a resend button", async () => {
    routes({ "POST /v1/device-link/approve": err(403, "email_unverified", "verify your email address first") });
    renderWithSession(<LinkComputer />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Approve and link" }));
    await screen.findByText("Verify your email first");
    expect(screen.getByRole("button", { name: "Resend the email" })).toBeTruthy();
  });

  it("disables organisations where the role can't link computers", async () => {
    routes({ "GET /v1/orgs/org_2": { body: { ...orgDetails, id: "org_2" } }, "GET /v1/orgs/org_2/devices": { body: [] } });
    const me = makeMe({ orgs: [
      { id: "org_1", name: "Northside Broadcast", role: "billing", planId: "free", planName: "Free", subscriptionStatus: "none" },
      { id: "org_2", name: "Second Org", role: "member", planId: "free", planName: "Free", subscriptionStatus: "none" },
    ] });
    renderWithSession(<LinkComputer />, me);
    const billingOrg = (await screen.findByRole("radio", { name: /Northside Broadcast/ })) as HTMLInputElement;
    expect(billingOrg.disabled).toBe(true);
    expect(screen.getByText(/billing members can't link computers/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Second Org/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("denies the request", async () => {
    const f = routes({ "POST /v1/device-link/deny": { body: { denied: true } } });
    renderWithSession(<LinkComputer />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await screen.findByText("Request denied");
    await waitFor(() => expect(f.calls.find((c) => c.url === "/v1/device-link/deny")!.body).toEqual({ userCode: "BCDF-GHJK" }));
  });

  it("asks for the code when none is given", () => {
    at("/link");
    const f = routes();
    renderWithSession(<LinkComputer />, makeMe());
    expect(screen.getByLabelText("Code from the Matchframe program")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Enter the 8-letter code/)).toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });
});
