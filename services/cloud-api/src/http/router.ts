import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

export interface Ctx<B = unknown> {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: B;
  rawBody: Buffer;
  headers: IncomingMessage["headers"];
  ip: string;
  cookies: Record<string, string>;
}

export interface Reply {
  status?: number;
  json?: unknown;
  body?: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  /** Set-Cookie values. */
  cookies?: string[];
}

const REPLY = Symbol("reply");

/** Wrap responses that need a status, headers, cookies or a non-JSON body (plain objects are sent as JSON 200). */
export function reply(r: Reply): Reply {
  return Object.assign(r, { [REPLY]: true });
}

type Handler<B> = (ctx: Ctx<B>) => Promise<Reply | unknown> | Reply | unknown;

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  body: z.ZodTypeAny | undefined;
  /** Cookie-authenticated browser mutation: requires a same-origin Origin header when present. */
  browserMutation: boolean;
  summary: string;
  handler: Handler<unknown>;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean; httpOnly?: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${opts.maxAgeSec}; SameSite=Lax${opts.httpOnly === false ? "" : "; HttpOnly"}${opts.secure ? "; Secure" : ""}`;
}

export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly opts: { allowedOrigins: string[]; maxBodyBytes?: number; onError?: (e: unknown, ctx: { method: string; path: string }) => void }) {}

  add<S extends z.ZodTypeAny | undefined>(method: string, path: string, opts: { body?: S; browserMutation?: boolean; summary?: string }, handler: Handler<S extends z.ZodTypeAny ? z.infer<S> : unknown>): void {
    const keys: string[] = [];
    const src = path
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, path, pattern: new RegExp(`^${src}/?$`), keys, body: opts.body, browserMutation: opts.browserMutation ?? method !== "GET", summary: opts.summary ?? `${method} ${path}`, handler: handler as Handler<unknown> });
  }

  routeList(): { method: string; path: string; summary: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: r.path, summary: r.summary }));
  }

  openapi(info: { title: string; version: string }): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of this.routes) {
      const p = r.path.replace(/:([A-Za-z]+)/g, "{$1}");
      const op: Record<string, unknown> = { summary: r.summary, parameters: r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } })), responses: { "200": { description: "OK" } } };
      if (r.body) {
        try {
          op.requestBody = { required: true, content: { "application/json": { schema: z.toJSONSchema(r.body, { unrepresentable: "any", io: "input" }) } } };
        } catch {
          op.requestBody = { required: true, content: { "application/json": { schema: {} } } };
        }
      }
      paths[p] = { ...(paths[p] ?? {}), [r.method.toLowerCase()]: op };
    }
    return { openapi: "3.1.0", info, paths };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://local");
    const method = req.method ?? "GET";
    let route: Route | undefined;
    let m: RegExpExecArray | null = null;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      m = r.pattern.exec(url.pathname);
      if (m) {
        route = r;
        break;
      }
    }
    if (!route || !m) return false;
    try {
      if (route.browserMutation) {
        const origin = req.headers.origin;
        if (origin && !this.opts.allowedOrigins.includes(origin)) throw new HttpError(403, "bad_origin", "origin not allowed");
      }
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m![i + 1] ?? "")));
      const rawBody = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req, this.opts.maxBodyBytes ?? 1024 * 1024);
      let body: unknown = undefined;
      if (rawBody.length && (req.headers["content-type"] ?? "").includes("application/json")) {
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          throw new HttpError(400, "bad_json", "invalid JSON body");
        }
      }
      if (route.body) {
        const r = route.body.safeParse(body ?? {});
        if (!r.success) throw new HttpError(400, "validation", "request validation failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
        body = r.data;
      }
      const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
      const out = await route.handler({ method, path: url.pathname, params, query: url.searchParams, body, rawBody, headers: req.headers, ip, cookies: parseCookies(req.headers.cookie) });
      send(res, out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 500;
      if (status >= 500) this.opts.onError?.(e, { method, path: url.pathname });
      const code = e instanceof HttpError ? e.code : status >= 500 ? "internal" : "error";
      const message = status >= 500 && !(e instanceof HttpError) ? "internal error" : e instanceof Error ? e.message : String(e);
      if (status === 413) res.setHeader("connection", "close");
      json(res, status, { error: code, message, detail: e instanceof HttpError ? e.detail : null });
    }
    return true;
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return reject(new HttpError(413, "too_large", `body exceeds ${max} bytes`));
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, "too_large", `body exceeds ${max} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !over && resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(data));
}

function send(res: ServerResponse, out: unknown): void {
  const isReply = !!out && typeof out === "object" && REPLY in out;
  if (!isReply) return json(res, out === undefined ? 204 : 200, out ?? null);
  const r = out as Reply;
  if (r.cookies?.length) res.setHeader("set-cookie", r.cookies);
  if (r.body !== undefined) {
    res.writeHead(r.status ?? 200, { "content-type": r.contentType ?? "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...(r.headers ?? {}) });
    res.end(r.body);
    return;
  }
  json(res, r.status ?? 200, r.json ?? null, r.headers ?? {});
}
