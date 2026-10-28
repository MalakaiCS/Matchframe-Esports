import { afterEach, describe, expect, it, vi } from "vitest";
import { lhmUrgentKey, updateCoalescer } from "../src/hud/lhm-runtime.ts";

/** A game-data packet: `t` changes the clock and positions only; the rest is what viewers see switch. */
const packet = (t: number, opts: { observed?: string; phase?: string; dead?: number } = {}) => ({
  provider: { timestamp: t },
  player: { steamid: opts.observed ?? "765A" },
  round: { phase: "live" },
  phase_countdowns: { phase: opts.phase ?? "live", phase_ends_in: String(60 - t / 1000) },
  map: { round: 7, phase: "live", team_ct: { score: 3 }, team_t: { score: 4 } },
  allplayers: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { state: { health: i < (opts.dead ?? 0) ? 0 : 100 }, position: `${t}, 0, 0` }])),
});

describe("game data to LHM HUDs", () => {
  afterEach(() => vi.useRealTimers());

  it("sends 50 packets a second as about 10, always the latest", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const c = updateCoalescer((p) => sent.push((p.provider as { timestamp: number }).timestamp), 100, () => Date.now());
    for (let t = 0; t < 1000; t += 20) {
      c.push(packet(t));
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(200);
    expect(sent.length).toBeGreaterThanOrEqual(10);
    expect(sent.length).toBeLessThanOrEqual(12);
    // The last packet always arrives.
    expect(sent.at(-1)).toBe(980);
    c.dispose();
  });

  it("sends a POV switch, a phase change and a death at once", () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const c = updateCoalescer((p) => sent.push(p), 100, () => Date.now());
    c.push(packet(0));
    vi.advanceTimersByTime(20);
    c.push(packet(20, { observed: "765B" }));
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(20);
    c.push(packet(40, { observed: "765B", phase: "bomb" }));
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(20);
    c.push(packet(60, { observed: "765B", phase: "bomb", dead: 1 }));
    expect(sent).toHaveLength(4);
    c.dispose();
  });

  it("keys on what viewers see switch, not on the clock or positions", () => {
    expect(lhmUrgentKey(packet(0))).toBe(lhmUrgentKey(packet(500)));
    expect(lhmUrgentKey(packet(0))).not.toBe(lhmUrgentKey(packet(0, { observed: "765C" })));
  });
});
