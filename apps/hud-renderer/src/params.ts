/** Reads output id, variant and token from either /overlay/:id/:variant?t= or ?output=&variant=&t=. */
export function readParams(loc: Location = window.location): { outputId: string; variant: string; token: string; wsUrl: string; preview: boolean; demo: string | null } {
  const q = new URLSearchParams(loc.search);
  const m = /^\/overlay\/([a-z0-9-]+)\/([a-z-]+)\/?$/.exec(loc.pathname);
  const outputId = m?.[1] ?? q.get("output") ?? "main";
  const variant = q.get("variant") ?? m?.[2] ?? "live";
  const token = q.get("t") ?? "";
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${loc.host}/overlay-ws?output=${encodeURIComponent(outputId)}&variant=${encodeURIComponent(variant)}&t=${encodeURIComponent(token)}`;
  return { outputId, variant, token, wsUrl, preview: q.get("preview") === "1", demo: q.get("demo") };
}
