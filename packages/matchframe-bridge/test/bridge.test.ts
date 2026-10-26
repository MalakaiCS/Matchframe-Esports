import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { mapResult, MatchFrameBridge } from "../src/index.ts";

describe("MatchFrameBridge", () => {
  it("discovers capabilities, maps and pushes results, and contains failures", async () => {
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/capabilities") return res.end(JSON.stringify({ contractVersion: 1, results: true, assets: false, sponsors: false, graphics: false }));
      if (req.method === "PUT" && req.url?.startsWith("/v1/results/")) {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          received.push(JSON.parse(b));
          res.end("{}");
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const bridge = new MatchFrameBridge(`http://127.0.0.1:${port}`);
    expect((await bridge.discover())?.results).toBe(true);
    const match = { id: "m1", eventId: null, stageId: null, teamAId: "a", teamBId: "b", format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "live" as const, scheduledAt: null, seriesScoreA: 1, seriesScoreB: 0, mapPool: [], vetoSequenceId: null, title: null };
    const res = mapResult(match, [{ id: "x", matchId: "m1", order: 1, mapName: "de_inferno", pickedByTeamId: "a", isDecider: false, startingCtTeamId: null, status: "completed", scoreA: 13, scoreB: 8, winnerTeamId: "a", mapRevision: null }], new Map());
    expect(res.maps[0]!.winnerIndex).toBe(0);
    expect(await bridge.pushResult(res)).toBe(true);
    expect(received).toHaveLength(1);
    server.close();
    const down = new MatchFrameBridge("http://127.0.0.1:1", { timeoutMs: 300 });
    expect(await down.discover()).toBeNull();
    expect(await down.pushResult(res)).toBe(false);
    expect(down.lastError).toBeTruthy();
  });
});
