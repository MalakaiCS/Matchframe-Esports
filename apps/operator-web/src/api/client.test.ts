// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, describeError, NetworkError } from "./client.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("api client", () => {
  it("sends the bearer token and JSON body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const api = createApiClient(() => "tok123", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.post("/api/v1/director/hold", { durationMs: 5000 })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/director/hold");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok123");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"durationMs":5000}');
  });

  it("returns undefined for 204 responses", async () => {
    const api = createApiClient(() => null, { fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    await expect(api.del("/x")).resolves.toBeUndefined();
  });

  it("turns engine error bodies into ApiError", async () => {
    const api = createApiClient(() => "t", { fetchImpl: (async () => jsonResponse(409, { error: "veto_started", message: "veto already started; reset first", detail: null })) as unknown as typeof fetch });
    const err = await api.put("/api/v1/veto/m/sequence", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("veto_started");
    expect(describeError(err)).toBe("Conflict: veto already started; reset first");
  });

  it("explains 401 with how to recover", () => {
    expect(describeError(new ApiError(401, "unauthorized", "authentication required"))).toMatch(/access token is missing, expired or was rejected/);
  });

  it("distinguishes forbidden roles from rejected origins", () => {
    expect(describeError(new ApiError(403, "forbidden", "role viewer lacks camera.control"))).toBe("Permission denied: role viewer lacks camera.control");
    expect(describeError(new ApiError(403, "bad_origin", "origin not allowed"))).toMatch(/not allowed to change engine state/);
  });

  it("summarises zod validation issues", () => {
    const e = new ApiError(400, "validation", "request validation failed", [
      { path: ["steps", 0, "kind"], message: "Invalid option" },
      { path: [], message: "Required" },
    ]);
    expect(describeError(e)).toBe("Invalid request: request validation failed — steps.0.kind: Invalid option; Required");
  });

  it("handles non-JSON error bodies", async () => {
    const api = createApiClient(() => "t", { fetchImpl: (async () => new Response("Bad Gateway", { status: 502 })) as unknown as typeof fetch });
    const err = await api.get("/x").catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
    expect(describeError(err)).toBe("Engine error (502): Bad Gateway");
  });

  it("reports an unreachable engine as a NetworkError", async () => {
    const api = createApiClient(() => "t", {
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const err = await api.get("/api/v1/status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(describeError(err)).toMatch(/Engine unreachable \(GET \/api\/v1\/status\): Failed to fetch/);
  });

  it("uploads raw bodies with the given content type", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { assetId: "abc.png" }));
    const api = createApiClient(() => "t", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const buf = new Uint8Array([1, 2, 3]).buffer;
    await expect(api.upload("/api/v1/assets?name=a.png", buf, "image/png")).resolves.toEqual({ assetId: "abc.png" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["content-type"]).toBe("image/png");
    expect(init.body).toBe(buf);
  });

  it("reads the download filename from content-disposition", async () => {
    const api = createApiClient(() => "t", { fetchImpl: (async () => jsonResponse(200, { a: 1 }, { "content-disposition": 'attachment; filename="matchframe-support-1.json"' })) as unknown as typeof fetch });
    const d = await api.download("/api/v1/diagnostics/bundle");
    expect(d.filename).toBe("matchframe-support-1.json");
  });
});
