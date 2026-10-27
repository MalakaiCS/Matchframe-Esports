// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, describeError, fieldErrors, NetworkError, sentence } from "./client.ts";

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>, onUnauthenticated?: () => void) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  return { fetchImpl, api: createClient({ fetchImpl: () => fetchImpl as unknown as typeof fetch, onUnauthenticated }) };
}

afterEach(() => vi.restoreAllMocks());

describe("request", () => {
  it("calls relative /v1 URLs with the session cookie and a JSON body", async () => {
    const { api, fetchImpl } = clientWith(() => json(200, { url: "https://checkout.stripe.com/c/x" }));
    await expect(api.post("/v1/orgs/org_1/billing/checkout", { kind: "subscription", planId: "pro" })).resolves.toEqual({ url: "https://checkout.stripe.com/c/x" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/v1/orgs/org_1/billing/checkout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"kind":"subscription","planId":"pro"}');
  });

  it("sends no body or content type on GET", async () => {
    const { api, fetchImpl } = clientWith(() => json(200, []));
    await api.get("/v1/orgs/org_1/devices");
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.body).toBeNull();
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("refuses absolute or non-API URLs (mutations from other origins are refused by the API anyway)", async () => {
    const { api, fetchImpl } = clientWith(() => json(200, {}));
    await expect(api.get("https://evil.example/v1/auth/me")).rejects.toThrow(/relative \/v1\//);
    await expect(api.get("/api/x")).rejects.toThrow(/relative \/v1\//);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns undefined for 204 and empty bodies", async () => {
    const { api } = clientWith(() => new Response(null, { status: 204 }));
    await expect(api.del("/v1/orgs/o/devices/d")).resolves.toBeUndefined();
  });

  it("turns {error, message, detail} into ApiError", async () => {
    const { api } = clientWith(() => json(409, { error: "device_limit", message: "the Free plan allows 1 linked computer(s); unlink one or upgrade", detail: null }));
    const e = await api.post("/v1/device-link/approve", { userCode: "BCDF-GHJK", orgId: "o" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(409);
    expect((e as ApiError).code).toBe("device_limit");
    expect(describeError(e)).toBe("The Free plan allows 1 linked computer(s); unlink one or upgrade.");
  });

  it("reports unreachable servers as NetworkError without leaking the query string", async () => {
    const { api } = clientWith(() => {
      throw new TypeError("Failed to fetch");
    });
    const e = await api.get("/v1/orgs/o/usage?from=x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect(describeError(e)).toBe("Can't reach Matchframe (GET /v1/orgs/o/usage). Check your connection and try again.");
  });

  it("lets aborts through untouched", async () => {
    const { api } = clientWith(() => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(api.get("/v1/plans")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the status text for HTML error pages (proxies) and a code for empty bodies", async () => {
    const html = clientWith(() => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    const e = (await html.api.get("/v1/plans").catch((x: unknown) => x)) as ApiError;
    expect(e.message).toBe("Bad Gateway");
    expect(describeError(e)).toBe("The server had a problem (HTTP 502). Try again in a moment.");
    const empty = clientWith(() => new Response(null, { status: 401 }));
    const e2 = (await empty.api.get("/v1/auth/me", { public: true }).catch((x: unknown) => x)) as ApiError;
    expect(e2.code).toBe("unauthenticated");
  });

  it("rejects non-JSON success bodies", async () => {
    const { api } = clientWith(() => new Response("not json", { status: 200 }));
    await expect(api.get("/v1/plans")).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("401 handling", () => {
  it("reports a lost session for signed-in calls", async () => {
    const lost = vi.fn();
    const { api } = clientWith(() => json(401, { error: "unauthenticated", message: "sign in first", detail: null }), lost);
    await expect(api.get("/v1/orgs/o/billing")).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("does not treat a wrong password (public call) as a lost session", async () => {
    const lost = vi.fn();
    const { api } = clientWith(() => json(401, { error: "invalid_credentials", message: "email or password is incorrect", detail: null }), lost);
    const e = await api.post("/v1/auth/login", { email: "a@b.co", password: "x" }, { public: true }).catch((x: unknown) => x);
    expect(lost).not.toHaveBeenCalled();
    expect(describeError(e)).toBe("Email or password is incorrect.");
  });

  it("can swap the handler at runtime", async () => {
    const { api } = clientWith(() => json(401, { error: "unauthenticated", message: "sign in first" }));
    const h = vi.fn();
    api.setUnauthenticatedHandler(h);
    await api.get("/v1/auth/me").catch(() => undefined);
    expect(h).toHaveBeenCalled();
  });
});

describe("describeError", () => {
  it("explains unverified email, rejected origins and rate limits", () => {
    expect(describeError(new ApiError(403, "email_unverified", "verify your email address first"))).toMatch(/^Verify your email address first/);
    expect(describeError(new ApiError(403, "bad_origin", "origin not allowed"))).toMatch(/another site/);
    expect(describeError(new ApiError(429, "rate_limited", "too many requests"))).toMatch(/Wait a minute/);
    expect(describeError(new ApiError(503, "billing_unavailable", "billing is not configured on this server"))).toMatch(/Online payments aren't set up/);
    expect(describeError(new ApiError(401, "unauthenticated", "sign in first"))).toBe("You're signed out. Sign in again to continue.");
  });

  it("turns role errors into plain language", () => {
    expect(describeError(new ApiError(403, "forbidden", "your role (member) cannot billing.manage"))).toBe("Your role (member) can't manage billing. Ask an owner of this organisation.");
    expect(describeError(new ApiError(403, "forbidden", "your role (billing) cannot devices.link"))).toBe("Your role (billing) can't link computers. Ask an owner of this organisation.");
    expect(describeError(new ApiError(403, "forbidden", "staff only"))).toBe("Not allowed: Staff only.");
    expect(describeError(new ApiError(403, "wrong_account", "this invitation is for a@b.co; sign in with that email"))).toBe("This invitation is for a@b.co; sign in with that email.");
  });

  it("summarises validation issues with field names", () => {
    const e = new ApiError(400, "validation", "request validation failed", [
      { path: "email", message: "Invalid email address" },
      { path: "password", message: "at least 10 characters" },
    ]);
    expect(describeError(e)).toBe("Please check the form: Email: enter a valid email address; Password: at least 10 characters.");
    expect(fieldErrors(e)).toEqual({ email: "Enter a valid email address.", password: "At least 10 characters." });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });

  it("keeps conflicts and not-found messages readable", () => {
    expect(describeError(new ApiError(409, "last_owner", "an organisation needs at least one owner; transfer ownership first"))).toBe("An organisation needs at least one owner; transfer ownership first.");
    expect(describeError(new ApiError(404, "invalid_code", "this code is invalid or expired; start linking again in the desktop app"))).toBe("This code is invalid or expired; start linking again in the desktop app.");
    expect(describeError(new ApiError(500, "internal", "internal error"))).toBe("The server had a problem (HTTP 500). Try again in a moment.");
  });

  it("sentence() capitalises and ends with a full stop once", () => {
    expect(sentence("plan not found")).toBe("Plan not found.");
    expect(sentence("Done!")).toBe("Done!");
    expect(sentence("")).toBe("");
  });
});
