import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Permission, Principal, SecretStore } from "../auth.ts";
import { can } from "../auth.ts";

export interface Req<B = unknown> {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: B;
  headers: IncomingMessage["headers"];
  principal: Principal | null;
  raw: IncomingMessage;
  rawBody: Buffer;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

export type Reply =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; body: Buffer | string; contentType: string; headers?: Record<string, string> };

type Handler = (req: Req) => Promise<Reply | unknown> | Reply | unknown;

interface RouteOpts<S extends z.ZodTypeAny | undefined> {
  /** Required permission; "public" routes need none. */
  permission: Permission | "public";
  body?: S;
  /** Per-route request body limit (raw uploads); defaults to the router limit. */
  maxBodyBytes?: number;
}

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  opts: RouteOpts<z.ZodTypeAny | undefined>;
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      if (seg === "*") {
        keys.push("rest");
        return "(.*)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${src}/?$`), keys };
}

export interface RouterOptions {
  secrets: SecretStore;
  maxBodyBytes?: number;
  /** Returns true when the origin may perform mutations. */
  originAllowed: (origin: string | undefined, host: string | undefined) => boolean;
  onError?: (e: unknown, req: { method: string; path: string }) => void;
}

export function bearer(req: IncomingMessage, query: URLSearchParams): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const x = req.headers["x-matchframe-token"];
  if (typeof x === "string") return x;
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = /(?:^|;\s*)mf_token=([^;]+)/.exec(cookie);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return query.get("token") ?? undefined;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly maxBody: number;

  constructor(private readonly opts: RouterOptions) {
    this.maxBody = opts.maxBodyBytes ?? 2 * 1024 * 1024;
  }

  add<S extends z.ZodTypeAny | undefined>(method: string, path: string, opts: RouteOpts<S>, handler: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown): void {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, path, pattern, keys, opts, handler: handler as Handler });
  }

  get<S extends z.ZodTypeAny | undefined>(path: string, opts: RouteOpts<S>, h: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown) {
    this.add("GET", path, opts, h);
  }
  post<S extends z.ZodTypeAny | undefined>(path: string, opts: RouteOpts<S>, h: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown) {
    this.add("POST", path, opts, h);
  }
  put<S extends z.ZodTypeAny | undefined>(path: string, opts: RouteOpts<S>, h: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown) {
    this.add("PUT", path, opts, h);
  }
  patch<S extends z.ZodTypeAny | undefined>(path: string, opts: RouteOpts<S>, h: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown) {
    this.add("PATCH", path, opts, h);
  }
  delete<S extends z.ZodTypeAny | undefined>(path: string, opts: RouteOpts<S>, h: (req: Req<S extends z.ZodTypeAny ? z.infer<S> : unknown>) => unknown) {
    this.add("DELETE", path, opts, h);
  }

  routeList(): { method: string; path: string; permission: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: r.path, permission: r.opts.permission }));
  }

  /** OpenAPI 3.1 document generated from the registered routes and their zod body schemas. */
  openapi(info: { title: string; version: string }): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of this.routes) {
      const p = r.path.replace(/:([A-Za-z]+)/g, "{$1}");
      const op: Record<string, unknown> = {
        operationId: `${r.method.toLowerCase()}_${r.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
        summary: `${r.method} ${r.path}`,
        description: r.opts.permission === "public" ? "Public." : `Requires permission \`${r.opts.permission}\`.`,
        ...(r.opts.permission === "public" ? {} : { security: [{ bearer: [] }] }),
        parameters: r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } })),
        responses: { "200": { description: "OK" }, "400": { description: "Validation error" }, "401": { description: "Unauthenticated" }, "403": { description: "Forbidden" }, "409": { description: "Conflict / not allowed in current state" } },
      };
      if (r.opts.body) {
        try {
          op.requestBody = { required: true, content: { "application/json": { schema: z.toJSONSchema(r.opts.body, { unrepresentable: "any", io: "input" }) } } };
        } catch {
          op.requestBody = { required: true, content: { "application/json": { schema: {} } } };
        }
      }
      paths[p] = { ...(paths[p] ?? {}), [r.method.toLowerCase()]: op };
    }
    return {
      openapi: "3.1.0",
      info: { ...info, description: "Matchframe Esports local engine API (loopback by default). Not the API of the separate MatchFrame service or any replay tool." },
      servers: [{ url: "http://127.0.0.1:37211" }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      paths,
    };
  }

  /** Returns false when no route matched (caller may serve static files). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://local");
    const method = req.method ?? "GET";
    const path = url.pathname;
    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      match = r.pattern.exec(path);
      if (match) {
        route = r;
        break;
      }
    }
    if (!route || !match) {
      if (method === "OPTIONS") {
        res.writeHead(204, { allow: "GET, POST, PUT, PATCH, DELETE" }).end();
        return true;
      }
      return false;
    }
    try {
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(match![i + 1] ?? "")));
      const principal = this.opts.secrets.authenticate(bearer(req, url.searchParams));
      if (route.opts.permission !== "public") {
        if (!principal) throw new HttpError(401, "authentication required", "unauthorized");
        if (!can(principal.role, route.opts.permission)) throw new HttpError(403, `role ${principal.role} lacks ${route.opts.permission}`, "forbidden");
      }
      if (method !== "GET" && method !== "HEAD" && !this.opts.originAllowed(req.headers.origin, req.headers.host)) {
        throw new HttpError(403, "origin not allowed", "bad_origin");
      }
      const rawBody = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req, route.opts.maxBodyBytes ?? this.maxBody);
      let body: unknown = undefined;
      if (rawBody.length > 0 && (req.headers["content-type"] ?? "").includes("application/json")) {
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          throw new HttpError(400, "invalid JSON body", "bad_json");
        }
      }
      if (route.opts.body) {
        const r = route.opts.body.safeParse(body ?? {});
        if (!r.success) throw new HttpError(400, "request validation failed", "validation", r.error.issues);
        body = r.data;
      }
      const out = await route.handler({ method, path, params, query: url.searchParams, body, headers: req.headers, principal, raw: req, rawBody });
      send(res, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
      const code = e instanceof HttpError ? e.code : status === 500 ? "internal" : "error";
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) this.opts.onError?.(e, { method, path });
      if (status === 413) res.setHeader("connection", "close");
      const detail = e instanceof HttpError ? e.detail : ((e as { issues?: unknown }).issues ?? null);
      json(res, status, { error: code, message, detail });
    }
    return true;
  }
}

export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      // Refuse before reading; the response (413) is sent and the connection closed afterwards.
      reject(new HttpError(413, `body exceeds ${max} bytes`, "too_large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // discard the rest so the 413 response can still be delivered
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `body exceeds ${max} bytes`, "too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

function send(res: ServerResponse, out: unknown): void {
  if (out && typeof out === "object" && ("json" in out || "body" in out)) {
    const r = out as Reply;
    if ("json" in r) return json(res, r.status ?? 200, r.json, r.headers);
    res.writeHead(r.status ?? 200, { "content-type": r.contentType, "x-content-type-options": "nosniff", ...(r.headers ?? {}) });
    res.end(r.body);
    return;
  }
  json(res, out === undefined ? 204 : 200, out ?? null);
}
