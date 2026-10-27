// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { fileSaver } from "../lib/download.ts";
import { describeUserAgent } from "../lib/useragent.ts";
import { err, fakeFetch, makeMe, renderWithSession } from "../test/helpers.tsx";
import { DataExportCard, SessionsCard } from "./AccountSessions.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

const sessions = [
  { id: "a1b2c3d4e5f6a1b2c3d4e5f6", current: true, createdAt: "2026-10-20T10:00:00.000Z", lastSeenAt: "2026-10-27T09:00:00.000Z", userAgent: CHROME_WIN, ip: "203.0.113.5" },
  { id: "b1b2c3d4e5f6a1b2c3d4e5f6", current: false, createdAt: "2026-10-10T10:00:00.000Z", lastSeenAt: "2026-10-26T09:00:00.000Z", userAgent: SAFARI_IOS, ip: "198.51.100.7" },
  { id: "c1b2c3d4e5f6a1b2c3d4e5f6", current: false, createdAt: "2026-10-01T10:00:00.000Z", lastSeenAt: null, userAgent: FIREFOX_LINUX, ip: null },
];

describe("describeUserAgent", () => {
  it("names common browsers and systems", () => {
    expect(describeUserAgent(CHROME_WIN).label).toBe("Chrome 142 on Windows");
    expect(describeUserAgent(SAFARI_IOS).label).toBe("Safari 18 on iOS");
    expect(describeUserAgent(FIREFOX_LINUX).label).toBe("Firefox 140 on Linux");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/142.0 Safari/537.36 Edg/142.0").label).toBe("Edge 142 on Windows");
    expect(describeUserAgent(null).label).toBe("Unknown device");
  });
});

describe("active sessions", () => {
  it("lists sessions with device, IP and a This device badge; the current one can't be revoked here", async () => {
    fakeFetch({ "GET /v1/auth/sessions": { body: { sessions } } });
    renderWithSession(<SessionsCard />, makeMe());
    const current = (await screen.findByText(/Chrome 142 on Windows/)).closest("li")!;
    expect(within(current).getByText("This device")).toBeTruthy();
    expect(within(current).queryByRole("button")).toBeNull();
    expect(screen.getByText(/198\.51\.100\.7/)).toBeTruthy();
    expect(screen.getByText(/Unknown IP address/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out Safari 18 on iOS" })).toBeTruthy();
  });

  it("revokes one session after confirming", async () => {
    let list = sessions;
    const f = fakeFetch({
      "GET /v1/auth/sessions": () => ({ body: { sessions: list } }),
      "DELETE /v1/auth/sessions/b1b2c3d4e5f6a1b2c3d4e5f6": () => {
        list = sessions.filter((s) => s.id !== "b1b2c3d4e5f6a1b2c3d4e5f6");
        return { body: { ok: true } };
      },
    });
    renderWithSession(<SessionsCard />, makeMe());
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Safari 18 on iOS" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out this session?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out session" }));
    expect(await screen.findByText("Signed out Safari 18 on iOS.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Safari 18 on iOS/, { selector: ".session-device" })).toBeNull());
    expect(f.count("DELETE", "/v1/auth/sessions/b1b2c3d4e5f6a1b2c3d4e5f6")).toBe(1);
  });

  it("signs out all other sessions", async () => {
    const f = fakeFetch({ "GET /v1/auth/sessions": { body: { sessions } }, "POST /v1/auth/sessions/revoke-others": { body: { revoked: 2 } } });
    renderWithSession(<SessionsCard />, makeMe());
    await screen.findByText(/Chrome 142 on Windows/);
    fireEvent.click(screen.getByRole("button", { name: "Sign out all other sessions" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/2 other sessions will be signed out/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out others" }));
    expect(await screen.findByText("Signed out 2 other sessions.")).toBeTruthy();
    expect(f.count("POST", "/v1/auth/sessions/revoke-others")).toBe(1);
  });

  it("disables 'sign out all other sessions' with a reason when there are none", async () => {
    fakeFetch({ "GET /v1/auth/sessions": { body: { sessions: [sessions[0]] } } });
    renderWithSession(<SessionsCard />, makeMe());
    await screen.findByText(/Chrome 142 on Windows/);
    const btn = screen.getByRole("button", { name: "Sign out all other sessions" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.getElementById(btn.getAttribute("aria-describedby")!)!.textContent).toBe("No other sessions are signed in.");
  });

  it("shows a retryable error when sessions can't load", async () => {
    fakeFetch({ "GET /v1/auth/sessions": err(500, "internal", "boom") });
    renderWithSession(<SessionsCard />, makeMe());
    expect(await screen.findByText("Couldn't load your sessions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("download my data", () => {
  it("fetches the export and saves it as a dated JSON file", async () => {
    const save = vi.spyOn(fileSaver, "saveJson").mockImplementation(() => undefined);
    const data = { user: { email: "owner@example.com" }, memberships: [] };
    fakeFetch({ "GET /v1/auth/export": { body: data } });
    renderWithSession(<DataExportCard />, makeMe());
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatch(/^matchframe-account-\d{4}-\d{2}-\d{2}\.json$/);
    expect(save.mock.calls[0]![1]).toEqual(data);
    expect(await screen.findByText("Your data was downloaded.")).toBeTruthy();
  });
});
