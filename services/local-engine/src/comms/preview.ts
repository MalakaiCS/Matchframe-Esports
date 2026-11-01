import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The operator's private preview (ADR-066): the preview mix (only the people soloed with Preview,
 * delayed like every output) to the console's WebSocket, which plays it with Web Audio to the
 * headphones the operator picks (setSinkId). It never goes to NDI or OBS: it isn't part of the public
 * or the recording mix, and soloing someone changes neither.
 *
 * Binary messages, one every PREVIEW_BLOCKS blocks (20 ms): a 20-byte header then 16-bit samples.
 *   0  "MFPV"   4  version (u16, 1)   6  channels (u16, 1)   8  rate (u32, 48000)
 *   12 the first sample's place on the engine's timeline (f64)   20  int16 LE samples
 * A client that falls behind (more than MAX_BUFFERED waiting) misses messages rather than queueing them.
 */

export const PREVIEW_MAGIC = "MFPV";
export const PREVIEW_HEADER = 20;
const PREVIEW_BLOCKS = 2;
const MAX_BUFFERED = 192 * 1024;

export function encodePreview(start: number, samples: Float32Array, rate = 48_000): Buffer {
  const buf = Buffer.alloc(PREVIEW_HEADER + samples.length * 2);
  buf.write(PREVIEW_MAGIC, 0, "latin1");
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(1, 6);
  buf.writeUInt32LE(rate, 8);
  buf.writeDoubleLE(start, 12);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), PREVIEW_HEADER + i * 2);
  return buf;
}

export function decodePreview(buf: Buffer): { start: number; rate: number; samples: Float32Array } | null {
  if (buf.length < PREVIEW_HEADER || buf.toString("latin1", 0, 4) !== PREVIEW_MAGIC) return null;
  const n = (buf.length - PREVIEW_HEADER) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(PREVIEW_HEADER + i * 2) / 32767;
  return { start: buf.readDoubleLE(12), rate: buf.readUInt32LE(8), samples };
}

export class PreviewHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly clients = new Set<WebSocket>();
  private pending: Float32Array | null = null;
  private pendingStart = 0;
  private filled = 0;
  private readonly counters = { messages: 0, dropped: 0, connects: 0 };

  /** `/api/v1/comms/preview/ws` (API server; the operator's token, program control). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      this.counters.connects++;
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => ws.close());
      ws.send(JSON.stringify({ type: "hello", rate: 48_000, channels: 1, format: "s16le", header: PREVIEW_HEADER }));
    });
  }

  /** Each preview block, in order (the mixer's 10 ms blocks). */
  push(block: Float32Array, start: number): void {
    if (this.clients.size === 0) {
      this.pending = null;
      return;
    }
    if (!this.pending || start !== this.pendingStart + this.filled) {
      this.pending = new Float32Array(block.length * PREVIEW_BLOCKS);
      this.pendingStart = start;
      this.filled = 0;
    }
    this.pending.set(block, this.filled);
    this.filled += block.length;
    if (this.filled < this.pending.length) return;
    const msg = encodePreview(this.pendingStart, this.pending);
    this.pending = null;
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        this.counters.dropped++;
        continue;
      }
      ws.send(msg);
      this.counters.messages++;
    }
  }

  status() {
    return { listeners: this.clients.size, ...this.counters };
  }

  close(): void {
    for (const ws of this.clients) ws.close(1001, "shutdown");
    this.wss.close();
  }
}
