import { connect, type Socket } from "node:net";
import { encodeAudio, encodeFrame, encodeJson, FrameReader, MsgType } from "../../src/comms/wire.ts";

/**
 * A stand-in for the TeamSpeak plugin (native/ts3-matchframe-plugin) speaking the bridge's wire
 * format, for fixture tests: it is not evidence of TeamSpeak capture. Like the real plugin it says
 * HELLO with the token, reports connections (tabs) and who is in their channel, answers pings with
 * its own clock, and sends a tab's audio only once MatchFrame told it to capture that tab.
 *
 * Its clock is `pluginUs()`: the test's simulated time (ms) plus an offset, optionally drifting.
 */

export interface FakeClient {
  clientId: number;
  uid: string;
  nickname: string;
}

export interface FakeTab {
  schid: number;
  server: { uid: string; name: string; host: string; port: number };
  channel: { id: number; name: string };
  self: FakeClient;
  clients: FakeClient[];
  status: number;
}

export class FakeTs3Plugin {
  private socket: Socket | null = null;
  private readonly reader = new FrameReader();
  readonly tabs = new Map<number, FakeTab>();
  readonly managed = new Map<number, { capture: boolean; listenOnly: boolean; suppressPlayback: boolean }>();
  /** Every MANAGE received, in order. */
  readonly manageLog: Array<{ schid: number; capture: boolean; listenOnly: boolean; suppressPlayback: boolean }> = [];
  recording = false;
  welcomed = false;
  errors: string[] = [];
  /** Frozen: the connection stays open but nothing is sent or answered (TeamSpeak hung). */
  frozen = false;
  private seq = 0;

  constructor(
    private port: number,
    private readonly token: string,
    /** The test's simulated time (ms). */
    private readonly now: () => number,
    readonly opts: { offsetMs?: number; driftPpm?: number; instance?: string } = {},
  ) {}

  /** The plugin's monotonic clock (µs). */
  pluginUs(atMs = this.now()): number {
    return Math.round((atMs * (1 + (this.opts.driftPpm ?? 0) / 1e6) + (this.opts.offsetMs ?? 5_000_000)) * 1000);
  }

