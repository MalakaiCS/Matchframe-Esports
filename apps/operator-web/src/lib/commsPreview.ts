import { getOperatorToken } from "../api/auth.ts";
import { engineWsUrl } from "./engine.ts";

/**
 * Team Comms' private preview in the operator's headphones (ADR-066): the engine's preview mix (only
 * the people soloed with Preview, delayed like the outputs) from `/api/v1/comms/preview/ws`, played
 * with Web Audio on the output device the operator picks (AudioContext.setSinkId, else an audio
 * element's). It is never sent anywhere: OBS, the broadcast and the recording never get it.
 *
 * Each binary message (comms/preview.ts): "MFPV", version, channels, rate, the first sample's place
 * on the engine's timeline, then 16-bit samples. Chunks are scheduled back to back LEAD seconds ahead;
 * after a gap (the network, the window in the background) playback starts again LEAD ahead, and a
 * chunk more than MAX_AHEAD ahead is dropped so the delay never grows.
 */

export const PREVIEW_HEADER = 20;
const LEAD = 0.12;
const MAX_AHEAD = 0.6;

export interface PreviewDevice {
  deviceId: string;
  label: string;
}

/** The computer's audio outputs (labels are blank until the window may see them: then "Output 1"…). */
export async function listOutputDevices(md: Pick<MediaDevices, "enumerateDevices"> | undefined = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined): Promise<PreviewDevice[]> {
  if (!md?.enumerateDevices) return [];
  const all = await md.enumerateDevices();
  return all.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
}

export function decodePreview(buf: ArrayBuffer): { start: number; rate: number; samples: Float32Array } | null {
  if (buf.byteLength < PREVIEW_HEADER) return null;
  const v = new DataView(buf);
  if (String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== "MFPV") return null;
  const rate = v.getUint32(8, true);
  const start = v.getFloat64(12, true);
  const n = (buf.byteLength - PREVIEW_HEADER) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = v.getInt16(PREVIEW_HEADER + i * 2, true) / 32767;
  return { start, rate, samples };
}

export type PreviewState = "off" | "connecting" | "playing" | "error";

export interface PreviewStatus {
  state: PreviewState;
  error: string | null;
  deviceId: string;
  /** This window can pick the output device. */
  sinkSupported: boolean;
  chunks: number;
  underruns: number;
  dropped: number;
  /** The last chunk's level (dBFS). */
  levelDb: number;
}

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export interface PreviewPlayerOptions {
  url?: () => string | null;
  AudioContextImpl?: new (o?: AudioContextOptions) => AudioContext;
  WebSocketImpl?: new (url: string) => WebSocket;
  AudioImpl?: new () => HTMLAudioElement;
}

const defaultUrl = () => {
  const token = getOperatorToken();
  return token ? engineWsUrl(`/api/v1/comms/preview/ws?token=${encodeURIComponent(token)}`) : null;
};

export class CommsPreviewPlayer {
  private ctx: SinkAudioContext | null = null;
  private gain: GainNode | null = null;
  private audioEl: SinkAudio | null = null;
  private ws: WebSocket | null = null;
  private next = 0;
  private volume = 1;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(s: PreviewStatus) => void>();
  private st: PreviewStatus = { state: "off", error: null, deviceId: "", sinkSupported: false, chunks: 0, underruns: 0, dropped: 0, levelDb: -100 };

  constructor(private readonly o: PreviewPlayerOptions = {}) {}

  status(): PreviewStatus {
    return { ...this.st };
  }

  onChange(fn: (s: PreviewStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<PreviewStatus>): void {
    this.st = { ...this.st, ...patch };
    for (const fn of this.listeners) fn(this.status());
  }

  /** Starts listening on a device ("" = the system default). Call from a click (browsers start audio only then). */
  async start(deviceId = ""): Promise<void> {
    if (!this.stopped) return this.setDevice(deviceId);
    this.stopped = false;
    const Ctx = this.o.AudioContextImpl ?? (typeof AudioContext !== "undefined" ? AudioContext : null);
    if (!Ctx) return this.set({ state: "error", error: "This window has no Web Audio: the preview can't play here." });
    try {
      const ctx = new Ctx({ sampleRate: 48_000, latencyHint: "interactive" }) as SinkAudioContext;
      this.ctx = ctx;
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(ctx.destination);
      await ctx.resume?.();
      await this.setDevice(deviceId);
    } catch (err) {
      this.set({ state: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.audioEl?.pause();
    this.audioEl = null;
    void this.ctx?.close?.();
    this.ctx = null;
    this.gain = null;
    this.next = 0;
    this.set({ state: "off", levelDb: -100 });
  }

  /** The headphones: an output device id ("" = the system default). */
  async setDevice(deviceId: string): Promise<void> {
    this.st.deviceId = deviceId;
    const ctx = this.ctx;
    if (!ctx || !this.gain) return this.set({ deviceId });
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
      return this.set({ deviceId, sinkSupported: true });
    }
    // Older engines: through an audio element, which can pick its device.
    const Audio = this.o.AudioImpl ?? (typeof window !== "undefined" ? window.Audio : null);
    const el = (this.audioEl ?? (Audio ? new Audio() : null)) as SinkAudio | null;
    if (el && typeof el.setSinkId === "function" && "createMediaStreamDestination" in ctx) {
      if (!this.audioEl) {
        const dest = ctx.createMediaStreamDestination();
        this.gain.disconnect();
        this.gain.connect(dest);
        el.srcObject = dest.stream;
        this.audioEl = el;
      }
      await el.setSinkId(deviceId);
      await el.play().catch(() => undefined);
      return this.set({ deviceId, sinkSupported: true });
    }
    this.set({ deviceId, sinkSupported: false });
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(2, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  private connect(): void {
    const url = (this.o.url ?? defaultUrl)();
    if (!url) return this.set({ state: "error", error: "Not signed in to the engine." });
    const Ws = this.o.WebSocketImpl ?? WebSocket;
    this.set({ state: "connecting", error: null });
    const ws = new Ws(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        if (this.st.state !== "playing") this.set({ state: "playing" });
        return;
      }
      this.receive(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.set({ state: "connecting", error: "Connection to the engine lost; trying again." });
      this.retry = setTimeout(() => this.connect(), 1000);
    };
  }

  /** One message from the engine: scheduled right after the last one. */
  receive(buf: ArrayBuffer): void {
    const d = decodePreview(buf);
    const ctx = this.ctx;
    if (!d || !ctx || !this.gain || d.samples.length === 0) return;
    let sq = 0;
    for (let i = 0; i < d.samples.length; i++) sq += d.samples[i]! * d.samples[i]!;
    const levelDb = sq > 0 ? Math.max(-100, 10 * Math.log10(sq / d.samples.length)) : -100;
    const now = ctx.currentTime;
    let underruns = this.st.underruns;
    if (this.next < now + 0.01) {
      if (this.next > 0) underruns++;
      this.next = now + LEAD;
    } else if (this.next > now + MAX_AHEAD) {
      this.set({ dropped: this.st.dropped + 1, levelDb });
      return;
    }
    const b = ctx.createBuffer(1, d.samples.length, d.rate);
    b.getChannelData(0).set(d.samples);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(this.gain);
    src.start(this.next);
    this.next += d.samples.length / d.rate;
    this.set({ state: "playing", chunks: this.st.chunks + 1, underruns, levelDb });
  }
}
