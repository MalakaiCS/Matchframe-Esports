// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { at, err, fakeFetch, makeMe, renderWithSession } from "../test/helpers.tsx";
import { Account } from "./Account.tsx";

const downloads = { body: { windows: null, notesUrl: null, version: "0.1.0" } };

beforeEach(() => at("/account"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account management", () => {
  it("renames the account and refreshes the session; shows the plan name for each organisation", async () => {
    const renamed = makeMe({ user: { displayName: "Riley Morgan" } });
    const f = fakeFetch({ "GET /v1/downloads": downloads, "PATCH /v1/auth/me": { body: { ok: true, displayName: "Riley Morgan" } }, "GET /v1/auth/me": { body: renamed } });
    renderWithSession(<Account />, makeMe());
    expect(screen.getByText(/Owner · Free plan/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Riley Morgan" } });
    fireEvent.click(save);
    await waitFor(() => expect(f.count("GET", "/v1/auth/me")).toBe(1));
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ displayName: "Riley Morgan" });
  });

  it("changes the email address only after confirmation from the new address; explains a wrong password", async () => {
    let attempt = 0;
    const f = fakeFetch({
      "GET /v1/downloads": downloads,
      "POST /v1/auth/change-email": () => (++attempt === 1 ? err(400, "invalid_credentials", "password is incorrect") : { body: { sent: true } }),
    });
    renderWithSession(<Account />, makeMe());
    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByText("That is already your email address.")).toBeTruthy();
    expect(f.count("POST", "/v1/auth/change-email")).toBe(0);

    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "riley@studio.example" } });
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "not my password" } });
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByText("This isn't your password.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByText(/We sent a confirmation link to riley@studio.example/)).toBeTruthy();
    expect(f.calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ newEmail: "riley@studio.example", password: "correct horse battery" });
  });
});
