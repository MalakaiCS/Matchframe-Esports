// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../App.tsx";
import type { AdminOrgDetail, AdminUser, AdminUserDetail, ContactMessage } from "../../api/types.ts";
import { staffRoleOf } from "../../lib/staff.ts";
import { at, err, fakeFetch, makeMe, makeStaff, renderWithSession } from "../../test/helpers.tsx";
import { AdminCatalog, AdminStripe } from "./Admin.tsx";
import { AdminEmails } from "./Emails.tsx";
import { AdminInbox, replyHref } from "./Inbox.tsx";
import { AdminOrgDetail as OrgDetailPage } from "./OrgDetail.tsx";
import { AdminOverview } from "./Overview.tsx";
import { AdminUserDetail as UserDetailPage } from "./UserDetail.tsx";
import { AdminUsers } from "./Users.tsx";

beforeEach(() => at("/admin"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function adminUser(over: Partial<AdminUser> = {}): AdminUser {
  return { id: "usr_42", email: "producer@example.com", displayName: "Sam Ortega", emailVerified: false, staffRole: null, disabled: false, disabledReason: null, createdAt: "2026-10-02T09:00:00.000Z", lastLoginAt: "2026-10-26T09:00:00.000Z", orgCount: 1, bootstrapAdmin: false, ...over };
}

function userDetail(over: Partial<AdminUser> = {}, lockouts: AdminUserDetail["lockouts"] = []): AdminUserDetail {
  return {
    lockouts,
    user: adminUser(over),
    memberships: [{ orgId: "org_1", orgName: "Northside Broadcast", role: "member", planName: "Free" }],
    sessions: [{ id: "s1", createdAt: "2026-10-26T09:00:00.000Z", lastSeenAt: "2026-10-26T10:00:00.000Z", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36", ip: "203.0.113.9" }],
    audit: [{ at: "2026-10-26T09:00:00.000Z", action: "auth.login", orgId: null, detail: {} }],
  };
}

const reasonOf = (btn: HTMLElement) => document.getElementById(btn.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

describe("staffRoleOf", () => {
  it("reads the staff role, treating older servers' staff flag as admin", () => {
    expect(staffRoleOf({ staff: true, staffRole: "support" })).toBe("support");
    expect(staffRoleOf({ staff: true, staffRole: "admin" })).toBe("admin");
    expect(staffRoleOf({ staff: false, staffRole: null })).toBeNull();
    expect(staffRoleOf({ staff: true })).toBe("admin");
    expect(staffRoleOf(null)).toBeNull();
  });
});

describe("staff console navigation", () => {
  it("shows the console sections in the sidebar for staff", async () => {
    fakeFetch({ "GET /v1/admin/overview": { body: overview() }, "GET /v1/admin/messages": { body: { messages: [] } } });
    renderWithSession(<App />, makeStaff("support"));
    const nav = within(await screen.findByRole("navigation", { name: "Staff console" }));
    expect(nav.getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Users", "Organisations", "Support inbox", "Email log", "Catalogue", "Audit log", "Stripe events"]);
    expect(nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps customers out", () => {
    at("/admin/users");
    fakeFetch({});
    renderWithSession(<App />, makeMe());
    expect(screen.getByRole("heading", { name: "Staff only" })).toBeTruthy();
  });
});

function overview() {
  return {
    users: { total: 42, verified: 30, staff: 2, disabled: 1, newLast30Days: 12 },
    orgs: { total: 20, paying: 5, byPlan: { free: 15, pro: 4, studio: 1 } },
    devices: { linked: 9 },
    usage: { secondsThisMonth: 36_000 },
    revenue: { mrrCents: 34_500, currency: "usd" },
    recentSignups: [{ id: "usr_9", email: "new@example.com", displayName: "New Person", createdAt: "2026-10-26T09:00:00.000Z", emailVerified: false }],
  };
}

describe("overview", () => {
  it("shows stat cards, plan distribution and recent sign-ups", async () => {
    fakeFetch({ "GET /v1/admin/overview": { body: overview() }, "GET /v1/admin/messages": { body: { messages: [{ id: "1" }, { id: "2" }] } } });
    renderWithSession(<AdminOverview />, makeStaff("admin"));
    expect(await screen.findByText("$345")).toBeTruthy();
    expect(screen.getByText("10 h 00")).toBeTruthy();
    expect(screen.getByText("30 verified · 12 new in 30 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New Person" }).getAttribute("href")).toBe("/admin/users/usr_9");
    expect(screen.getByText("studio")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Open support messages").parentElement!.textContent).toContain("2"));
  });
});

describe("users list", () => {
  it("searches, filters and pages through users", async () => {
    at("/admin/users");
    const users = Array.from({ length: 25 }, (_, i) => adminUser({ id: `usr_${i}`, email: `u${i}@example.com`, displayName: `User ${i}` }));
    const f = fakeFetch({ "GET /v1/admin/users": (c) => ({ body: { users: c.url.includes("page=2") ? users.slice(0, 3) : users, total: 28, page: c.url.includes("page=2") ? 2 : 1, pageSize: 25 } }) });
    renderWithSession(<App />, makeStaff("support"));
    expect(await screen.findByText("Showing 1–25 of 28 users")).toBeTruthy();
    expect(f.calls.find((c) => c.url.startsWith("/v1/admin/users"))!.url).toBe("/v1/admin/users?filter=all&page=1&pageSize=25");

    fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "northside" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(f.calls.at(-1)!.url).toBe("/v1/admin/users?q=northside&filter=all&page=1&pageSize=25"));
    expect(window.location.search).toBe("?q=northside");

    fireEvent.click(screen.getByRole("button", { name: "Unverified" }));
    await waitFor(() => expect(f.calls.at(-1)!.url).toBe("/v1/admin/users?q=northside&filter=unverified&page=1&pageSize=25"));
    expect(screen.getByRole("button", { name: "Unverified" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(await screen.findByRole("button", { name: /Next/ }));
    await waitFor(() => expect(f.calls.at(-1)!.url).toContain("page=2"));
    expect(await screen.findByText("Showing 26–28 of 28 users")).toBeTruthy();
  });

  it("shows an empty state", async () => {
    at("/admin/users?filter=disabled");
    fakeFetch({ "GET /v1/admin/users": { body: { users: [], total: 0, page: 1, pageSize: 25 } } });
    renderWithSession(<AdminUsers />, makeStaff("admin"));
    expect(await screen.findByText("No users match")).toBeTruthy();
  });
});

describe("user detail: support role", () => {
  it("offers support actions but hides admin-only actions, saying why", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    expect(await screen.findByRole("heading", { name: "Sam Ortega" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify email" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resend verification" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send password reset" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
    expect(screen.queryByLabelText("Staff role")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit account" })).toBeNull();
    expect(screen.getByText("Admin staff only")).toBeTruthy();
    expect(screen.getByText(/Needs the admin staff role \(your role: support\)/)).toBeTruthy();
    expect(screen.getByText("Chrome 142 on Windows")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Northside Broadcast" }).getAttribute("href")).toBe("/admin/orgs/org_1");
  });

  it("sends a password reset after confirming", async () => {
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "POST /v1/admin/users/usr_42/password-reset": { body: { sent: true } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    fireEvent.click(await screen.findByRole("button", { name: "Send password reset" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("Password reset link sent to producer@example.com.")).toBeTruthy();
    expect(f.count("POST", "/v1/admin/users/usr_42/password-reset")).toBe(1);
  });

  it("signs a user out everywhere and reports how many sessions ended", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "POST /v1/admin/users/usr_42/sign-out": { body: { revoked: 3 } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out everywhere" }));
    expect(await screen.findByText("Signed out 3 sessions.")).toBeTruthy();
  });

  it("shows a sign-in lockout and clears it after confirming", async () => {
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail({}, [{ label: "Sign-in attempts with this email address", until: "2026-10-26T09:01:00.000Z" }]) }, "POST /v1/admin/users/usr_42/clear-lockout": { body: { cleared: 1 } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    expect(await screen.findByText("Locked out after too many attempts")).toBeTruthy();
    expect(screen.getByText(/Sign-in attempts with this email address: until/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear lockout" }));
    const dialog = screen.getByRole("dialog", { name: "Clear the lockout?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear lockout" }));
    expect(await screen.findByText("Cleared 1 lockout.")).toBeTruthy();
    expect(f.calls.some((c) => c.method === "POST" && c.url === "/v1/admin/users/usr_42/clear-lockout")).toBe(true);
  });

  it("explains why there's no lockout to clear", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    const btn = await screen.findByRole("button", { name: "Clear lockout" });
    expect(reasonOf(btn)).toBe("This account isn't locked out right now.");
    expect(screen.queryByText("Locked out after too many attempts")).toBeNull();
  });

  it("keeps the dialog open and shows the server's reason on failure", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "POST /v1/admin/users/usr_42/verify-email": err(403, "forbidden", "staff role required") });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("support"));
    fireEvent.click(await screen.findByRole("button", { name: "Verify email" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Verify email" }));
    expect(await within(screen.getByRole("dialog")).findByText("Not allowed: Staff role required.")).toBeTruthy();
  });
});

describe("user detail: admin role", () => {
  it("disables an account only with a reason", async () => {
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "POST /v1/admin/users/usr_42/disable": { body: { ok: true } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Disable account" }));
    const dialog = screen.getByRole("dialog", { name: "Disable Sam Ortega?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable account" }));
    expect(await within(dialog).findByText("Give a reason of at least 3 characters.")).toBeTruthy();
    expect(f.count("POST", "/v1/admin/users/usr_42/disable")).toBe(0);
    fireEvent.change(within(dialog).getByLabelText("Reason (recorded in the audit log)"), { target: { value: "Chargeback fraud, ticket 88" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable account" }));
    expect(await screen.findByText("Account disabled and signed out.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ reason: "Chargeback fraud, ticket 88" });
  });

  it("sets a staff role after confirming", async () => {
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "PUT /v1/admin/users/usr_42/staff-role": { body: { ok: true, staffRole: "support" } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("admin"));
    const save = (await screen.findByRole("button", { name: "Save staff role" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Staff role"), { target: { value: "support" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save staff role" }));
    expect(await screen.findByText("Staff role set to support.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "PUT")!.body).toEqual({ role: "support" });
  });

  it("can't change its own role or disable itself, and says why", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_staff": { body: userDetail({ id: "usr_staff", staffRole: "admin", emailVerified: true }) } });
    renderWithSession(<UserDetailPage userId="usr_staff" />, makeStaff("admin"));
    const save = await screen.findByRole("button", { name: "Save staff role" });
    expect(reasonOf(save)).toBe("You can't change your own staff role.");
    expect((screen.getByLabelText("Staff role") as HTMLSelectElement).disabled).toBe(true);
    expect(reasonOf(screen.getByRole("button", { name: "Disable account" }))).toBe("You can't disable your own account.");
  });

  it("explains that bootstrap admins can't be demoted or disabled", async () => {
    fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail({ staffRole: "admin", bootstrapAdmin: true }) } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("admin"));
    const save = await screen.findByRole("button", { name: "Save staff role" });
    expect(reasonOf(save)).toMatch(/MF_STAFF_EMAILS/);
    expect(reasonOf(screen.getByRole("button", { name: "Disable account" }))).toMatch(/always an admin/);
    expect(screen.getByText("Bootstrap")).toBeTruthy();
  });

  it("enables a disabled account and shows the reason it was disabled", async () => {
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail({ disabled: true, disabledReason: "Spam invitations" }) }, "POST /v1/admin/users/usr_42/enable": { body: { ok: true } } });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("admin"));
    expect(await screen.findByText(/Reason: Spam invitations/)).toBeTruthy();
    expect(reasonOf(screen.getByRole("button", { name: "Send password reset" }))).toBe("Enable the account first.");
    fireEvent.click(screen.getByRole("button", { name: "Enable account" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Enable account" }));
    expect(await screen.findByText("Account enabled.")).toBeTruthy();
    expect(f.count("POST", "/v1/admin/users/usr_42/enable")).toBe(1);
  });

  it("edits the email and reports an address already in use", async () => {
    let n = 0;
    const f = fakeFetch({ "GET /v1/admin/users/usr_42": { body: userDetail() }, "PATCH /v1/admin/users/usr_42": () => (++n === 1 ? err(409, "email_taken", "another account already uses this email address") : { body: { ok: true } }) });
    renderWithSession(<UserDetailPage userId="usr_42" />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit account" }));
    const dialog = screen.getByRole("dialog", { name: "Edit account" });
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "sam@studio.example" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("Another account uses this address.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved. A verification email was sent to sam@studio.example.")).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ email: "sam@studio.example" });
  });
});

function orgDetail(over: Partial<AdminOrgDetail> = {}): AdminOrgDetail {
  return {
    org: { id: "org_1", name: "Northside Broadcast", createdAt: "2026-10-01T00:00:00.000Z", stripeCustomerId: null },
    plan: { id: "free", name: "Free" },
    subscription: { status: "none", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", cancelAtPeriodEnd: false, override: null, stripe: null },
    limits: { maxDevices: 1, maxMembers: 2 },
    allowance: { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", includedSeconds: 7200, creditSeconds: 0, usedSeconds: 3600, remainingSeconds: 3600 },
    usageResets: [],
    members: [{ userId: "usr_1", email: "owner@example.com", displayName: "Riley Park", role: "owner" }],
    devices: [{ id: "dev_1", name: "OBSERVER-01", platform: "win32", appVersion: "0.1.0", linkedAt: "2026-10-02T00:00:00.000Z", lastSeenAt: null, revokedAt: null }],
    credits: [{ id: "c1", seconds: 18000, remainingSeconds: 18000, source: "grant", note: "Launch credit", expiresAt: null, createdAt: "2026-10-03T00:00:00.000Z" }],
    ...over,
  };
}

const PRO_PLAN = { id: "pro", name: "Pro", description: "", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: false, maxDevices: 2, maxMembers: 5 }, stripePriceId: null, public: true, sortOrder: 1 };

describe("organisation detail", () => {
  it("admins grant hours from a dialog", async () => {
    const f = fakeFetch({ "GET /v1/admin/orgs/org_1": { body: orgDetail() }, "GET /v1/admin/audit": { body: [] }, "POST /v1/admin/orgs/org_1/credits": { body: { id: "c2" } } });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("admin"));
    expect(await screen.findByRole("heading", { name: "Northside Broadcast" })).toBeTruthy();
    expect(screen.getByText("OBSERVER-01")).toBeTruthy();
    expect(screen.getByText("Launch credit")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Grant hours" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Grant hours to Northside Broadcast" });
    fireEvent.change(within(dialog).getByLabelText("Hours"), { target: { value: "5" } });
    fireEvent.change(within(dialog).getByLabelText("Note (shown to the organisation)"), { target: { value: "Support credit, ticket 12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant hours" }));
    expect(await screen.findByText("Granted 5 h to Northside Broadcast.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ hours: 5, note: "Support credit, ticket 12", expiresAt: null });
  });

  it("admins set a subscription status and plan by hand", async () => {
    const f = fakeFetch({
      "GET /v1/admin/orgs/org_1": { body: orgDetail() },
      "GET /v1/admin/audit": { body: [] },
      "GET /v1/admin/catalog": { body: { plans: [PRO_PLAN], hourPacks: [] } },
      "PUT /v1/admin/orgs/org_1/subscription-override": { body: { planId: "pro", status: "active" } },
    });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Change status" }));
    const dialog = screen.getByRole("dialog", { name: "Change Northside Broadcast's subscription status" });
    expect(within(dialog).queryByLabelText("Plan")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "active" } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "Pro" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save status" }));
    expect(await within(dialog).findByText("Choose the plan they get.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Plan"), { target: { value: "pro" } });
    fireEvent.change(within(dialog).getByLabelText("Reason (recorded in the audit log)"), { target: { value: "Partner league" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Northside Broadcast is now active on Pro.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "PUT")!.body).toEqual({ status: "active", planId: "pro", note: "Partner league" });
  });

  it("shows a staff override with what Stripe reports, and removes it", async () => {
    const overridden = orgDetail({
      plan: { id: "pro", name: "Pro" },
      subscription: { status: "active", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", cancelAtPeriodEnd: false, override: { planId: "pro", status: "active", note: "Partner league", createdBy: "admin@example.com", createdAt: "2026-10-20T09:00:00.000Z" }, stripe: { planId: "studio", status: "canceled" } },
    });
    const f = fakeFetch({ "GET /v1/admin/orgs/org_1": { body: overridden }, "GET /v1/admin/audit": { body: [] }, "DELETE /v1/admin/orgs/org_1/subscription-override": { body: { planId: "free", status: "canceled" } } });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("admin"));
    expect(await screen.findByText(/Reason: Partner league/)).toBeTruthy();
    expect(screen.getAllByText("Set by staff").length).toBeGreaterThan(0);
    expect(screen.getByText("Cancelled · studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove override" }));
    const dialog = screen.getByRole("dialog", { name: "Remove the override?" });
    expect(within(dialog).getByText(/Stripe's status applies again: cancelled \(studio\)/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove override" }));
    expect(await screen.findByText("Override removed; Stripe's status applies again.")).toBeTruthy();
    expect(f.calls.some((c) => c.method === "DELETE" && c.url === "/v1/admin/orgs/org_1/subscription-override")).toBe(true);
  });

  it("admins reset this period's usage with a reason", async () => {
    const f = fakeFetch({ "GET /v1/admin/orgs/org_1": { body: orgDetail() }, "GET /v1/admin/audit": { body: [] }, "POST /v1/admin/orgs/org_1/usage-reset": { body: { seconds: 3600 } } });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Reset usage" }));
    const dialog = screen.getByRole("dialog", { name: "Reset Northside Broadcast's usage this period?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset usage" }));
    expect(await within(dialog).findByText("Give a reason of at least 3 characters.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Reason (recorded in the audit log)"), { target: { value: "Outage refund" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset usage" }));
    expect(await screen.findByText("Usage reset to zero for this period.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ note: "Outage refund" });
  });

  it("staff sign one computer or all of them out to clear the computer limit", async () => {
    const f = fakeFetch({ "GET /v1/admin/orgs/org_1": { body: orgDetail() }, "GET /v1/admin/audit": { body: [] }, "POST /v1/admin/orgs/org_1/devices/dev_1/sign-out": { body: { computers: 1 } }, "POST /v1/admin/orgs/org_1/devices/sign-out-all": { body: { computers: 1 } } });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("support"));
    expect(await screen.findByText("Computers (1 of 1 signed in)")).toBeTruthy();
    expect(screen.getByText(/At the Free plan's limit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sign out OBSERVER-01?" })).getByRole("button", { name: "Sign out computer" }));
    expect(await screen.findByText("OBSERVER-01 signed out.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out all" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sign out all of Northside Broadcast's computers?" })).getByRole("button", { name: "Sign out all" }));
    expect(await screen.findByText("Signed out 1 computer.")).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/v1/admin/orgs/org_1/devices/dev_1/sign-out", "/v1/admin/orgs/org_1/devices/sign-out-all"]);
  });

  it("support sees the organisation without the grant action", async () => {
    fakeFetch({ "GET /v1/admin/orgs/org_1": { body: orgDetail() }, "GET /v1/admin/audit": { body: [] } });
    renderWithSession(<OrgDetailPage orgId="org_1" />, makeStaff("support"));
    expect(await screen.findByRole("heading", { name: "Northside Broadcast" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Grant hours" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset usage" })).toBeNull();
    expect(screen.getByText(/Granting hours is hidden/)).toBeTruthy();
    expect(screen.getByText(/Changing the subscription status is hidden/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open as staff (read-only)" }).getAttribute("href")).toBe("/orgs/org_1");
  });
});

const message = (over: Partial<ContactMessage> = {}): ContactMessage => ({ id: "7", name: "Jo Rivera", email: "jo@example.com", topic: "billing", message: "Can I get an invoice with our VAT number?\nThanks", orgId: "org_1", userId: null, createdAt: "2026-10-26T09:00:00.000Z", handledAt: null, handledBy: null, ...over });

describe("support inbox", () => {
  it("filters, replies by email and marks messages handled", async () => {
    const f = fakeFetch({ "GET /v1/admin/messages": (c) => ({ body: { messages: c.url.includes("status=handled") ? [] : [message()] } }), "POST /v1/admin/messages/7/handled": { body: { ok: true } } });
    renderWithSession(<AdminInbox />, makeStaff("support"));
    expect(await screen.findByText(/Can I get an invoice/)).toBeTruthy();
    const reply = screen.getByRole("link", { name: "Reply by email" }).getAttribute("href")!;
    expect(reply.startsWith("mailto:jo%40example.com?subject=")).toBe(true);
    expect(decodeURIComponent(reply)).toContain("> Can I get an invoice with our VAT number?");
    fireEvent.click(screen.getByRole("button", { name: "Mark handled" }));
    expect(await screen.findByText("Message #7 marked handled.")).toBeTruthy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ handled: true });
    fireEvent.click(screen.getByRole("button", { name: "Handled" }));
    expect(await screen.findByText("No messages here")).toBeTruthy();
    expect(f.calls.some((c) => c.url === "/v1/admin/messages?status=handled")).toBe(true);
  });

  it("replyHref quotes the message", () => {
    const href = replyHref(message({ topic: "sales" }));
    expect(decodeURIComponent(href)).toContain("Re: your Matchframe sales enquiry");
  });
});

describe("email log", () => {
  const emails = { emails: [{ id: "11", to: "owner@example.com", subject: "Confirm your email address", createdAt: "2026-10-26T09:00:00.000Z", sentAt: null, error: null }], delivery: "outbox" };

  it("hides resending from support and explains outbox delivery", async () => {
    fakeFetch({ "GET /v1/admin/emails": { body: emails } });
    renderWithSession(<AdminEmails />, makeStaff("support"));
    expect(await screen.findByText("Confirm your email address")).toBeTruthy();
    expect(screen.getByText("Email delivery isn't configured")).toBeTruthy();
    expect(screen.getByText("Logged only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Resend/ })).toBeNull();
    expect(screen.getByText(/Resending emails is hidden/)).toBeTruthy();
  });

  it("admins resend; without SMTP the server's message is shown, not a failure", async () => {
    fakeFetch({ "GET /v1/admin/emails": { body: emails }, "POST /v1/admin/emails/11/resend": { body: { sent: false, error: "email delivery is not configured (SMTP_URL is not set)" } } });
    renderWithSession(<AdminEmails />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Resend to owner@example.com" }));
    const toast = await screen.findByText("Not resent: email delivery is not configured (SMTP_URL is not set)");
    expect(toast.closest(".toast")!.className).toContain("toast-info");
  });

  it("filters by recipient", async () => {
    fakeFetch({ "GET /v1/admin/emails": { body: { emails: [...emails.emails, { ...emails.emails[0]!, id: "12", to: "other@example.com", subject: "Reset your password" }], delivery: "smtp" } } });
    renderWithSession(<AdminEmails />, makeStaff("admin"));
    await screen.findByText("Reset your password");
    fireEvent.change(screen.getByLabelText("Filter by recipient or subject"), { target: { value: "other@" } });
    expect(screen.queryByText("Confirm your email address")).toBeNull();
    expect(screen.getByText("Reset your password")).toBeTruthy();
  });
});

describe("admin-only sections for support", () => {
  it("the catalogue is read-only", async () => {
    fakeFetch({ "GET /v1/admin/catalog": { body: { plans: [{ id: "pro", name: "Pro", description: "", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: false, maxDevices: 2, maxMembers: 5 }, stripePriceId: null, public: true, sortOrder: 1 }], hourPacks: [] } } });
    renderWithSession(<AdminCatalog />, makeStaff("support"));
    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
    expect(screen.getByText(/creating and editing plans and hour packs is hidden/)).toBeTruthy();
  });

  it("Stripe events aren't even requested", () => {
    const f = fakeFetch({});
    renderWithSession(<AdminStripe />, makeStaff("support"));
    expect(screen.getByText(/only shown to admins/)).toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });

  it("admins can edit the catalogue", async () => {
    fakeFetch({ "GET /v1/admin/catalog": { body: { plans: [{ id: "pro", name: "Pro", description: "", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: false, maxDevices: 2, maxMembers: 5 }, stripePriceId: null, public: true, sortOrder: 1 }], hourPacks: [] } } });
    renderWithSession(<AdminCatalog />, makeStaff("admin"));
    expect(await screen.findByRole("button", { name: "Edit Pro" })).toBeTruthy();
  });

  it("admins can turn on Full Action Observer for a plan", async () => {
    const pro = { id: "pro", name: "Pro", description: "", priceMonthlyCents: 4900, currency: "usd", includedAutoDirectorHours: 40, features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: false, maxDevices: 2, maxMembers: 5 }, stripePriceId: null, public: true, sortOrder: 1 };
    const f = fakeFetch({ "GET /v1/admin/catalog": { body: { plans: [pro], hourPacks: [] } }, "PUT /v1/admin/plans/pro": (c) => ({ body: c.body }) });
    renderWithSession(<AdminCatalog />, makeStaff("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Pro" }));
    const box = screen.getByRole("checkbox", { name: "Full Action Observer (nade cameras)" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/Plan “Pro” saved/)).toBeTruthy();
    const body = f.calls.find((c) => c.method === "PUT")!.body as { features: Record<string, unknown> };
    expect(body.features).toEqual({ ...pro.features, fullActionObserver: true });
  });

  it("shows Full Action Observer on the plans that have it", async () => {
    const studio = { id: "studio", name: "Studio", description: "", priceMonthlyCents: 14900, currency: "usd", includedAutoDirectorHours: 150, features: { autoDirector: true, learnedDirectorShadow: true, fullActionObserver: true, maxDevices: 6, maxMembers: 20 }, stripePriceId: null, public: true, sortOrder: 2 };
    fakeFetch({ "GET /v1/admin/catalog": { body: { plans: [studio], hourPacks: [] } } });
    renderWithSession(<AdminCatalog />, makeStaff("admin"));
    expect(await screen.findByText(/6 computers · 20 members · shadow · Full Action Observer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Studio" }));
    expect((screen.getByRole("checkbox", { name: "Full Action Observer (nade cameras)" }) as HTMLInputElement).checked).toBe(true);
  });
});
