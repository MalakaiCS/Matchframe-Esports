/**
 * Typed client for the Matchframe cloud API. The website is served from the same origin as the
 * API, so every call uses a relative /v1/... URL and the HttpOnly session cookie
 * (credentials: "same-origin"). Error responses ({error, message, detail}) become ApiError with a
 * readable explanation; a 401 on a signed-in call reports the session as gone.
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

/** The API could not be reached at all (offline, server down, blocked by the network). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /**
   * The call is allowed without a session (sign-in, sign-up, public pages, the session probe).
   * A 401 then only rejects the promise; otherwise it also triggers onUnauthenticated.
   */
  public?: boolean;
}

export interface ClientOptions {
  fetchImpl?: () => typeof fetch;
  /** Called when a signed-in call answers 401 (session expired or signed out elsewhere). */
  onUnauthenticated?: () => void;
}

export interface ApiClient {
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string, opts?: Omit<RequestOptions, "method" | "body">): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** Replace the 401 handler (the app wires this to its session state and router). */
  setUnauthenticatedHandler(fn: (() => void) | undefined): void;
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const parsed = text ? parseJson(text) : undefined;
  const body = parsed && typeof parsed === "object" ? (parsed as ErrorBody) : null;
  const code = typeof body?.error === "string" ? body.error : res.status === 401 ? "unauthenticated" : "http_error";
  const message = typeof body?.message === "string" ? body.message : body ? code.replace(/_/g, " ") : text && !text.trimStart().startsWith("<") ? text.slice(0, 200) : res.statusText || `HTTP ${res.status}`;
  return new ApiError(res.status, code, message, body?.detail ?? null);
}

export function createClient(opts: ClientOptions = {}): ApiClient {
  let onUnauthenticated = opts.onUnauthenticated;
  const getFetch = opts.fetchImpl ?? (() => globalThis.fetch.bind(globalThis));

  async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/v1/")) throw new Error(`API paths must be relative /v1/ URLs (got ${path})`);
    const method = o.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    let body: string | null = null;
    if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await getFetch()(path, { method, headers, body, credentials: "same-origin", signal: o.signal ?? null });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new NetworkError(`Can't reach Matchframe (${method} ${path.split("?")[0]}). Check your connection and try again.`);
    }
    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401 && !o.public) onUnauthenticated?.();
      throw err;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    const data = parseJson(text);
    if (data === undefined) throw new ApiError(res.status, "bad_response", `Unexpected response from ${path.split("?")[0]}`);
    return data as T;
  }

  return {
    request,
    get: (path, o) => request(path, { ...o, method: "GET" }),
    post: (path, body, o) => request(path, { ...o, method: "POST", body: body ?? {} }),
    put: (path, body) => request(path, { method: "PUT", body: body ?? {} }),
    patch: (path, body) => request(path, { method: "PATCH", body: body ?? {} }),
    del: (path) => request(path, { method: "DELETE" }),
    setUnauthenticatedHandler(fn) {
      onUnauthenticated = fn;
    },
  };
}

/** URL-encodes one path segment. */
export const seg = (s: string) => encodeURIComponent(s);

// ---------------------------------------------------------------------------- readable errors

const ACTIONS: Record<string, string> = {
  "org.view": "view this organisation",
  "org.rename": "rename the organisation",
  "members.manage": "manage members and invites",
  "billing.manage": "manage billing",
  "billing.view": "view billing",
  "devices.link": "link computers",
  "devices.revoke": "unlink computers",
  "usage.view": "view usage",
};

/** "email or password is incorrect" → "Email or password is incorrect." */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(cap) ? cap : `${cap}.`;
}

interface IssueLike {
  path?: unknown;
  message?: unknown;
}

const FIELD_NAMES: Record<string, string> = {
  email: "Email",
  password: "Password",
  newPassword: "New password",
  currentPassword: "Current password",
  displayName: "Your name",
  orgName: "Organisation name",
  name: "Name",
  role: "Role",
  token: "Link",
  userCode: "Code",
  hours: "Hours",
  note: "Note",
  expiresAt: "Expiry",
};

function issueMessage(m: string): string {
  if (/expected string to have >=1 characters/i.test(m) || /^required$/i.test(m)) return "required";
  return m.replace(/^Too small: expected string to have >=(\d+) characters$/i, "at least $1 characters").replace(/^Invalid email address$/i, "enter a valid email address");
}

/** Validation issues from the API ({path, message}[]) keyed by top-level field. */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(e instanceof ApiError) || !Array.isArray(e.detail)) return out;
  for (const i of e.detail as IssueLike[]) {
    const path = typeof i.path === "string" ? i.path : Array.isArray(i.path) ? i.path.join(".") : "";
    const key = path.split(".")[0] ?? "";
    if (key && !out[key] && typeof i.message === "string") out[key] = sentence(issueMessage(i.message));
  }
  return out;
}

function issuesText(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const parts = (detail as IssueLike[]).slice(0, 4).map((i) => {
    const path = typeof i.path === "string" ? i.path : Array.isArray(i.path) ? i.path.join(".") : "";
    const label = path ? `${FIELD_NAMES[path] ?? path}: ` : "";
    return `${label}${issueMessage(typeof i.message === "string" ? i.message : "invalid")}`;
  });
  return parts.join("; ") + (detail.length > 4 ? ` (+${detail.length - 4} more)` : "");
}

/** Human-readable explanation of any error thrown by the client (or anything else). */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || e.code;
    switch (e.code) {
      case "unauthenticated":
        return "You're signed out. Sign in again to continue.";
      case "invalid_credentials":
        return sentence(msg);
      case "email_unverified":
        return "Verify your email address first: open the link we emailed you, or send a new one from your account page.";
      case "bad_origin":
        return "This request came from another site and was blocked. Open the Matchframe website directly and try again.";
      case "rate_limited":
        return "Too many attempts in a short time. Wait a minute and try again.";
      case "billing_unavailable":
        return "Online payments aren't set up on this server yet, so nothing can be bought right now.";
      case "validation": {
        const d = issuesText(e.detail);
        return d ? `Please check the form: ${d}.` : "Please check the form and try again.";
      }
      case "forbidden": {
        const m = /your role \((\w+)\) cannot ([\w.]+)/.exec(msg);
        if (m) return `Your role (${m[1]}) can't ${ACTIONS[m[2]!] ?? m[2]}. Ask an owner of this organisation.`;
        return `Not allowed: ${sentence(msg)}`;
      }
    }
    if (e.status === 404) return sentence(msg);
    if (e.status === 409 || e.status === 400 || e.status === 403) return sentence(msg);
    if (e.status === 413) return "That request is too large.";
    if (e.status >= 500) return `The server had a problem (HTTP ${e.status}${e.code !== "internal" && e.code !== "http_error" ? `, ${e.code}` : ""}). Try again in a moment.`;
    return `${sentence(msg)} (HTTP ${e.status})`;
  }
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