  /** Connects (again); `port`: the bridge's port as its file says now (the engine restarted). */
  async connect(token = this.token, port = this.port): Promise<void> {
    this.port = port;
    this.welcomed = false;
    this.frozen = false;
    await new Promise<void>((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port: this.port }, () => resolve());
      s.once("error", reject);
      this.socket = s;
      s.on("data", (chunk: Buffer) => this.receive(chunk));
      s.on("close", () => {
        if (this.socket === s) this.socket = null;
      });
    });
    this.send(encodeJson(MsgType.HELLO, { token, protocol: 1, instance: this.opts.instance ?? "fake-instance", plugin: { name: "MatchFrame Team Comms (stand-in)", version: "test", apiVersion: 26 }, ts3: { clientLibVersion: "stand-in", clientLibVersionNumber: 0 }, platform: "test", clock: { nowUs: this.pluginUs() } }));
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Drops the TCP connection abruptly (TeamSpeak crashed, the plugin was unloaded). */
  kill(): void {
    this.socket?.destroy();
    this.socket = null;
    // The real plugin stops capturing until MatchFrame says so again.
    for (const [k, m] of this.managed) this.managed.set(k, { ...m, capture: false });
  }

  send(buf: Buffer): void {
    if (this.frozen) return;
    this.socket?.write(buf);
  }

  /** TeamSpeak hangs: the connection stays open, nothing more is sent or answered. */
  freeze(): void {
    this.frozen = true;
  }

  get closedByPeer(): boolean {
    return !this.socket || this.socket.destroyed;
  }

  private receive(chunk: Buffer): void {
    if (this.frozen) return;
    for (const f of this.reader.push(chunk)) {
      if (f.type === MsgType.WELCOME) {
        this.welcomed = true;
        for (const t of this.tabs.values()) this.report(t, "hello");
      } else if (f.type === MsgType.ERROR) this.errors.push(f.payload.toString("utf8"));
      else if (f.type === MsgType.MANAGE) {
        const schid = Number(f.payload.readBigUInt64LE(0));
        this.managed.set(schid, { capture: f.payload[8] === 1, listenOnly: f.payload[9] === 1, suppressPlayback: f.payload[10] === 1 });
        this.manageLog.push({ schid, ...this.managed.get(schid)! });
        const t = this.tabs.get(schid);
        if (t) this.report(t, "managed");
      } else if (f.type === MsgType.RECORDING) this.recording = f.payload[0] === 1;
      else if (f.type === MsgType.PING) {
        const p = Buffer.alloc(16);
        f.payload.copy(p, 0, 0, 8);
        p.writeBigUInt64LE(BigInt(this.pluginUs()), 8);
        this.send(encodeFrame(MsgType.PONG, p));
      } else if (f.type === MsgType.SNAPSHOT) for (const t of this.tabs.values()) this.report(t, "snapshot");
    }
  }

  /** A tab connected (status 4 = established) with these people in its channel. */
  openTab(tab: Omit<FakeTab, "status"> & { status?: number }): FakeTab {
    const t: FakeTab = { status: 4, ...tab };
    this.tabs.set(t.schid, t);
    this.report(t, "status");
    return t;
  }

  /** The tab's connection went away (or came back with `status`). */
  setStatus(schid: number, status: number, errorText?: string): void {
    const t = this.tabs.get(schid)!;
    t.status = status;
    if (status !== 4) {
      const m = this.managed.get(schid);
      if (m) this.managed.set(schid, { ...m, capture: false });
    }
    this.report(t, "status", errorText);
  }

  report(t: FakeTab, reason: string, errorText?: string): void {
    const m = this.managed.get(t.schid) ?? { capture: false, listenOnly: false, suppressPlayback: false };
    const established = t.status === 4;
    this.send(
      encodeJson(MsgType.EVENT, {
        type: "connection",
        schid: t.schid,
        reason,
        status: t.status,
        statusName: established ? "established" : "disconnected",
        ...(errorText ? { error: 1797, errorText } : {}),
        ...(established
          ? {
              server: t.server,
              self: { clientId: t.self.clientId, uid: t.self.uid, nickname: t.self.nickname, inputMuted: m.listenOnly ? 1 : 0, inputDeactivated: m.listenOnly ? 1 : 0, outputMuted: 0, recording: this.recording ? 1 : 0 },
              channel: t.channel,
            }
          : {}),
        managed: m,
        clients: established ? t.clients.map((c) => ({ ...c, channelId: t.channel.id })) : [],
      }),
    );
  }

  /** The listener's own client moved to another channel (an admin dragged it), with the people there. */
  moveSelf(schid: number, channel: { id: number; name: string }, clients: FakeClient[]): void {
    const t = this.tabs.get(schid)!;
    t.channel = channel;
    t.clients = clients;
    this.report(t, "moved");
  }

  join(schid: number, c: FakeClient): void {
    const t = this.tabs.get(schid)!;
    t.clients = [...t.clients.filter((x) => x.clientId !== c.clientId), c];
    this.send(encodeJson(MsgType.EVENT, { type: "client", schid, change: "enter", client: { ...c, channelId: t.channel.id } }));
  }

  leave(schid: number, clientId: number): void {
    const t = this.tabs.get(schid)!;
    const c = t.clients.find((x) => x.clientId === clientId);
    t.clients = t.clients.filter((x) => x.clientId !== clientId);
    if (c) this.send(encodeJson(MsgType.EVENT, { type: "client", schid, change: "leave", client: { ...c, channelId: 0 } }));
  }

  /** Is this tab captured (MatchFrame said so)? The real plugin sends nothing otherwise. */
  capturing(schid: number): boolean {
    return !!this.managed.get(schid)?.capture && this.tabs.get(schid)?.status === 4;
  }

  /**
   * One TeamSpeak playback callback's samples for one speaker, stamped at `atMs` (simulated). Not
   * sent unless the tab is captured, like the plugin. Returns whether it was sent.
   */
  audio(schid: number, clientId: number, pcm: Int16Array, atMs: number, o: { rate?: number; channels?: 1 | 2; uid?: string } = {}): boolean {
    if (!this.capturing(schid)) return false;
    const t = this.tabs.get(schid)!;
    const c = t.clients.find((x) => x.clientId === clientId);
    const uid = o.uid ?? c?.uid;
    if (!uid) return false;
    this.send(encodeAudio({ schid, captureUs: this.pluginUs(atMs), seq: this.seq++, sampleRate: o.rate ?? 48000, clientId, ownClientId: t.self.clientId, channels: o.channels ?? 1, part: 0, uid, pcm }));
    return true;
  }
}

/** A sine tone (int16) of `ms` at `freq`, amplitude `amp` (0–1), starting at phase sample `from`. */
export function tone(freq: number, ms: number, rate = 48000, amp = 0.25, from = 0): Int16Array {
  const n = Math.round((ms * rate) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * (from + i)) / rate) * amp * 32767);
  return out;
}

/**
 * Amplitude of `freq` in `x` through a Hann window (0–1: a sine of amplitude A reads A). The window
 * keeps a strong tone nearby, or one starting mid-window, from reading as this one.
 */
export function amplitudeAt(x: Float32Array | Int16Array, freq: number, rate = 48000): number {
  const n = x.length;
  if (n === 0) return 0;
  const scale = x instanceof Int16Array ? 1 / 32768 : 1;
  const k = (2 * Math.PI * freq) / rate;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1 || 1));
    const v = x[i]! * scale * w;
    re += v * Math.cos(k * i);
    im -= v * Math.sin(k * i);
    wsum += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / wsum;
}

/** The loudest `freq` gets over `winMs` windows (half overlapping) of `x`. */
export function peakAmplitude(x: Float32Array | Int16Array, freq: number, winMs = 100, rate = 48000): number {
  const w = Math.round((winMs * rate) / 1000);
  if (x.length <= w) return amplitudeAt(x, freq, rate);
  let best = 0;
  for (let i = 0; i + w <= x.length; i += w / 2) best = Math.max(best, amplitudeAt(x.subarray(i, i + w), freq, rate));
  return best;
}

/** Waits until `pred` holds (real time: the bridge is a real TCP connection). */
export async function until(pred: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
