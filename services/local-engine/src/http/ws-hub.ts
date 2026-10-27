import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

export interface HubClient {
  id: string;
  ws: WebSocket;
  topics: Set<string> | null;
  meta: Record<string, unknown>;
  needsSnapshot: boolean;
  dropped: number;
}

export interface HubOptions {
  /** Above this many buffered bytes a client is considered slow and receives a fresh snapshot later. */
  maxBufferedBytes?: number;
  onMessage?: (client: HubClient, data: unknown) => void;
  onConnect?: (client: HubClient) => void;
  onClose?: (client: HubClient) => void;
}

let clientCounter = 0;

/**
 * WebSocket fan-out with bounded per-client buffering. Slow clients never get an unbounded queue:
 * deltas are dropped and the client is marked to receive a fresh snapshot once it drains.
 */
export class WsHub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  readonly clients = new Set<HubClient>();
  private readonly maxBuffered: number;

  constructor(private readonly opts: HubOptions = {}) {
    this.maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024;
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, meta: Record<string, unknown>, topics: string[] | null = null): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: HubClient = { id: `c${++clientCounter}`, ws, topics: topics ? new Set(topics) : null, meta, needsSnapshot: true, dropped: 0 };
      this.clients.add(client);
      ws.on("message", (raw) => {
        if (!this.opts.onMessage) return;
        try {
          this.opts.onMessage(client, JSON.parse(String(raw)));
        } catch {
          // ignore malformed client messages
        }
      });
      ws.on("close", () => {
        this.clients.delete(client);
        this.opts.onClose?.(client);
      });
      ws.on("error", () => ws.close());
      this.opts.onConnect?.(client);
    });
  }

  /** Sends to one client, respecting backpressure. Returns false if dropped. */
  sendTo(client: HubClient, msg: unknown, opts: { snapshot?: boolean } = {}): boolean {
    if (client.ws.readyState !== client.ws.OPEN) return false;
    if (client.ws.bufferedAmount > this.maxBuffered) {
      client.dropped++;
      client.needsSnapshot = true;
      return false;
    }
    client.ws.send(JSON.stringify(msg));
    if (opts.snapshot) client.needsSnapshot = false;
    return true;
  }

  broadcast(topic: string, msg: unknown, filter?: (c: HubClient) => boolean): void {
    for (const c of this.clients) {
      if (c.topics && !c.topics.has(topic)) continue;
      if (filter && !filter(c)) continue;
      this.sendTo(c, msg);
    }
  }

  /** Closes every client (forcibly after a second if a peer does not complete the close handshake). */
  closeAll(): void {
    for (const c of this.clients) {
      c.ws.close(1001, "shutdown");
      setTimeout(() => c.ws.terminate(), 1000).unref();
    }
    this.wss.close();
  }
}
