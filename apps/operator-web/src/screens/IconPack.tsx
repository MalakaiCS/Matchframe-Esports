import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { desktopHud } from "../api/desktop.ts";
import { Icon } from "../components/icons.tsx";
import { useToast } from "../components/toasts.tsx";
import { Button, ErrorBox, Loading, Panel } from "../components/ui.tsx";
import { useApi } from "../lib/hooks.ts";
import { toArrayBuffer } from "../lib/hudLibrary.ts";
import { usePermission } from "../state/session.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

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

const SOURCE: Record<NonNullable<IconPackStatus["source"]>, string> = perLocale(() => ({ zip: t("images.aZip"), folder: t("images.aFolder"), download: t("images.getCs2Icons") }));

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
    const tRow = setInterval(() => void reload.current(), 700);
    return () => clearInterval(tRow);
  }, [downloading]);
  // How the download ended.
  const lastJob = useRef<IconPackStatus["job"]>(null);
  useEffect(() => {
    const job = status?.job ?? null;
    if (lastJob.current?.state === "downloading" && job?.state === "done") toast.push("ok", t("images.cs2IconsDownloaded"), t("images.countIconsLoadedHudsThat", { count: job.count }));
    if (lastJob.current?.state === "downloading" && job?.state === "error") toast.push("danger", t("images.getCs2IconsFailed"), job.message);
    lastJob.current = job;
  }, [status?.job, toast]);

  const run = async (key: string, title: string, fn: () => Promise<IconPackStatus>) => {
    setBusy(key);
    try {
      const s = await fn();
      res.setData(s);
      if (key !== "download" && key !== "remove") toast.push("ok", t("images.countIconsLoaded", { count: s.count }), s.refused.length ? t("images.countRefusedJoin", { count: s.refused.length, join: s.refused.map((r) => r.name).join(", ") }) : t("images.hudsThatUseThemSwitch"));
    } catch (e) {
      toast.push("danger", title, describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const uploadZip = (bytes: ArrayBuffer) => run("zip", t("images.importZipFailed"), () => api.upload<IconPackStatus>(`${ICON_PACK_PATH}/import`, bytes, "application/zip"));
  const importZip = async () => {
    if (!bridge) return fileInput.current?.click();
    try {
      const picked = await bridge.pickZip();
      if (picked) await uploadZip(toArrayBuffer(picked.bytes));
    } catch (e) {
      toast.push("danger", t("images.importZipFailed"), describeError(e));
    }
  };
  const importFolder = async () => {
    if (!bridge) return;
    try {
      const path = await bridge.pickFolder();
      if (path) await run("folder", t("images.importFolderFailed"), () => api.post<IconPackStatus>(`${ICON_PACK_PATH}/import-folder`, { path }));
    } catch (e) {
      toast.push("danger", t("images.importFolderFailed"), describeError(e));
    }
  };
  const reason = editReason ?? (busy ? t("images.working") : downloading ? t("replays.downloading") : null);
  const job = status?.job;

  return (
    <Panel title={t("images.iconPack")} subtitle={t("images.counterStrike2SOwn")}>
      <p className="muted small">{t("images.matchframeDoesnTIncludeCs2")}</p>
      <div className="hudimg-actions iconpack-actions">
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          className="sr-only"
          aria-label={t("images.iconPackZip")}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void f.arrayBuffer().then(uploadZip);
          }}
        />
        <Button size="sm" onClick={() => void importZip()} disabledReason={reason}><T k="images.iconImportZip" values={{ icon: <Icon name="upload" size={14} /> }} /></Button>
        <Button size="sm" onClick={() => void importFolder()} disabledReason={reason ?? (bridge ? null : t("images.foldersCanBeChosenIn"))}>{t("images.importFolder")}</Button>
        <Button size="sm" title={t("images.fromGithubComJuknumCounter")} onClick={() => void run("download", t("images.getCs2IconsFailed"), () => api.post<IconPackStatus>(`${ICON_PACK_PATH}/download`))} disabledReason={reason}>{t("images.getCs2Icons")}</Button>
        {status && status.count > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => void run("remove", t("images.removeFailed"), () => api.del<IconPackStatus>(ICON_PACK_PATH))} disabledReason={reason}>{t("images.remove")}</Button>
        ) : null}
      </div>
      <p className="muted small">{t("images.downloadsCounterStrike2S")}</p>
      {!status ? (
        res.error ? (
          <ErrorBox error={res.error} onRetry={() => void res.reload()} />
        ) : (
          <Loading label={t("images.loadingTheIconPack")} />
        )
      ) : (
        <>
          <p className="iconpack-status" role="status">
            {job?.state === "downloading"
              ? t("images.downloadingDoneOfV", { done: job.done, v: job.total || "…" })
              : job?.state === "error"
                ? t("images.getCs2IconsFailedMessage", { message: job.message })
                : status.count
                  ? t("images.countIconsLoadedVV2", { count: status.count, v: status.source ? t("images.fromSource", { source: SOURCE[status.source] }) : "", v2: status.refused.length ? t("images.refusedSuffix", { n: status.refused.length }) : "" })
                  : t("images.noIconPackHudsUse")}
          </p>
          {status.count ? (
            <div className="iconpack-grid" aria-label={t("images.iconPackPreview")}>
              {PREVIEW.filter((n) => status.names.includes(n)).map((n) => (
                <span key={n} className="iconpack-cell" title={n}>
                  <img src={`/icon-pack/${n}.svg?v=${encodeURIComponent(status.importedAt ?? "")}`} alt={n} />
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
      <p className="muted small">{t("images.theIconPackIsKept")}</p>
    </Panel>
  );
}
