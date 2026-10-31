/** Account sync wording (Settings → Account: "Shared with <organisation>"). */

/** "Synced 4 s ago", "Synced 3 min ago". */
export function syncedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "Not synced yet";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "Not synced yet";
  if (s < 2) return "Synced just now";
  if (s < 60) return `Synced ${s} s ago`;
  if (s < 3600) return `Synced ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Synced ${Math.floor(s / 3600)} h ago`;
  return `Synced ${Math.floor(s / 86400)} d ago`;
}

/** Sizes as the website counts them (1 GB = 1024 MB). */
export function sizeText(bytes: number): string {
  const [v, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "MB"] : bytes >= 1024 ? [bytes / 1024, "KB"] : [bytes, "B"];
  return `${Math.round(v * 10) / 10} ${unit}`;
}

/** "140 MB of 2 GB". */
export function storageText(used: number, quota: number): string {
  return `${sizeText(used)} of ${sizeText(quota)}`;
}

const NOUNS: [kind: string, one: string, many: string][] = [
  ["player", "player", "players"],
  ["team", "team", "teams"],
  ["match", "match", "matches"],
  ["hud", "HUD", "HUDs"],
];

/** "12 players · 4 teams · 3 matches · 2 HUDs". */
export function countsText(counts: Record<string, number>): string {
  return NOUNS.map(([kind, one, many]) => {
    const n = counts[kind] ?? 0;
    return `${n} ${n === 1 ? one : many}`;
  }).join(" · ");
}
