import { useEffect, useState } from "react";
import type { HudLibraryEntry, HudOutputMode, HudSettingField, HudVariant } from "@matchframe/contracts";
import type { DesktopHudBridge, OverlayState } from "../api/desktop.ts";
import type { Tone } from "../components/ui.tsx";

/** Library card status: the engine status combined with the desktop overlay window's state. */
export type HudDisplayStatus = "ready" | "starting" | "running" | "stopped" | "error";

export const STATUS_INFO: Record<HudDisplayStatus, { label: string; tone: Tone; hint: string }> = {
  ready: { label: "Ready", tone: "neutral", hint: "Installed and verified. No output is connected." },
  starting: { label: "Starting", tone: "info", hint: "The desktop HUD window is loading." },
  running: { label: "Running", tone: "ok", hint: "At least one output (desktop, OBS or preview) is connected." },
  stopped: { label: "Stopped", tone: "warn", hint: "Stopped: OBS browser sources stay connected but show nothing until you start the HUD again." },
  error: { label: "Error", tone: "danger", hint: "The package failed verification or its entry file is missing." },
};

export const STATUS_ORDER: HudDisplayStatus[] = ["ready", "starting", "running", "stopped", "error"];

export const OUTPUT_LABEL: Record<HudOutputMode, string> = { desktop: "Desktop", obs: "OBS", preview: "Preview" };
export const OUTPUT_MODES: HudOutputMode[] = ["desktop", "obs", "preview"];

export const KIND_LABEL: Record<HudLibraryEntry["kind"], string> = { builtin: "Built-in", sample: "Sample", imported: "Imported" };

export const VARIANT_LABEL: Record<HudVariant, string> = {
  live: "Live",
  compact: "Compact",
  replay: "Replay",
  veto: "Veto",
  "pre-match": "Pre-match",
  break: "Break",
  "post-map": "Post-map",
  "post-series": "Post-series",
  studio: "Studio",
};

export function hudStatus(e: HudLibraryEntry, overlay: OverlayState | undefined): { status: HudDisplayStatus; detail: string | null } {
  if (e.status === "error") return { status: "error", detail: e.error ?? STATUS_INFO.error.hint };
  if (overlay?.open && overlay.status === "error") return { status: "error", detail: overlay.error ?? "The desktop HUD window failed to load." };
  if (e.stopped || e.status === "stopped") return { status: "stopped", detail: STATUS_INFO.stopped.hint };
  if (overlay?.open && overlay.status === "starting") return { status: "starting", detail: STATUS_INFO.starting.hint };
  if (e.status === "running" || (overlay?.open && overlay.status === "running")) return { status: "running", detail: STATUS_INFO.running.hint };
  return { status: "ready", detail: STATUS_INFO.ready.hint };
}

/**
 * Active outputs of one HUD. The engine counts runtime connections by mode; the desktop overlay
 * windows and preview windows are those same connections, so the bridge only raises the counts
 * while the engine has not seen a window connect yet (never adds to them).
 */
export function outputCounts(e: HudLibraryEntry, overlay: OverlayState | undefined): Record<HudOutputMode, number> {
  return {
    desktop: Math.max(e.outputs?.desktop ?? 0, overlay?.open ? 1 : 0),
    obs: e.outputs?.obs ?? 0,
    preview: Math.max(e.outputs?.preview ?? 0, overlay?.previews ?? 0),
  };
}

/** Totals across the library plus desktop overlays of HUDs the library response does not list (yet). */
export function totalOutputs(huds: HudLibraryEntry[], overlays: OverlayState[]): Record<HudOutputMode, number> {
  const byId = new Map(overlays.map((o) => [o.hudId, o]));
  const total: Record<HudOutputMode, number> = { desktop: 0, obs: 0, preview: 0 };
  for (const e of huds) {
    const c = outputCounts(e, byId.get(e.id));
    total.desktop += c.desktop;
    total.obs += c.obs;
    total.preview += c.preview;
    byId.delete(e.id);
  }
  for (const o of byId.values()) {
    if (o.open) total.desktop += 1;
    total.preview += o.previews;
  }
  return total;
}

