import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { WRAPPER_JS } from "../src/hud/wrapper.ts";

/**
 * The output page's script (WRAPPER_JS) in a stand-in browser: one main thread with a 60 Hz display,
 * timers, the control socket, and the HUD's frame as a second window on the same thread. The HUD runs
 * a requestAnimationFrame loop, as MatchFrame HUDs' clocks do.
 */
function page(refreshHz = 60) {
  let now = 0;
  const vsyncMs = 1000 / refreshHz;
  const timers: { at: number; fn: () => void; every: number | null; id: number }[] = [];
  let timerId = 0;
  /** Native animation-frame requests of the thread (both windows), and how many display frames ran callbacks. */
  let rafQueue: ((t: number) => void)[] = [];
  let nativeRequests = 0;
  let framesWithCallbacks = 0;
  const sockets: { onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void; sent: string[]; readyState: number }[] = [];
  const el = () => ({ style: {} as Record<string, string>, textContent: "", appendChild: (c: { onAttach?: () => void }) => c.onAttach?.(), removeChild: () => undefined });
  const setTimeout = (fn: () => void, ms = 0) => (timers.push({ at: now + Math.max(0, ms), fn, every: null, id: ++timerId }), timerId);
  const setInterval = (fn: () => void, ms: number) => (timers.push({ at: now + ms, fn, every: ms, id: ++timerId }), timerId);
  const native = (cb: (t: number) => void) => {
    nativeRequests++;
    rafQueue.push(cb);
    return nativeRequests;
  };
  // The HUD's frame: another window on the same thread, its clock 500 ms behind the page's.
  const hudWindow = {
    closed: false,
    performance: { now: () => now - 500, timeOrigin: 1500 },
    requestAnimationFrame: (cb: (t: number) => void) => native((t) => cb(t - 500)),
    cancelAnimationFrame: () => undefined,
    setTimeout,
    document: { defaultView: null as unknown },
  };
  hudWindow.document.defaultView = hudWindow;
  let hudTicks = 0;
  const startHud = () => {
    const tick = () => {
      hudTicks++;
      hudWindow.requestAnimationFrame(tick);
    };
    hudWindow.requestAnimationFrame(tick);
  };
  let iframeLoad: (() => void) | null = null;
  const document = {
    body: { getAttribute: (k: string) => ({ "data-hud": "h", "data-mode": "obs", "data-frame": "/huds/h/index.html", "data-control": "/hud-runtime-ws?x", "data-width": "1920", "data-height": "1080" })[k] ?? null },
    getElementById: () => el(),
    documentElement: { className: "", clientWidth: 1920, clientHeight: 1080, classList: { add: () => undefined, remove: () => undefined } },
    visibilityState: "visible",
    createElement: () => {
      const f = {
        title: "",
        src: "",
        contentWindow: hudWindow,
        parentNode: null,
        setAttribute: () => undefined,
        addEventListener: (ev: string, fn: () => void) => ev === "load" && (iframeLoad = fn),
        // The HUD's page starts its loop as it loads, then the frame's load event fires.
        onAttach: () => setTimeout(() => (startHud(), iframeLoad?.()), 50),
      };
      return f;
    },
  };
  class WebSocket {
    sent: string[] = [];
    readyState = 1;
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 1);
    }
    send(s: string) {
      this.sent.push(s);
    }
  }
  class MessageChannel {
    port1: { onmessage: (() => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
  }
  const window: Record<string, unknown> = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => undefined,
    requestAnimationFrame: native,
    cancelAnimationFrame: () => undefined,
    closed: false,
  };
  window.document = document;
  (document as unknown as { defaultView: unknown }).defaultView = window;
  const ctx = createContext({ window, document, location: { protocol: "http:", host: "127.0.0.1:37212" }, WebSocket, MessageChannel, setTimeout, setInterval, performance: { now: () => now, timeOrigin: 1000 }, Object, Math, Number, JSON, isFinite });
  // Globals of the page are the window's properties.
  for (const k of ["requestAnimationFrame", "cancelAnimationFrame"]) Object.defineProperty(ctx, k, { get: () => window[k], set: (v) => (window[k] = v) });
  window.performance = ctx.performance;
  runInContext(WRAPPER_JS, ctx);

  /** Runs the thread for `ms`: timers when due, animation-frame callbacks on each display frame. */
  const run = (ms: number) => {
    const end = now + ms;
    let nextVsync = Math.ceil((now + 0.001) / vsyncMs) * vsyncMs;
    while (now < end) {
      timers.sort((a, b) => a.at - b.at);
      const timer = timers[0];
      if (timer && timer.at <= nextVsync && timer.at <= end) {
        now = Math.max(now, timer.at);
        if (timer.every) timer.at += timer.every;
        else timers.shift();
        timer.fn();
        continue;
      }
      now = nextVsync;
      // The frame's time is the display frame's; the callbacks run a little after it.
      const q = rafQueue;
      rafQueue = [];
      if (q.length) framesWithCallbacks++;
      now += 0.5;
      for (const cb of q) cb(nextVsync);
      nextVsync += vsyncMs;
    }
  };
  const control = (frameCap: number | null) => sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "control", hudId: "h", stopped: false, hidden: false, reloadSeq: 1, designResolution: { width: 1920, height: 1080 }, testData: false, frameCap }) });
  const counters = () => ({ hudTicks, nativeRequests, framesWithCallbacks });
  const lastPerf = () => sockets[0]!.sent.map((s) => JSON.parse(s) as { type: string; fps: number; frameCap: number | null }).filter((m) => m.type === "perf").at(-1);
  return { run, control, counters, lastPerf, status: () => (window.__mfOverlay as { status(): { frameCap: number | null; frameLoaded: boolean } }).status() };
}

