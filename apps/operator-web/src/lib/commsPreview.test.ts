// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CommsPreviewPlayer, decodePreview, listOutputDevices } from "./commsPreview.ts";

/** A preview message as the engine sends it (services/local-engine/src/comms/preview.ts). */
function message(start: number, samples: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(20 + samples.length * 2);
  const v = new DataView(buf);
  "MFPV".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint16(4, 1, true);
  v.setUint16(6, 1, true);
  v.setUint32(8, 48000, true);
  v.setFloat64(12, start, true);
  samples.forEach((x, i) => v.setInt16(20 + i * 2, Math.round(x * 32767), true));
  return buf;
}

class FakeCtx {
  static last: FakeCtx | null = null;
  currentTime = 10;
  sinkId: string | null = null;
  closed = false;
  readonly scheduled: { at: number; samples: Float32Array; rate: number }[] = [];
  readonly destination = {};
  options: unknown;
  constructor(o?: unknown) {
    this.options = o;
    FakeCtx.last = this;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBuffer(_ch: number, n: number, rate: number) {
    const data = new Float32Array(n);
    return { rate, getChannelData: () => data, data };
  }
  createBufferSource() {
    const src = {
      buffer: null as { rate: number; data: Float32Array } | null,
      connect() {},
      start: (at: number) => this.scheduled.push({ at, samples: src.buffer!.data, rate: src.buffer!.rate }),
    };
    return src;
  }
  async resume() {}
  async setSinkId(id: string) {
    this.sinkId = id;
  }
  async close() {
    this.closed = true;
  }
}

class FakeWs {
  static last: FakeWs | null = null;
  binaryType = "blob";
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  close() {
    this.closed = true;
  }
}

const player = () => new CommsPreviewPlayer({ url: () => "ws://engine/api/v1/comms/preview/ws?token=t", AudioContextImpl: FakeCtx as unknown as typeof AudioContext, WebSocketImpl: FakeWs as unknown as typeof WebSocket });

describe("Team Comms preview in the operator's headphones", () => {
  it("decodes the engine's messages", () => {
    const d = decodePreview(message(4800, [0.5, -0.5, 0]))!;
    expect(d.start).toBe(4800);
    expect(d.rate).toBe(48000);
    expect(Array.from(d.samples).map((x) => Math.round(x * 100) / 100)).toEqual([0.5, -0.5, 0]);
    expect(decodePreview(new ArrayBuffer(8))).toBeNull();
  });

  it("lists only the audio outputs", async () => {
    const md = {
      enumerateDevices: async () =>
        [
          { kind: "audioinput", deviceId: "mic", label: "Mic" },
          { kind: "audiooutput", deviceId: "default", label: "Default" },
          { kind: "audiooutput", deviceId: "hp", label: "Headphones (USB)" },
          { kind: "audiooutput", deviceId: "spk", label: "" },
        ] as MediaDeviceInfo[],
    };
    expect(await listOutputDevices(md)).toEqual([
      { deviceId: "hp", label: "Headphones (USB)" },
      { deviceId: "spk", label: "Output 2" },
    ]);
    expect(await listOutputDevices(undefined)).toEqual([]);
  });

  it("plays on the chosen device: chunks scheduled back to back, a gap restarts ahead, too far ahead is dropped; Stop closes everything", async () => {
    const p = player();
    await p.start("hp");
    const ctx = FakeCtx.last!;
    const ws = FakeWs.last!;
    expect(ctx.options).toMatchObject({ sampleRate: 48000 });
    expect(ctx.sinkId).toBe("hp");
    expect(ws.url).toContain("/api/v1/comms/preview/ws");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(p.status()).toMatchObject({ state: "connecting", deviceId: "hp", sinkSupported: true });
    ws.onmessage!({ data: JSON.stringify({ type: "hello" }) });
    expect(p.status().state).toBe("playing");
    const chunk = new Array(960).fill(0.25);
    ws.onmessage!({ data: message(0, chunk) });
    ws.onmessage!({ data: message(960, chunk) });
    ws.onmessage!({ data: message(1920, chunk) });
    expect(ctx.scheduled.map((s) => Math.round(s.at * 1000))).toEqual([10120, 10140, 10160]);
    expect(ctx.scheduled[0]!.samples[0]).toBeCloseTo(0.25, 3);
    expect(p.status()).toMatchObject({ chunks: 3, underruns: 0 });
    expect(p.status().levelDb).toBeCloseTo(-12, 0);
    // The window was busy: playback fell behind; it starts again a little ahead (a gap, counted).
    ctx.currentTime = 11;
    ws.onmessage!({ data: message(2880, chunk) });
    expect(Math.round(ctx.scheduled[3]!.at * 1000)).toBe(11120);
    expect(p.status().underruns).toBe(1);
    // A burst far ahead of the clock: dropped rather than delaying the preview.
    for (let i = 0; i < 40; i++) ws.onmessage!({ data: message(3840 + i * 960, chunk) });
    expect(p.status().dropped).toBeGreaterThan(0);
    expect(Math.max(...ctx.scheduled.map((s) => s.at)) - ctx.currentTime).toBeLessThanOrEqual(0.62);
    // Another device on the fly.
    await p.setDevice("spk");
    expect(ctx.sinkId).toBe("spk");
    p.stop();
    expect(ws.closed).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(p.status().state).toBe("off");
  });

  it("without AudioContext.setSinkId, plays through an audio element on the chosen device", async () => {
    class NoSinkCtx extends FakeCtx {
      constructor(o?: unknown) {
        super(o);
        // An engine without AudioContext.setSinkId.
        Object.defineProperty(this, "setSinkId", { value: undefined });
      }
      createMediaStreamDestination() {
        return { stream: { id: "stream" } };
      }
    }
    const els: { sink: string | null; srcObject: unknown; played: boolean }[] = [];
    class FakeAudio {
      sink: string | null = null;
      srcObject: unknown = null;
      played = false;
      constructor() {
        els.push(this as never);
      }
      async setSinkId(id: string) {
        this.sink = id;
      }
      async play() {
        this.played = true;
      }
      pause() {}
    }
    const p = new CommsPreviewPlayer({ url: () => "ws://x", AudioContextImpl: NoSinkCtx as unknown as typeof AudioContext, WebSocketImpl: FakeWs as unknown as typeof WebSocket, AudioImpl: FakeAudio as unknown as typeof Audio });
    await p.start("hp");
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ sink: "hp", srcObject: { id: "stream" }, played: true });
    expect(p.status().sinkSupported).toBe(true);
    p.stop();
  });
});
