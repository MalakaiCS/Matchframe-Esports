import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SyncChange, SyncItem, SyncKind, SyncPushResult } from "@matchframe/cloud-contracts";
import { SYNC_BLOB_MAX_BYTES, SYNC_ITEM_MAX_BYTES, SYNC_ORG_QUOTA_BYTES, SyncKind as SyncKindSchema, SyncPush } from "@matchframe/cloud-contracts";

export interface FakeDevice {
  token: string;
  deviceId: string;
  deviceName: string;
}

/**
 * A small in-process website with the account sync contract for one organisation: items with a
 * seq per change (the cursor), the stale rule (a change based on an older seq loses to a later
 * edit), and blobs by SHA-256 with a quota. Anything else answers 404, like a website without it.
 */
export class FakeSyncCloud {
  readonly items = new Map<string, SyncItem>();
  readonly blobs = new Map<string, Buffer>();
  readonly requests: { method: string; path: string; deviceId: string | null }[] = [];
  seq = 0;
  /** Off: connections are dropped (the website is unreachable). */
  online = true;
  quotaBytes = SYNC_ORG_QUOTA_BYTES;
  /** Runs before a push is handled (to simulate another computer's change arriving in between). */
  beforePush: ((changes: SyncChange[]) => void) | null = null;
  base = "";
  private server: Server | null = null;

  constructor(readonly devices: FakeDevice[]) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** Stores an item as another computer would have pushed it. */
  put(input: Omit<SyncItem, "seq" | "deviceId" | "deviceName"> & { deviceId?: string }): SyncItem {
    const item: SyncItem = { ...input, seq: ++this.seq, deviceId: input.deviceId ?? "dev_elsewhere", deviceName: "Another PC" };
    this.items.set(`${item.kind}:${item.id}`, item);
    return item;
  }

  live(kind: SyncKind): SyncItem[] {
    return [...this.items.values()].filter((i) => i.kind === kind && i.data !== null);
  }

  count(method: string, prefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length;
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) res.writeHead(status).end();
    else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.online) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const device = this.devices.find((d) => d.token === token) ?? null;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, deviceId: device?.deviceId ?? null });
    if (!url.pathname.startsWith("/v1/sync/")) return this.send(res, 404, { error: "not_found", message: "not found" });
    if (!device) return this.send(res, 401, { error: "unauthorized", message: "unknown device" });

    if (req.method === "GET" && url.pathname === "/v1/sync/changes") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 200)));
      const after = [...this.items.values()].filter((i) => i.seq > since).sort((a, b) => a.seq - b.seq);
      const items = after.slice(0, limit);
      return this.send(res, 200, { items, cursor: items.at(-1)?.seq ?? since, more: after.length > limit });
    }

    if (req.method === "POST" && url.pathname === "/v1/sync/push") {
      let parsed;
      try {
        parsed = SyncPush.safeParse(JSON.parse((await this.body(req)).toString("utf8")));
      } catch {
        return this.send(res, 400, { error: "bad_json" });
      }
      if (!parsed.success) return this.send(res, 400, { error: "validation", message: parsed.error.issues[0]?.message });
      this.beforePush?.(parsed.data.changes);
      const results: SyncPushResult["results"] = [];
      for (const c of parsed.data.changes) {
        // As the website: a later edit wins (an edit stamped in the future counts as now), then size and files are checked.
        const editedAt = new Date(Math.min(Date.parse(c.editedAt), Date.now())).toISOString();
        const existing = this.items.get(`${c.kind}:${c.id}`);
        if (existing && existing.seq > (c.baseSeq ?? 0) && Date.parse(existing.editedAt) > Date.parse(editedAt)) {
          results.push({ kind: c.kind, id: c.id, status: "stale", item: existing, reason: null });
          continue;
        }
        const blobs = c.data === null ? [] : c.blobs;
        const size = c.data === null ? 0 : Buffer.byteLength(JSON.stringify(c.data));
        const missing = blobs.find((b) => !this.blobs.has(b));
        const reason = size > SYNC_ITEM_MAX_BYTES ? `too_large ${size}` : missing ? `missing_blob ${missing}` : null;
        if (reason) {
          results.push({ kind: c.kind, id: c.id, status: "rejected", item: null, reason });
          continue;
        }
        const item: SyncItem = { kind: c.kind, id: c.id, data: c.data, blobs, seq: ++this.seq, editedAt, deviceId: device.deviceId, deviceName: device.deviceName };
        this.items.set(`${c.kind}:${c.id}`, item);
        results.push({ kind: c.kind, id: c.id, status: "applied", item, reason: null });
      }
      return this.send(res, 200, { results, cursor: this.seq });
    }

    const blob = /^\/v1\/sync\/blobs\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
    if (blob && req.method === "PUT") {
      const bytes = await this.body(req);
      if (createHash("sha256").update(bytes).digest("hex") !== blob) return this.send(res, 400, { error: "hash_mismatch", message: "the file does not match its hash" });
      if (this.blobs.has(blob)) return this.send(res, 204);
      const used = [...this.blobs.values()].reduce((n, b) => n + b.length, 0);
      if (bytes.length > SYNC_BLOB_MAX_BYTES) return this.send(res, 413, { error: "too_large", message: "a shared file can be at most 60 MB" });
      if (used + bytes.length > this.quotaBytes) return this.send(res, 413, { error: "quota_exceeded", message: "over the limit", detail: { usedBytes: used, fileBytes: bytes.length, quotaBytes: this.quotaBytes } });
      this.blobs.set(blob, bytes);
      return this.send(res, 204);
    }
    if (blob && req.method === "GET") {
      const bytes = this.blobs.get(blob);
      if (!bytes) return this.send(res, 404, { error: "not_found" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/sync/status") {
      const items = Object.fromEntries(SyncKindSchema.options.map((k) => [k, this.live(k).length]));
      return this.send(res, 200, { cursor: this.seq, items, blobBytes: [...this.blobs.values()].reduce((n, b) => n + b.length, 0), quotaBytes: this.quotaBytes });
    }
    return this.send(res, 404, { error: "not_found" });
  }
}
