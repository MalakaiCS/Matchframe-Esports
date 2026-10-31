import { createServer, type Server } from "node:http";

/**
 * A stand-in vMix Web Controller for tests (GET /api: the state XML; GET /api/?Function=…): video
 * inputs that play in real time (AddInput, SetPosition, Play, Pause, SetRate, RemoveInput), the input
 * on air (CutDirect, Fade, Stinger1/2), and audio per input (SetVolume, SetVolumeFade with a ramp,
 * SetGain, AudioOn, AudioOff; the XML's volume and muted). Every call is logged as
 * "<Function> <input> <value>". Not a real vMix: it certifies the engine's requests and timing.
 */
export interface VmixStandInInput {
  key: string;
  number: number;
  type: string;
  title: string;
  state: string;
  position: number;
  duration: number;
  started: number | null;
  /** Audio fader 0–100 (null: no audio), muted, gain (dB). */
  volume: number | null;
  muted: boolean;
  gain: number;
  /** A fade under way: from, to, start, length. */
  fade: { from: number; to: number; at: number; ms: number } | null;
}

export class StandInVmix {
  readonly inputs: VmixStandInInput[] = [];
  active = 1;
  readonly calls: string[] = [];
  /** Where the input on air was (ms) when vMix was asked to fade or cut to a replay input from another replay input. */
  readonly switchedAt: number[] = [];
  /** Every audio change: the input's title, fader and mute after it, when. */
  readonly audioLog: { title: string; volume: number | null; muted: boolean; at: number }[] = [];
  /** Clip duration in vMix (ms) by file name; others this long. */
  clipMs = 9000;
  private server: Server | null = null;
  private readonly t0 = Date.now();

  constructor() {
    this.add({ key: "live-key", type: "Capture", title: "CS2", state: "Running", duration: 0, volume: 100 });
    this.add({ key: "game-key", type: "Audio", title: "Game audio", state: "Running", duration: 0, volume: 80 });
    this.add({ key: "mic-key", type: "Audio", title: "Caster mic", state: "Running", duration: 0, volume: 90 });
  }

  add(p: Partial<VmixStandInInput> & { key: string; title: string }): VmixStandInInput {
    const i: VmixStandInInput = { number: this.inputs.length + 1, type: "Video", state: "Paused", position: 0, duration: this.clipMs, started: null, volume: 100, muted: false, gain: 0, fade: null, ...p };
    this.inputs.push(i);
    return i;
  }

  get url(): string {
    const a = this.server?.address();
    return typeof a === "object" && a ? `http://127.0.0.1:${a.port}` : "";
  }

  find(key: string | null): VmixStandInInput | undefined {
    return this.inputs.find((i) => i.key === key);
  }

  private tick(): void {
    const now = Date.now();
    for (const i of this.inputs) {
      if (i.started !== null && i.state === "Running" && i.duration) {
        i.position = Math.min(i.duration, i.position + (now - i.started));
        i.started = now;
        if (i.position >= i.duration) i.state = "Completed";
      }
      if (i.fade) {
        const t = Math.min(1, (now - i.fade.at) / Math.max(1, i.fade.ms));
        i.volume = i.fade.from + (i.fade.to - i.fade.from) * t;
        if (t >= 1) i.fade = null;
      }
    }
  }

  private logAudio(i: VmixStandInInput): void {
    this.audioLog.push({ title: i.title, volume: i.fade ? i.fade.to : i.volume, muted: i.muted, at: Date.now() - this.t0 });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://vmix");
      this.tick();
      const fn = url.searchParams.get("Function");
      if (fn) {
        const input = this.find(url.searchParams.get("Input"));
        const value = url.searchParams.get("Value") ?? "";
        const duration = url.searchParams.get("Duration");
        const name = input ? (input.key.endsWith("-key") ? input.key.replace(/-key$/, "") : input.key) : "";
        this.calls.push(`${fn}${input ? ` ${name}` : ""}${fn === "AddInput" ? ` ${value.split("|")[0]}` : value && fn !== "AddInput" ? ` ${value}` : ""}${duration ? ` ${duration}` : ""}`);
        const replay = (i: VmixStandInInput | undefined) => !!i && i.type === "Video" && !i.key.endsWith("-key");
        if ((fn === "CutDirect" || fn === "Fade") && replay(input) && replay(this.inputs.find((i) => i.number === this.active))) this.switchedAt.push(Math.round(this.inputs.find((i) => i.number === this.active)!.position));
        if (fn === "AddInput") {
          const file = value.split(/[\\/]/).pop()!;
          this.add({ key: `k${this.inputs.length + 1}`, title: file, duration: this.clipMs });
        }
        if (fn === "SetPosition" && input) input.position = Number(value);
        if (fn === "Play" && input) Object.assign(input, { state: "Running", started: Date.now() });
        if (fn === "Pause" && input) Object.assign(input, { state: "Paused", started: null });
        if ((fn === "CutDirect" || fn === "Fade" || fn === "Stinger1" || fn === "Stinger2") && input) this.active = input.number;
        if (fn === "RemoveInput" && input) this.inputs.splice(this.inputs.indexOf(input), 1);
        if (fn === "SetVolume" && input) {
          [input.volume, input.fade] = [Number(value), null];
          this.logAudio(input);
        }
        if (fn === "SetVolumeFade" && input) {
          const [to, ms] = value.split(",").map(Number) as [number, number];
          input.fade = { from: input.volume ?? 100, to, at: Date.now(), ms };
          this.logAudio(input);
        }
        if (fn === "SetGain" && input) input.gain = Number(value);
        if ((fn === "AudioOn" || fn === "AudioOff") && input) {
          input.muted = fn === "AudioOff";
          this.logAudio(input);
        }
        res.end("Function completed successfully.");
        return;
      }
      const xml = this.inputs
        .map((i) => `<input key="${i.key}" number="${i.number}" type="${i.type}" title="${i.title}" state="${i.state}" position="${Math.round(i.position)}" duration="${i.duration}"${i.volume !== null ? ` volume="${Math.round(i.volume * 100) / 100}" muted="${i.muted ? "True" : "False"}"` : ""}>${i.title}</input>`)
        .join("");
      res.writeHead(200, { "content-type": "text/xml" }).end(`<vmix><version>27.0.0.49</version><inputs>${xml}</inputs><active>${this.active}</active><preview>1</preview></vmix>`);
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
  }

  close(): void {
    this.server?.close();
  }
}
