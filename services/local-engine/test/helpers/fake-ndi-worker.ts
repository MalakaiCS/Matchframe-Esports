import type { NdiReply, NdiRequest, NdiStartOptions } from "../../src/comms/ndi-worker.ts";
import type { NdiWorkerLike } from "../../src/comms/outputs.ts";

/**
 * A stand-in for Team Comms' NDI process (comms/ndi-worker.ts) in fixture tests: it answers "start"
 * with running (or an error), keeps every block the engine sends it, and can "crash". Not NDI: the
 * real process is tested against a real NDI receiver in team-comms-ndi.test.ts.
 */
export class FakeNdiWorker implements NdiWorkerLike {
  readonly blocks: { start: number; wallMs: number; pub: Float32Array; rec: Float32Array }[] = [];
  started: NdiStartOptions | null = null;
  killed = false;
  private onMsg: ((r: NdiReply) => void) | null = null;
  private onExitFn: ((code: number | null) => void) | null = null;

  constructor(private readonly opts: { fail?: string } = {}) {}

  send(req: NdiRequest): void {
    if (req.type === "start") {
      this.started = req.options;
      this.onMsg?.(this.opts.fail ? { type: "status", state: "error", ndi: null, error: this.opts.fail } : { type: "status", state: "running", ndi: "NDI SDK (stand-in)", error: null });
    } else if (req.type === "block") this.blocks.push({ start: req.start, wallMs: req.wallMs, pub: Float32Array.from(req.pub), rec: Float32Array.from(req.rec) });
  }

  onMessage(fn: (r: NdiReply) => void): void {
    this.onMsg = fn;
  }

  onExit(fn: (code: number | null) => void): void {
    this.onExitFn = fn;
  }

  kill(): void {
    this.killed = true;
  }

  /** The process died. */
  crash(code = 1): void {
    this.onExitFn?.(code);
  }
}
