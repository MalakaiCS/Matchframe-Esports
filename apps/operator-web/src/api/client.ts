/**
 * Small typed client for the local engine REST API. Every request carries the bearer token; error
 * responses ({error, message, detail}) become ApiError with a readable explanation.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when the engine cannot be reached at all (engine stopped, wrong port, network down). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

interface ZodIssueLike {
  path?: (string | number)[];
  message?: string;
}

function issuesText(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const parts = (detail as ZodIssueLike[]).slice(0, 4).map((i) => {
    const path = Array.isArray(i.path) && i.path.length > 0 ? `${i.path.join(".")}: ` : "";
    return `${path}${i.message ?? "invalid"}`;
  });
  const more = detail.length > 4 ? ` (+${detail.length - 4} more)` : "";
  return parts.join("; ") + more;
}

/** Human-readable explanation of any error thrown by the client (or anything else). */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || e.code;
    switch (e.status) {
      case 401:
        return "Not authenticated: the access token is missing, expired or was rejected. Restart the Matchframe program, or check the token in File → Connection settings.";
      case 403:
        if (e.code === "bad_origin") return "Blocked: this page is not allowed to change engine state. Use the Matchframe program.";
        if (e.code === "scope") return `Not allowed for this link: ${msg}`;
        return `Permission denied: ${msg}`;
      case 404:
        return `Not found: ${msg}`;
      case 409: {
        const detail = issuesText(e.detail);
        return `Conflict: ${msg}${detail ? ` (${detail})` : ""}`;
      }
      case 413:
        return `Too large: ${msg}`;
      case 400: {
        const detail = issuesText(e.detail);
        return detail ? `Invalid request: ${msg} — ${detail}` : `Invalid request: ${msg}`;
      }
      default:
        if (e.status >= 500) return `Engine error (${e.status}): ${msg}`;
        return `${msg} (HTTP ${e.status})`;
    }
  }
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export type TokenSource = () => string | null;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface Download {
  blob: Blob;
  filename: string | null;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** Raw binary upload (assets, HUD package archives). */
  upload<T>(path: string, data: Blob | ArrayBuffer, contentType: string): Promise<T>;
  /** Authenticated download (support bundle, event package). */
  download(path: string): Promise<Download>;
}

interface ErrorBody {
  error?: string;
  message?: string;
  detail?: unknown;
}

function parseErrorBody(text: string): ErrorBody | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as ErrorBody) : null;
  } catch {
    return null;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const body = parseErrorBody(text);
  const code = body?.error ?? (res.status === 401 ? "unauthorized" : "error");
  const message = body?.message ?? (text && !body ? text.slice(0, 200) : res.statusText || `HTTP ${res.status}`);
  return new ApiError(res.status, code, message, body?.detail ?? null);
}

export function createApiClient(getToken: TokenSource, opts: ApiClientOptions = {}): ApiClient {
  const base = opts.baseUrl ?? "";
  const doFetch = (input: string, init: RequestInit) => (opts.fetchImpl ?? fetch)(input, init);

  async function send(method: string, path: string, body?: BodyInit | null, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (contentType) headers["content-type"] = contentType;
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body: body ?? null, credentials: "omit" });
    } catch (e) {
      throw new NetworkError(`Engine unreachable (${method} ${path}): ${e instanceof Error ? e.message : String(e)}. Is the Matchframe engine running?`);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body === undefined ? null : JSON.stringify(body), body === undefined ? undefined : "application/json");
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, "bad_response", `Unexpected non-JSON response from ${path}`);
    }
  }

  return {
    get: (path) => json("GET", path),
    post: (path, body) => json("POST", path, body ?? {}),
    put: (path, body) => json("PUT", path, body ?? {}),
    patch: (path, body) => json("PATCH", path, body ?? {}),
    del: (path) => json("DELETE", path),
    async upload(path, data, contentType) {
      const res = await send("POST", path, data, contentType);
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as never;
    },
    async download(path) {
      const res = await send("GET", path);
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename="?([^";]+)"?/i.exec(cd);
      return { blob: await res.blob(), filename: m?.[1] ?? null };
    },
  };
}

/** URL-encodes a path segment. */
export const seg = (s: string) => encodeURIComponent(s);
