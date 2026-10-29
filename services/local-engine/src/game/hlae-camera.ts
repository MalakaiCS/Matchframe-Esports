import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { CameraPose } from "@matchframe/director-policy";
import { hlaeCameraScript, type HlaeCameraLink, type HlaeKey, type HlaeView } from "@matchframe/observer-agent";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";

const TOKEN_KEY = "hlae.cameraToken";

export interface HlaeCameraStatus {
  enabled: boolean;
  connected: boolean;
  connectedAt: string | null;
  /** Connections so far (a script loaded again connects anew). */
  connections: number;
  shots: number;
  lastShotAt: string | null;
  scriptPath: string | null;
}

/**
 * The engine end of the HLAE camera (observer-agent hlae-camera.ts): writes the Matchframe script
 * for `mirv_script_load`, accepts its WebSocket on the API port at `/hlae` (this computer only, with
 * a token in the script), and plays shots on it. One script at a time; a new one replaces the old.
 */
export class HlaeCameraServer implements HlaeCameraLink {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private ws: WebSocket | null = null;
  private connectedAt: string | null = null;
  private connections = 0;
  private shots = 0;
  private lastShotAt: string | null = null;
  private seq = 0;
  private readonly waiting = new Map<string, (view: HlaeView | null) => void>();
  private scriptPath: string | null = null;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      logger: Pick<Logger, "info" | "warn">;
      dataDir: string;
      /** The API port the script connects to. */
      port: () => number;
      /** HLAE camera shots switched on (Auto Director card). */
      enabled: () => boolean;
    },
  ) {}

  private token(): string {
    let t = this.deps.settings.get<string | null>(TOKEN_KEY, null);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.deps.settings.set(TOKEN_KEY, t);
    }
    return t;
  }

  /** Writes the script and returns the console line that loads it into CS2 (HLAE launch mode). */
  loadCommand(): string {
    const dir = join(this.deps.dataDir, "hlae");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "matchframe-camera.js");
    writeFileSync(file, hlaeCameraScript(`ws://127.0.0.1:${this.deps.port()}/hlae?token=${this.token()}`));
    this.scriptPath = file;
    return `mirv_script_load "${file.replace(/\\/g, "/")}"`;
  }

  /** WebSocket upgrade for `/hlae` (the caller checks the path). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://local");
    const given = Buffer.from(url.searchParams.get("token") ?? "");
    const want = Buffer.from(this.token());
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!local || given.length !== want.length || !timingSafeEqual(given, want)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
  }

  private attach(ws: WebSocket): void {
    this.ws?.close();
    this.ws = ws;
    this.connections++;
    this.connectedAt = new Date().toISOString();
    this.deps.logger.info("HLAE camera connected");
    ws.on("message", (raw) => {
      let m: { type?: string; id?: string; view?: HlaeView };
      try {
        m = JSON.parse(String(raw)) as typeof m;
      } catch {
        return;
      }
      if (m.type === "started" && m.id) {
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        done?.(m.view ?? null);
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connectedAt = null;
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
      this.deps.logger.info("HLAE camera disconnected");
    });
    ws.on("error", () => ws.close());
  }

  connected(): boolean {
    return this.deps.enabled() && !!this.ws && this.ws.readyState === this.ws.OPEN;
  }

  private send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  play(keys: HlaeKey[], opts: { timeoutMs?: number } = {}): Promise<{ view: HlaeView } | null> {
    const id = `s${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, opts.timeoutMs ?? 1000);
      this.waiting.set(id, (view) => {
        clearTimeout(timer);
        if (!view) return resolve(null);
        this.shots++;
        this.lastShotAt = new Date().toISOString();
        resolve({ view });
      });
      if (!this.send({ type: "shot", id, keys })) {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(null);
      }
    });
  }

  live(pose: CameraPose): void {
    this.send({ type: "live", pose: { x: pose.position.x, y: pose.position.y, z: pose.position.z, pitch: pose.pitch, yaw: pose.yaw } });
  }

  release(): void {
    this.send({ type: "release" });
  }

  status(): HlaeCameraStatus {
    return { enabled: this.deps.enabled(), connected: this.connected(), connectedAt: this.connectedAt, connections: this.connections, shots: this.shots, lastShotAt: this.lastShotAt, scriptPath: this.scriptPath };
  }

  close(): void {
    this.ws?.close();
    this.wss.close();
  }
}
