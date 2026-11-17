import { t } from "../i18n/index.ts";
/** Account sync wording (Settings → Account: "Shared with <organisation>"). */

/** "Synced 4 s ago", "Synced 3 min ago". */
export function syncedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return t("lib.notSyncedYet");
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return t("lib.notSyncedYet");
  if (s < 2) return t("lib.syncedJustNow");
  if (s < 60) return t("lib.syncedSSAgo", { s });
  if (s < 3600) return t("lib.syncedFloorMinAgo", { floor: Math.floor(s / 60) });
  if (s < 86400) return t("lib.syncedFloorHAgo", { floor: Math.floor(s / 3600) });
  return t("lib.syncedFloorDAgo", { floor: Math.floor(s / 86400) });
}

/** Sizes as the website counts them (1 GB = 1024 MB). */
export function sizeText(bytes: number): string {
  const [v, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "MB"] : bytes >= 1024 ? [bytes / 1024, "KB"] : [bytes, "B"];
  return `${Math.round(v * 10) / 10} ${unit}`;
}

/** "140 MB of 2 GB". */
export function storageText(used: number, quota: number): string {
  return t("lib.storageOf", { used: sizeText(used), quota: sizeText(quota) });
}

const KINDS = ["player", "team", "match", "hud"];

/** "12 players · 4 teams · 3 matches · 2 HUDs". */
export function countsText(counts: Record<string, number>): string {
  return KINDS.map((kind) => t(`lib.count.${kind}`, { count: counts[kind] ?? 0 })).join(" · ");
}
