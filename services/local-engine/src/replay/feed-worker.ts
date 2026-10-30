import type { FeedEvent, FeedOptions, NdiModule } from "./feed-core.ts";
import { FeedRecording } from "./feed-core.ts";

/**
 * The replay feed's own process (forked by replay/feed.ts): the NDI binding (grandi, a native
 * module with the NDI runtime) is loaded here only, never in the engine, and the frames stay here.
 * Messages from the engine: version, find (NDI sources on the network), record, stop.
 */

export type WorkerRequest = { type: "version" } | { type: "find"; id: number; timeoutMs: number } | { type: "record"; options: FeedOptions } | { type: "stop" };
export type WorkerReply = FeedEvent | { type: "version"; ndi: string | null; error: string | null } | { type: "sources"; id: number; sources: { name: string; urlAddress?: string }[]; error: string | null };

let ndi: NdiModule | null = null;

async function load(): Promise<NdiModule> {
  if (!ndi) {
    // A variable name: the engine's bundler leaves the native module out (it ships next to the bundle).
    const name = "grandi";
    const mod = (await import(name)) as { default?: NdiModule } & NdiModule;
    ndi = mod.default ?? mod;
  }
  return ndi;
}

/** Answers one request; `reply` sends to the engine. */
export async function handle(req: WorkerRequest, reply: (r: WorkerReply) => void, state: { recording: FeedRecording | null }, loadNdi: () => Promise<NdiModule> = load): Promise<void> {
  if (req.type === "version") {
    try {
      reply({ type: "version", ndi: (await loadNdi()).version(), error: null });
    } catch (err) {
      reply({ type: "version", ndi: null, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (req.type === "find") {
    try {
      const finder = await (await loadNdi()).find({ showLocalSources: true });
      try {
        await finder.wait(req.timeoutMs);
        reply({ type: "sources", id: req.id, sources: finder.sources().map((s) => ({ name: s.name, ...(s.urlAddress ? { urlAddress: s.urlAddress } : {}) })), error: null });
      } finally {
        finder.destroy();
      }
    } catch (err) {
      reply({ type: "sources", id: req.id, sources: [], error: err instanceof Error ? err.message : String(err) });
    }
  } else if (req.type === "record") {
    state.recording?.stop();
    try {
      const rec = new FeedRecording(await loadNdi(), req.options, reply);
      state.recording = rec;
      void rec.run().catch((err) => reply({ type: "error", message: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } else if (req.type === "stop") {
    state.recording?.stop();
    state.recording = null;
  }
}

if (process.send && process.env.MATCHFRAME_FEED_WORKER === "1") {
  const state: { recording: FeedRecording | null } = { recording: null };
  const reply = (r: WorkerReply) => process.send?.(r);
  process.on("message", (m) => void handle(m as WorkerRequest, reply, state));
  // The engine went away: stop recording (ffmpeg finishes its segment) and leave.
  process.on("disconnect", () => {
    state.recording?.stop();
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
