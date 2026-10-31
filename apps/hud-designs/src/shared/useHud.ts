import { useEffect, useRef, useState } from "react";
import { HudClient } from "@matchframe/hud-sdk";
import type { HudState } from "@matchframe/hud-sdk";
import { DEMO_PLAYS, DEMO_SCENES, demoReplay, demoScene as sampleScene, type DemoOptions, type DemoPlay, type DemoScene } from "./demo.ts";

export interface HudFeed {
  state: HudState | null;
  /** performance.now() when the state arrived (clocks advance locally from here). */
  receivedAt: number;
  connected: boolean;
}

const params = new URLSearchParams(location.search);
export const VARIANT = params.get("variant") ?? "live";
/** `?demo=<scene>` shows one built-in sample state; `?demo=cycle` plays them in turn (every animation, without a running program). */
const DEMO = params.get("demo");
/** How long each scene of `?demo=cycle` stays (ms). */
const CYCLE_MS = Number(params.get("every") ?? 3500);
/** Demo extras: `?bo=5` (best of), `?art=1` (sample HUD images), `?radar=1` (sample radar). */
const DEMO_OPTS: DemoOptions = { bestOf: params.has("bo") ? Number(params.get("bo")) || undefined : undefined, art: params.get("art") === "1", radar: params.get("radar") === "1" };
const demoScene = (s: DemoScene) => sampleScene(s, DEMO_OPTS);
/** `?demo=replay&play=<3k|kill|ace|clutch|manual|none>&logo=1`: the replay layer with a sample clip on air. */
const PLAY = ((DEMO_PLAYS as readonly string[]).includes(params.get("play") ?? "") ? params.get("play") : "3k") as DemoPlay;
const replayScene = (p: DemoPlay) => demoReplay(p, { ...DEMO_OPTS, logo: params.get("logo") === "1" });
/** A demo page's state: a scene, or `replay:<play>` for the replay layer. */
const demoState = (s: string): HudState => (s.startsWith("replay") ? replayScene(((DEMO_PLAYS as readonly string[]).includes(s.slice(7)) ? s.slice(7) : PLAY) as DemoPlay) : demoScene(s as DemoScene));

/**
 * Connects to the HUD server's state socket (read-only) and returns the latest public HUD state.
 * The HUD server opens this page with ?output=…&variant=…&t=…. With `?demo=…` a built-in sample
 * state is shown instead (thumbnails, development, checking the animations).
 */
export function useHud(): HudFeed {
  const scene = DEMO === "replay" ? "replay" : ((DEMO && DEMO !== "cycle" && (DEMO_SCENES as readonly string[]).includes(DEMO) ? DEMO : DEMO === "1" ? "live" : null) as DemoScene | null);
  const [feed, setFeed] = useState<HudFeed>(() => (scene ? { state: demoState(scene), receivedAt: performance.now(), connected: true } : DEMO === "cycle" ? { state: demoScene(DEMO_SCENES[0]), receivedAt: performance.now(), connected: true } : { state: null, receivedAt: 0, connected: false }));
  useEffect(() => {
    // Demo pages can be switched to another scene (or `replay:<play>`) from outside (scripts/shots.mjs records the animations).
    if (DEMO) (window as unknown as { __mfDemo?: (s: string) => void }).__mfDemo = (s) => setFeed({ state: demoState(s), receivedAt: performance.now(), connected: true });
    if (DEMO === "cycle") {
      let i = 0;
      const t = setInterval(() => {
        i = (i + 1) % DEMO_SCENES.length;
        setFeed({ state: demoScene(DEMO_SCENES[i]!), receivedAt: performance.now(), connected: true });
      }, CYCLE_MS);
      return () => clearInterval(t);
    }
    if (DEMO) return;
    const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/overlay-ws?output=${encodeURIComponent(params.get("output") ?? "main")}&variant=${encodeURIComponent(VARIANT)}&t=${encodeURIComponent(params.get("t") ?? "")}`;
    const client = new HudClient({
      url: ws,
      onState: (state, receivedAt) => setFeed({ state, receivedAt, connected: true }),
      onStatus: (s) => s === "closed" && setFeed((f) => ({ ...f, connected: false })),
    });
    client.start();
    return () => client.stop();
  }, [scene]);
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

/** The value from the render before (undefined on the first). */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/**
 * True for `ms` after `key` changes (not on the first render): drives one-off animations such as
 * a card dying, a kill-feed row arriving or the round-win banner.
 */
export function usePulse(key: unknown, ms: number): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return on;
}
