// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { at, err, fakeFetch, renderWithSession } from "../../test/helpers.tsx";
import { Login } from "./Login.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign in", () => {
  it("explains a disabled account", async () => {
    at("/login");
    fakeFetch({ "POST /v1/auth/login": err(403, "account_disabled", "this account has been disabled; contact Matchframe support") });
    renderWithSession(<Login />, null);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("This account has been disabled; contact Matchframe support.")).toBeTruthy();
  });
});
