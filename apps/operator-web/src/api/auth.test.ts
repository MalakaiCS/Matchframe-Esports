// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { captureTokenFromUrl, getOperatorToken, OPERATOR_TOKEN_KEY, resolveOperatorToken, setOperatorToken } from "./auth.ts";

afterEach(() => {
  setOperatorToken(null);
  delete window.matchframe;
  window.history.replaceState(null, "", "/");
});

describe("operator token handling", () => {
  it("reads ?token= once, stores it for the session and strips it from the address bar", () => {
    window.history.replaceState(null, "", "/live?token=abc123&view=1#x");
    expect(captureTokenFromUrl(OPERATOR_TOKEN_KEY)).toBe("abc123");
    expect(window.location.search).toBe("?view=1");
    expect(window.location.pathname + window.location.hash).toBe("/live#x");
    expect(window.sessionStorage.getItem(OPERATOR_TOKEN_KEY)).toBe("abc123");
  });

  it("prefers the Electron preload bridge over a stale session token", async () => {
    window.sessionStorage.setItem(OPERATOR_TOKEN_KEY, "stale");
    window.matchframe = { getOperatorToken: async () => "from-bridge" };
    await expect(resolveOperatorToken()).resolves.toBe("from-bridge");
    expect(getOperatorToken()).toBe("from-bridge");
  });

  it("falls back to session storage without URL or bridge", async () => {
    window.sessionStorage.setItem(OPERATOR_TOKEN_KEY, "saved");
    await expect(resolveOperatorToken()).resolves.toBe("saved");
  });
});