/** Per second over a stretch of `ms`. */
function rates(p: ReturnType<typeof page>, ms: number) {
  const a = p.counters();
  p.run(ms);
  const b = p.counters();
  const s = ms / 1000;
  return { hud: (b.hudTicks - a.hudTicks) / s, native: (b.nativeRequests - a.nativeRequests) / s, frames: (b.framesWithCallbacks - a.framesWithCallbacks) / s };
}

describe("output page frame cap (low-spec mode)", () => {
  it("without a cap, the HUD's animation frames run at the display's rate", () => {
    const p = page();
    p.run(100);
    p.control(null);
    p.run(1000);
    const r = rates(p, 4000);
    expect(r.hud).toBeGreaterThan(58);
    expect(r.frames).toBeGreaterThan(58);
  });

  it("with frameCap 30, the page and the HUD's frame share one 30 a second schedule on a 60 Hz display", () => {
    const p = page();
    p.run(100);
    p.control(30);
    p.run(1000);
    expect(p.status().frameCap).toBe(30);
    const r = rates(p, 4000);
    expect(r.hud).toBeGreaterThan(28);
    expect(r.hud).toBeLessThan(31);
    // One display frame in two runs callbacks: the two windows don't interleave into 60.
    expect(r.frames).toBeGreaterThan(28);
    expect(r.frames).toBeLessThan(31);
    p.run(5000);
    expect(p.lastPerf()).toMatchObject({ frameCap: 30 });
    expect(p.lastPerf()!.fps).toBeGreaterThanOrEqual(29);
    expect(p.lastPerf()!.fps).toBeLessThanOrEqual(31);
  });

  it("keeps about 30 on other refresh rates (75 and 144 Hz)", () => {
    for (const hz of [75, 144]) {
      const p = page(hz);
      p.run(100);
      p.control(30);
      p.run(1000);
      const r = rates(p, 6000);
      expect(r.hud).toBeGreaterThan(27);
      expect(r.hud).toBeLessThan(31);
    }
  });

  it("goes back to the display's rate when the cap is lifted", () => {
    const p = page();
    p.run(100);
    p.control(30);
    p.run(2000);
    p.control(null);
    p.run(500);
    const r = rates(p, 3000);
    expect(r.hud).toBeGreaterThan(58);
  });
});
