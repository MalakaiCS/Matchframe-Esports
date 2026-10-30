/**
 * vMix as the replay mixer (instead of OBS): its Web Controller API on the same computer
 * (`http://127.0.0.1:8088/api/?Function=…`, enabled in vMix under Settings → Web Controller).
 * A replay is added as a video input, started at the part to show, cut (or faded, or stingered) to,
 * and when it ends vMix goes back to the input that was on air and the replay input is removed.
 * The state is vMix's XML (GET /api): inputs with number, key, title, state, position and duration,
 * and the input on air (<active>).
 */

export interface VmixInput {
  key: string;
  number: number;
  type: string;
  title: string;
  /** "Running", "Paused", "Completed". */
  state: string;
  position: number;
  duration: number;
}

export interface VmixState {
  version: string | null;
  /** The number of the input on air. */
  active: number | null;
  inputs: VmixInput[];
}

const unescapeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Reads vMix's state XML (only what replays need). */
export function parseVmixXml(xml: string): VmixState {
  const inputs: VmixInput[] = [];
  for (const m of xml.matchAll(/<input\s([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs.set(a[1]!, unescapeXml(a[2]!));
    const number = Number(attrs.get("number"));
    if (!Number.isFinite(number)) continue;
    inputs.push({
      key: attrs.get("key") ?? "",
      number,
      type: attrs.get("type") ?? "",
      title: attrs.get("title") ?? "",
      state: attrs.get("state") ?? "",
      position: Number(attrs.get("position") ?? 0),
      duration: Number(attrs.get("duration") ?? 0),
    });
  }
  const active = /<active>(\d+)<\/active>/.exec(xml);
  const version = /<version>([^<]*)<\/version>/.exec(xml);
  return { version: version ? version[1]! : null, active: active ? Number(active[1]) : null, inputs };
}

export class VmixClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Runs one vMix function, e.g. call("CutDirect", { Input: key }). */
  async call(fn: string, params: Record<string, string | number> = {}): Promise<void> {
    const q = new URLSearchParams({ Function: fn, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    const res = await this.fetchImpl(this.url(`/api/?${q.toString()}`), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`vMix answered ${res.status} to ${fn}: ${(await res.text()).slice(0, 120)}`);
  }

  async state(): Promise<VmixState> {
    const res = await this.fetchImpl(this.url("/api"), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`vMix answered ${res.status}`);
    return parseVmixXml(await res.text());
  }
}

/** The vMix transition functions a replay can use (each takes the input to go to). */
export const VMIX_TRANSITIONS = ["CutDirect", "Fade", "Stinger1", "Stinger2"] as const;
export type VmixTransition = (typeof VMIX_TRANSITIONS)[number];
