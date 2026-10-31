import { useEffect, useRef, useState } from "react";
import { HudClient } from "@matchframe/hud-sdk";
import type { HudState } from "@matchframe/hud-sdk";
import { demoReplayState, demoState } from "./demo.ts";

export interface HudFeed {
  state: HudState | null;
  /** performance.now() when the state arrived (clocks advance locally from here). */
  receivedAt: number;
  connected: boolean;
}

const params = new URLSearchParams(location.search);
export const VARIANT = params.get("variant") ?? "live";
/** The `replay` entry point (or `?layer=replay`, `?demo=replay`): only the replay graphic, for the replay scene. */
export const REPLAY_LAYER = VARIANT === "replay" || params.get("layer") === "replay" || params.get("demo") === "replay";
const DEMO = params.get("demo") === "1" || params.get("demo") === "replay";
const sample = (): HudState => (params.get("demo") === "replay" ? demoReplayState(params.get("play")) : demoState());

/**
 * Connects to the HUD server's state socket (read-only) and returns the latest public HUD state.
 * The HUD server opens this page with ?output=…&variant=…&t=…. `?demo=1` renders a built-in sample
 * state instead (thumbnails, development without a running program); `?demo=replay&play=3k` the
 * replay layer with a sample clip.
 */
export function useHud(): HudFeed {
  const [feed, setFeed] = useState<HudFeed>(() => (DEMO ? { state: sample(), receivedAt: performance.now(), connected: true } : { state: null, receivedAt: 0, connected: false }));
  useEffect(() => {
    if (DEMO) return;
    const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/overlay-ws?output=${encodeURIComponent(params.get("output") ?? "main")}&variant=${encodeURIComponent(VARIANT)}&t=${encodeURIComponent(params.get("t") ?? "")}`;
    const client = new HudClient({
      url: ws,
      onState: (state, receivedAt) => setFeed({ state, receivedAt, connected: true }),
      onStatus: (s) => s === "closed" && setFeed((f) => ({ ...f, connected: false })),
    });
    client.start();
    return () => client.stop();
  }, []);
  return feed;
}

/** Re-renders every `ms` while mounted (round and bomb clocks). */
export function useNow(ms = 100): number {
  const [now, setNow] = useState(() => performance.now());
  const raf = useRef<number | null>(null);
  useEffect(() => {
    let last = 0;
    const tick = (t: number) => {
      if (t - last >= ms) {
        last = t;
        setNow(t);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [ms]);
  return now;
}
