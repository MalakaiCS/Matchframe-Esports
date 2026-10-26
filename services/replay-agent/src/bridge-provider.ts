import type { CaptureRequest, ClipRecord, ReplayProvider, ReplayProviderCapabilities, ReplaySource } from "./provider.ts";

/**
 * Client for the documented Matchframe Replay Bridge contract (docs/integrations/replay-bridge.md).
 * The owner's existing replay tool was NOT available to this project, so its real API is unknown:
 * this client speaks Matchframe's bridge contract, which a thin shim around that tool must
 * implement. Until such a shim is configured the integration is reported as blocked.
 */
export class ReplayBridgeProvider implements ReplayProvider {
  readonly id: string;
  readonly kind = "existing_tool" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.id = `bridge:${baseUrl}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const r = await f(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`bridge ${method} ${path} → HTTP ${r.status}`);
      return (await r.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  async capabilities(): Promise<ReplayProviderCapabilities> {
    return this.req<ReplayProviderCapabilities>("GET", "/v1/capabilities");
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      return await this.req<{ ok: boolean; detail: string }>("GET", "/v1/health");
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async listSources(): Promise<ReplaySource[]> {
    return (await this.req<{ sources: ReplaySource[] }>("GET", "/v1/sources")).sources;
  }

  async bufferRange(): Promise<{ fromMs: number; toMs: number } | null> {
    return (await this.req<{ range: { fromMs: number; toMs: number } | null }>("GET", "/v1/buffer")).range;
  }

  async capture(req: CaptureRequest): Promise<ClipRecord[]> {
    return (await this.req<{ clips: ClipRecord[] }>("POST", "/v1/captures", req)).clips;
  }

  async cancel(clipId: string): Promise<void> {
    await this.req("POST", `/v1/clips/${encodeURIComponent(clipId)}/cancel`, {});
  }

  async exportClip(clipId: string, destDir: string): Promise<string> {
    return (await this.req<{ path: string }>("POST", `/v1/clips/${encodeURIComponent(clipId)}/export`, { destDir })).path;
  }
}
