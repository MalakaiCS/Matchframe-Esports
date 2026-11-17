/**
 * Low-spec mode (one PC, ADR-078) in the program: the engine's memory cap when it starts, and the
 * desktop HUD windows' frame rate. The setting itself lives in the engine (Settings → General →
 * Performance); the engine tells the program over the fork channel (`{ type: "performance" }`), and
 * the program keeps a copy in program-settings.json for the next engine start.
 */

/** Frame rate Electron uses for a window's offscreen rendering when nothing caps it. */
export const DEFAULT_FRAME_RATE = 60;
const GB = 1024 * 1024 * 1024;

/**
 * The engine's V8 heap cap in low-spec mode (MB). The engine's heap is 50–150 MB in a broadcast
 * (measured: Team Comms soak 51–66 MB, simulated soak RSS 150–300 MB), and V8's own limit is set from
 * the computer's memory (2,096 MB measured with Node 22 on a 16 GB computer; the heap limit becomes
 * 1,072 MB with this cap). 1024 MB leaves ample room for imports and the demo library's lists; 768 MB
 * on computers with less than 12 GB.
 */
export function engineHeapCapMb(totalMemBytes: number): number {
  return totalMemBytes >= 12 * GB ? 1024 : 768;
}

/** The engine's Node options: `base` (tsx in development), and the heap cap in low-spec mode. */
export function engineExecArgv(base: string[], lowSpec: boolean, totalMemBytes: number): { execArgv: string[]; heapCapMb: number | null } {
  if (!lowSpec) return { execArgv: [...base], heapCapMb: null };
  const mb = engineHeapCapMb(totalMemBytes);
  return { execArgv: [...base, `--max-old-space-size=${mb}`], heapCapMb: mb };
}

export interface PerformanceMessage {
  lowSpec: boolean;
  frameCap: number | null;
}

/** The engine's `{ type: "performance", lowSpec, frameCap }` message, or null for any other. */
export function parsePerformanceMessage(m: unknown): PerformanceMessage | null {
  const v = m as { type?: unknown; lowSpec?: unknown; frameCap?: unknown } | null;
  if (!v || typeof v !== "object" || v.type !== "performance" || typeof v.lowSpec !== "boolean") return null;
  const cap = typeof v.frameCap === "number" && Number.isInteger(v.frameCap) && v.frameCap >= 1 && v.frameCap <= 240 ? v.frameCap : null;
  return { lowSpec: v.lowSpec, frameCap: v.lowSpec ? cap : null };
}

/** What setFrameRate needs of a window's web contents. */
export interface FrameRateTarget {
  isDestroyed(): boolean;
  setFrameRate(fps: number): void;
}

/**
 * Applies the frame cap to HUD windows with Electron's setFrameRate (back to 60 without one). Electron
 * applies it to offscreen rendering only; on screen, the output page itself keeps the cap (the HUD
 * server's wrapper, ADR-078). Returns how many windows it was set on.
 */
export function applyFrameRate(targets: Iterable<FrameRateTarget>, frameCap: number | null): number {
  let n = 0;
  for (const t of targets) {
    if (t.isDestroyed()) continue;
    try {
      t.setFrameRate(frameCap ?? DEFAULT_FRAME_RATE);
      n++;
    } catch {
      // A window closing meanwhile.
    }
  }
  return n;
}
