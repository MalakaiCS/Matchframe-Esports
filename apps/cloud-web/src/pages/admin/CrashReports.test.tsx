// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../App.tsx";
import type { AdminCrashReport, AdminCrashReportDetail as Detail } from "../../api/types.ts";
import { at, err, fakeFetch, makeMe, makeStaff, renderWithSession } from "../../test/helpers.tsx";
import { AdminCrashReportDetail, AdminCrashReports } from "./CrashReports.tsx";

beforeEach(() => at("/admin/crash-reports"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function report(over: Partial<AdminCrashReport> = {}): AdminCrashReport {
  return {
    id: "CR-BCDF-GHJK",
    receivedAt: "2026-11-17T09:00:00.000Z",
    occurredAt: "2026-11-17T08:59:55.000Z",
    expiresAt: "2027-02-15T09:00:00.000Z",
    appVersion: "0.12.4",
    os: "win32 10.0.22631",
    process: "engine",
    reason: "exit code 3",
    error: "TypeError: cannot read properties of undefined",
    orgId: "org_1",
    orgName: "Northside Broadcast",
    deviceId: "dev_1",
    deviceName: "Production PC",
    sizeBytes: 420_000,
    storedBytes: 61_000,
    hasSupportFile: true,
    hasMinidump: false,
    ...over,
  };
}

const list = (reports: AdminCrashReport[], total = reports.length) => ({ body: { reports, total, page: 1, pageSize: 25, storedBytes: 1_572_864 } });

describe("staff crash reports list", () => {
  it("lists reports with version, process and organisation, and searches and filters through the server", async () => {
    const anonymous = report({ id: "CR-LMNP-QRST", process: "hud", reason: "oom", error: "The desktop HUD window's renderer process ran out of memory (oom, exit code 0).", orgId: null, orgName: null, deviceId: null, deviceName: null });
    const f = fakeFetch({ "GET /v1/admin/crash-reports": (c) => (c.url.includes("process=hud") ? list([anonymous]) : list([report(), anonymous])) });
    renderWithSession(<App />, makeStaff("support"));
    expect(await screen.findByRole("heading", { name: "Crash reports" })).toBeTruthy();
    const rows = within(await screen.findByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByRole("link", { name: "CR-BCDF-GHJK" }).getAttribute("href")).toBe("/admin/crash-reports/CR-BCDF-GHJK");
    expect(first.getByText("0.12.4")).toBeTruthy();
    expect(first.getByText("Engine")).toBeTruthy();
    expect(first.getByText("exit code 3")).toBeTruthy();
    expect(first.getByRole("link", { name: "Northside Broadcast" }).getAttribute("href")).toBe("/admin/orgs/org_1");
    expect(first.getByText("Production PC")).toBeTruthy();
    expect(within(rows[1]!).getByText("HUD window")).toBeTruthy();
    expect(within(rows[1]!).getByText("Not signed in")).toBeTruthy();
    expect(screen.getByText("1.5 MB of crash reports stored.")).toBeTruthy();
    expect(f.calls.at(-1)!.url).toBe("/v1/admin/crash-reports?page=1&pageSize=25");

    fireEvent.change(screen.getByLabelText("Search crash reports"), { target: { value: "northside" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(f.calls.at(-1)!.url).toBe("/v1/admin/crash-reports?q=northside&page=1&pageSize=25"));
    expect(window.location.search).toBe("?q=northside");

    fireEvent.click(screen.getByRole("button", { name: "HUD window" }));
    await waitFor(() => expect(f.calls.at(-1)!.url).toBe("/v1/admin/crash-reports?q=northside&process=hud&page=1&pageSize=25"));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
  });

  it("says when there are none", async () => {
    fakeFetch({ "GET /v1/admin/crash-reports": list([]) });
    renderWithSession(<AdminCrashReports />, makeStaff("admin"));
    expect(await screen.findByText("No crash reports")).toBeTruthy();
  });

  it("keeps customers out", () => {
    fakeFetch({});
    renderWithSession(<App />, makeMe());
    expect(screen.getByRole("heading", { name: "Staff only" })).toBeTruthy();
  });
});

describe("staff crash report detail", () => {
  const detail = (over: Partial<Detail> = {}): Detail => ({
    report: report({ hasMinidump: true }),
    crash: {
      reportId: "abcdefghijklmnopqrstuv",
      occurredAt: "2026-11-17T08:59:55.000Z",
      appVersion: "0.12.4",
      os: { platform: "win32", release: "10.0.22631", arch: "x64" },
      process: "engine",
      reason: "exit code 3",
      error: "TypeError: cannot read properties of undefined",
      stack: "TypeError: cannot read properties of undefined\n    at tick (engine.mjs:10:5)",
      uptimeSeconds: 3600,
      programUptimeSeconds: 3700,
      detail: { exitCode: 3, signal: null, engineOutput: ['{"level":"info","msg":"engine started"}', "last line"] },
    },
    supportFile: { included: true, generatedAt: "2026-11-17T09:00:05.000Z", sections: ["generatedAt", "app", "health", "logs"] },
    minidump: { name: "a1b2.dmp", size: 900_000 },
    ...over,
  });

  it("shows what crashed, the engine's last output and the support file, with downloads", async () => {
    at("/admin/crash-reports/CR-BCDF-GHJK");
    fakeFetch({ "GET /v1/admin/crash-reports/CR-BCDF-GHJK": { body: detail() } });
    renderWithSession(<AdminCrashReportDetail reportId="CR-BCDF-GHJK" />, makeStaff("support"));
    expect(await screen.findByRole("heading", { name: "CR-BCDF-GHJK" })).toBeTruthy();
    expect(screen.getAllByText("TypeError: cannot read properties of undefined").length).toBeGreaterThan(0);
    expect(screen.getByText(/at tick \(engine\.mjs:10:5\)/)).toBeTruthy();
    expect(screen.getByText(/last line/)).toBeTruthy();
    expect(screen.getByText("3600 s")).toBeTruthy();
    expect(screen.getByText("win32 10.0.22631 (x64)")).toBeTruthy();
    expect(screen.getByText("generatedAt, app, health, logs")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Northside Broadcast" }).getAttribute("href")).toBe("/admin/orgs/org_1");
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toBe("/v1/admin/crash-reports/CR-BCDF-GHJK/download");
    expect(screen.getByRole("link", { name: "Download minidump" }).getAttribute("href")).toBe("/v1/admin/crash-reports/CR-BCDF-GHJK/minidump");
    expect(screen.getByRole("link", { name: "← Crash reports" }).getAttribute("href")).toBe("/admin/crash-reports");
  });

  it("without a support file or minidump, says so", async () => {
    fakeFetch({ "GET /v1/admin/crash-reports/CR-BCDF-GHJK": { body: detail({ supportFile: { included: false, generatedAt: null, sections: [] }, minidump: null, report: report({ hasSupportFile: false }) }) } });
    renderWithSession(<AdminCrashReportDetail reportId="CR-BCDF-GHJK" />, makeStaff("admin"));
    expect((await screen.findAllByText("No support file")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Download minidump" })).toBeNull();
  });

  it("explains a report that is gone", async () => {
    fakeFetch({ "GET /v1/admin/crash-reports/CR-NONE-NONE": err(404, "not_found", "crash report not found (reports are deleted 90 days after they arrive)") });
    renderWithSession(<AdminCrashReportDetail reportId="CR-NONE-NONE" />, makeStaff("admin"));
    expect(await screen.findByText("Couldn't load this crash report")).toBeTruthy();
    expect(screen.getByText(/deleted 90 days after they arrive/)).toBeTruthy();
  });
});
