import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { CaptureRequest, ClipRecord, ReplayProvider } from "../src/index.ts";
import { ReplayBridgeProvider, ReplayQueue } from "../src/index.ts";

class TestProvider implements ReplayProvider {
  readonly id = "test";
  readonly kind = "test" as const;
  fail = false;
  async capabilities() {
    return { health: true, listSources: true, bufferRange: false, capture: true, prepare: true, preview: false, playout: true, cancel: false, export: false, limitations: ["test"] };
  }
  async health() {
    return { ok: !this.fail, detail: this.fail ? "down" : "ok" };
  }
  async listSources() {
    return [{ id: "program", name: "program", angle: "program" as const, available: true }];
  }
  async bufferRange() {
    return null;
  }
  async capture(req: CaptureRequest): Promise<ClipRecord[]> {
    if (this.fail) throw new Error("replay tool unreachable");
    return [{ clipId: `c-${req.bookmarkId}`, providerId: this.id, sourceId: "program", angle: "program", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: req.epoch, roundNumber: req.roundNumber, media: { path: "/tmp/x.mkv", durationMs: 10000, frameRate: 60, timebase: "1/1000", startPts: 0, hasAudio: true, width: 1920, height: 1080 }, createdAt: "" }];
  }
  async cancel() {}
  async exportClip() {
    return "";
  }
}

const req = { preRollMs: 8000, postRollMs: 0, sourceIds: null, matchTimeMs: null, timeUncertaintyMs: null, epoch: 1, roundNumber: 5 };

describe("ReplayQueue", () => {
  it("A29 (logic): bookmark → prepared → approved → playing → played", async () => {
    const q = new ReplayQueue(new TestProvider());
    const b = q.bookmark("Round 5 multikill", "manual", 5);
    await q.capture(b.id, req);
    expect(q.get(b.id)!.state).toBe("prepared");
    expect(() => q.markPlaying(b.id)).toThrow(/approved/);
    q.approve(b.id);
    q.markPlaying(b.id);
    q.markPlayed(b.id);
    expect(q.get(b.id)!.state).toBe("played");
    expect(q.playlist(1, 12).map((i) => i.id)).toEqual([b.id]);
  });

  it("A32: a failed replay provider leaves a visible failed item without throwing", async () => {
    const p = new TestProvider();
    p.fail = true;
    const q = new ReplayQueue(p);
    const b = q.bookmark("x", "manual", 1);
    const r = await q.capture(b.id, req);
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/unreachable/);
    expect(() => q.approve(b.id)).toThrow();
  });

  it("rejects trims outside the actual clip duration", async () => {
    const q = new ReplayQueue(new TestProvider());
    const b = q.bookmark("x", "manual", 1);
    await q.capture(b.id, req);
    expect(() => q.setTrim(b.id, 9000, 2000)).toThrow(/outside/);
    expect(q.setTrim(b.id, 1000, 5000).trim).toEqual({ startMs: 1000, durationMs: 5000 });
  });
});

describe("ReplayBridgeProvider", () => {
  it("speaks the documented bridge contract and reports health failures without throwing", async () => {
    const server = createServer((rq, rs) => {
      rs.setHeader("content-type", "application/json");
      if (rq.url === "/v1/health") return rs.end(JSON.stringify({ ok: true, detail: "shim ok" }));
      if (rq.url === "/v1/sources") return rs.end(JSON.stringify({ sources: [{ id: "cam1", name: "Angle 1", angle: "recorded_angle", available: true }] }));
      rs.statusCode = 404;
      rs.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const p = new ReplayBridgeProvider(`http://127.0.0.1:${port}`);
    expect(await p.health()).toEqual({ ok: true, detail: "shim ok" });
    expect((await p.listSources())[0]!.angle).toBe("recorded_angle");
    await expect(p.bufferRange()).rejects.toThrow(/404/);
    server.close();
    const down = new ReplayBridgeProvider("http://127.0.0.1:1", { timeoutMs: 300 });
    expect((await down.health()).ok).toBe(false);
  });
});
