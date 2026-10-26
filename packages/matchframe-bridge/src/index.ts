import type { MapInstance, Match, Team } from "@matchframe/contracts";

/**
 * Optional adapter to the separate MatchFrame service (spec §23.4). The real MatchFrame API was not
 * available to this project, so this client speaks a documented Matchframe bridge contract
 * (docs/integrations/matchframe-bridge.md) behind capability discovery and a mapping layer. Any
 * failure is contained: the local CS2 broadcast never depends on it.
 */
export interface BridgeCapabilities {
  contractVersion: number;
  results: boolean;
  assets: boolean;
  sponsors: boolean;
  graphics: boolean;
}

export interface BridgeResult {
  externalMatchId: string;
  status: Match["status"];
  bestOf: number;
  teams: { name: string; shortName: string; seriesScore: number }[];
  maps: { order: number; mapName: string; status: MapInstance["status"]; scores: [number, number]; winnerIndex: 0 | 1 | null }[];
  updatedAt: string;
}

export function mapResult(match: Match, maps: MapInstance[], teams: Map<string, Team>): BridgeResult {
  const a = teams.get(match.teamAId);
  const b = teams.get(match.teamBId);
  return {
    externalMatchId: match.id,
    status: match.status,
    bestOf: match.format.bestOf,
    teams: [
      { name: a?.name ?? match.teamAId, shortName: a?.shortName ?? "A", seriesScore: match.seriesScoreA },
      { name: b?.name ?? match.teamBId, shortName: b?.shortName ?? "B", seriesScore: match.seriesScoreB },
    ],
    maps: maps.map((m) => ({
      order: m.order,
      mapName: m.mapName,
      status: m.status,
      scores: [m.scoreA, m.scoreB],
      winnerIndex: m.winnerTeamId === match.teamAId ? 0 : m.winnerTeamId === match.teamBId ? 1 : null,
    })),
    updatedAt: new Date().toISOString(),
  };
}

export class MatchFrameBridge {
  private caps: BridgeCapabilities | null = null;
  lastError: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const r = await f(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`MatchFrame bridge ${method} ${path} → HTTP ${r.status}`);
      return (await r.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  async discover(): Promise<BridgeCapabilities | null> {
    try {
      this.caps = await this.req<BridgeCapabilities>("GET", "/v1/capabilities");
      this.lastError = null;
    } catch (e) {
      this.caps = null;
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    return this.caps;
  }

  get capabilities(): BridgeCapabilities | null {
    return this.caps;
  }

  /** Pushes a result; returns false (with lastError) instead of throwing so callers never block. */
  async pushResult(result: BridgeResult): Promise<boolean> {
    if (!this.caps?.results) {
      this.lastError = "bridge does not advertise result support";
      return false;
    }
    try {
      await this.req("PUT", `/v1/results/${encodeURIComponent(result.externalMatchId)}`, result, `${result.externalMatchId}:${result.updatedAt}`);
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async listAssets(): Promise<{ id: string; name: string; kind: string; sha256: string; url: string }[]> {
    if (!this.caps?.assets) return [];
    return (await this.req<{ assets: { id: string; name: string; kind: string; sha256: string; url: string }[] }>("GET", "/v1/assets")).assets;
  }
}
