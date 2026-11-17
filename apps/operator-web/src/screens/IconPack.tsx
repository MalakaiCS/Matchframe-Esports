import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { desktopHud } from "../api/desktop.ts";
import { Icon } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ErrorBox, Loading, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { toArrayBuffer } from "../lib/hudLibrary.ts";
import { usePermission } from "../state/session.tsx";

export const ICON_PACK_PATH = "/api/v1/hud/icon-pack";

/** The engine's icon pack status (GET /api/v1/hud/icon-pack). */
export interface IconPackStatus {
  count: number;
  names: string[];
  source: "zip" | "folder" | "download" | null;
  importedAt: string | null;
  refused: { name: string; reason: string }[];
  job: { state: "downloading"; done: number; total: number } | { state: "error"; message: string } | { state: "done"; count: number } | null;
}

/** A few weapons and marks shown as the pack's preview. */
const PREVIEW = ["ak47", "m4a1_silencer", "awp", "deagle", "hegrenade", "flashbang", "smokegrenade", "c4", "defuser", "kill_headshot"];

const SOURCE: Record<NonNullable<IconPackStatus["source"]>, string> = { zip: "a ZIP", folder: "a folder", download: "Get CS2 icons" };

/**
 * HUD images → Icon pack: Counter-Strike 2's own icons for the MatchFrame HUDs that use them (the
 * Stage HUD), loaded on this computer from the operator's own copy (Import ZIP…, Import folder…) or
 * downloaded at their request (Get CS2 icons). MatchFrame ships none of them.
 */
export function IconPackPanel() {
  const res = useApi<IconPackStatus>(ICON_PACK_PATH);
  const toast = useToast();
  const editReason = usePermission("hud.publish");
  const bridge = desktopHud();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = res.data;
  const downloading = status?.job?.state === "downloading";

  // While a download runs, its progress (the engine does the work; the page only asks).
  const reload = useRef(res.reload);
  reload.current = res.reload;
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => void reload.current(), 700);
    return () => clearInterval(t);
  }, [downloading]);
  // How the download ended.
  const lastJob = useRef<IconPackStatus["job"]>(null);
  useEffect(() => {
    const job = status?.job ?? null;
    if (lastJob.current?.state === "downloading" && job?.state === "done") toast.push("ok", "CS2 icons downloaded", `${job.count} icons loaded. HUDs that use them switch straight away.`);
    if (lastJob.current?.state === "downloading" && job?.state === "error") toast.push("danger", "Get CS2 icons failed", job.message);
    lastJob.current = job;
  }, [status?.job, toast]);

  const run = async (key: string, title: string, fn: () => Promise<IconPackStatus>) => {
    setBusy(key);
    try {
      const s = await fn();
      res.setData(s);
      if (key !== "download" && key !== "remove") toast.push("ok", `${s.count} icons loaded`, s.refused.length ? `${s.refused.length} refused: ${s.refused.map((r) => r.name).join(", ")}` : "HUDs that use them switch straight away.");
    } catch (e) {
      toast.push("danger", title, describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const uploadZip = (bytes: ArrayBuffer) => run("zip", "Import ZIP failed", () => api.upload<IconPackStatus>(`${ICON_PACK_PATH}/import`, bytes, "application/zip"));
  const importZip = async () => {
    if (!bridge) return fileInput.current?.click();
    try {
      const picked = await bridge.pickZip();
      if (picked) await uploadZip(toArrayBuffer(picked.bytes));
    } catch (e) {
      toast.push("danger", "Import ZIP failed", describeError(e));
    }
  };
  const importFolder = async () => {
    if (!bridge) return;
    try {
      const path = await bridge.pickFolder();
      if (path) await run("folder", "Import folder failed", () => api.post<IconPackStatus>(`${ICON_PACK_PATH}/import-folder`, { path }));
    } catch (e) {
      toast.push("danger", "Import folder failed", describeError(e));
    }
  };
  const reason = editReason ?? (busy ? "Working…" : downloading ? "Downloading…" : null);
  const job = status?.job;

  return (
    <Panel title="Icon pack" subtitle="Counter-Strike 2's own weapon, equipment and kill icons, for HUDs that use them (the Stage HUD). Without a pack they use MatchFrame's icons.">
      <p className="muted small">MatchFrame doesn't include CS2's icons: load them from your own copy (a folder or ZIP of CS2's icons).</p>
      <div className="hudimg-actions iconpack-actions">
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          className="sr-only"
          aria-label="Icon pack ZIP"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void f.arrayBuffer().then(uploadZip);
          }}
        />
        <Button size="sm" onClick={() => void importZip()} disabledReason={reason}>
          <Icon name="upload" size={14} />
          Import ZIP…
        </Button>
        <Button size="sm" onClick={() => void importFolder()} disabledReason={reason ?? (bridge ? null : "Folders can be chosen in the MatchFrame program on this computer")}>
          Import folder…
        </Button>
        <Button size="sm" title="From github.com/Juknum/counter-strike-icons (cs2/panorama/images/icons)" onClick={() => void run("download", "Get CS2 icons failed", () => api.post<IconPackStatus>(`${ICON_PACK_PATH}/download`))} disabledReason={reason}>
          Get CS2 icons
        </Button>
        {status && status.count > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => void run("remove", "Remove failed", () => api.del<IconPackStatus>(ICON_PACK_PATH))} disabledReason={reason}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="muted small">Downloads Counter-Strike 2's icons (Valve's artwork) from a public GitHub collection to this computer, for your own broadcast.</p>
      {!status ? (
        res.error ? (
          <ErrorBox error={res.error} onRetry={() => void res.reload()} />
        ) : (
          <Loading label="Loading the icon pack…" />
        )
      ) : (
        <>
          <p className="iconpack-status" role="status">
            {job?.state === "downloading"
              ? `Downloading ${job.done} of ${job.total || "…"}…`
              : job?.state === "error"
                ? `Get CS2 icons failed: ${job.message}`
                : status.count
                  ? `${status.count} icons loaded${status.source ? ` from ${SOURCE[status.source]}` : ""}${status.refused.length ? ` (${status.refused.length} refused)` : ""}.`
                  : "No icon pack: HUDs use MatchFrame's icons."}
          </p>
          {status.count ? (
            <div className="iconpack-grid" aria-label="Icon pack preview">
              {PREVIEW.filter((n) => status.names.includes(n)).map((n) => (
                <span key={n} className="iconpack-cell" title={n}>
                  <img src={`/icon-pack/${n}.svg?v=${encodeURIComponent(status.importedAt ?? "")}`} alt={n} />
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
      <p className="muted small">The icon pack is kept on this computer (account sync does not share it), like the HUD images.</p>
    </Panel>
  );
}