/** OBS browser source URL for a variant (the live variant, else the first implemented one). */
export function variantUrl(e: HudLibraryEntry, variant?: HudVariant | null): string | null {
  if (variant && e.urls[variant]) return e.urls[variant] ?? null;
  return e.urls.live ?? Object.values(e.urls).find((u): u is string => typeof u === "string") ?? null;
}

export function defaultVariant(e: HudLibraryEntry): HudVariant {
  if (e.urls.live || e.variants.includes("live")) return "live";
  return e.variants[0] ?? "live";
}

/** Appends query parameters (undefined values are skipped). */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const extra = Object.entries(params)
    .filter((kv): kv is [string, string] => kv[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!extra) return url;
  return url + (url.includes("?") ? "&" : "?") + extra;
}

export function resolutionLabel(e: Pick<HudLibraryEntry, "designResolution">): string {
  const r = e.designResolution ?? { width: 1920, height: 1080 };
  return `${r.width}×${r.height}`;
}

export function matchesSearch(e: HudLibraryEntry, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return e.name.toLowerCase().includes(s) || e.author.toLowerCase().includes(s) || e.tags.some((t) => t.toLowerCase().includes(s));
}

export type HudSort = "name" | "recent" | "added" | "author";

export const SORT_LABEL: Record<HudSort, string> = { name: "Name", recent: "Recently used", added: "Recently added", author: "Author" };

const byName = (a: HudLibraryEntry, b: HudLibraryEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

export function sortHuds(list: HudLibraryEntry[], key: HudSort): HudLibraryEntry[] {
  const out = [...list];
  if (key === "name") out.sort(byName);
  if (key === "author") out.sort((a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: "base" }) || byName(a, b));
  if (key === "recent") out.sort((a, b) => time(b.lastUsedAt) - time(a.lastUsedAt) || byName(a, b));
  if (key === "added") out.sort((a, b) => time(b.installedAt) - time(a.installedAt) || byName(a, b));
  return out;
}

export interface HudFilter {
  q: string;
  game: string;
  category: string;
  status: string;
}

export const NO_CATEGORY = "__none";

export function filterHuds(list: HudLibraryEntry[], f: HudFilter, statusOf: (e: HudLibraryEntry) => HudDisplayStatus): HudLibraryEntry[] {
  return list.filter(
    (e) =>
      matchesSearch(e, f.q) &&
      (f.game === "all" || e.game === f.game) &&
      (f.category === "all" || (f.category === NO_CATEGORY ? !e.category : e.category === f.category)) &&
      (f.status === "all" || statusOf(e) === f.status),
  );
}

/** -1, 0 or 1 comparing dotted numeric versions (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  const pb = b.split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const FIELD_TYPES = new Set(["boolean", "number", "string", "color", "select"]);

/** Schema entries the settings form can render; anything else is edited in the JSON editor. */
export function formFields(schema: Record<string, unknown> | null | undefined): [string, HudSettingField][] {
  return Object.entries(schema ?? {}).filter((kv): kv is [string, HudSettingField] => {
    const f = kv[1] as { type?: unknown } | null;
    return !!f && typeof f === "object" && typeof f.type === "string" && FIELD_TYPES.has(f.type);
  });
}

/** Why desktop overlays cannot be used here, or null. */
export function desktopReason(bridge: DesktopHudBridge | null): string | null {
  if (!bridge) return "Desktop HUDs need the Matchframe program (this console is open in a browser)";
  if (!bridge.available) return bridge.unavailableReason ?? "Desktop HUDs are unavailable in remote mode: the HUD belongs over the game on the production computer";
  return null;
}

/** Copy of the bytes as a standalone ArrayBuffer (upload bodies). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Desktop overlay states from the bridge (initial list plus pushes); empty without a bridge. */
export function useDesktopOverlays(bridge: DesktopHudBridge | null): OverlayState[] {
  const [list, setList] = useState<OverlayState[]>([]);
  useEffect(() => {
    if (!bridge) {
      setList([]);
      return;
    }
    let alive = true;
    bridge
      .overlays()
      .then((l) => {
        if (alive) setList(l);
      })
      .catch(() => undefined);
    const off = bridge.onOverlays((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);
  return list;
}

/** Writes text to the clipboard (with a textarea fallback for older webviews). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
