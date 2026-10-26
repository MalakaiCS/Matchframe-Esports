/** Minimal RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF) for roster imports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === "," || c === ";" || c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  displayname: "displayName",
  name: "displayName",
  nick: "displayName",
  nickname: "displayName",
  realname: "realName",
  fullname: "realName",
  steamid: "steamId",
  steamid64: "steamId",
  steam: "steamId",
  team: "team",
  teamname: "team",
  country: "countryCode",
  countrycode: "countryCode",
};

/**
 * Converts CSV text (with a header row) or a JSON array into import rows. Unknown columns are
 * dropped; empty cells are omitted so the engine reports missing required fields. SteamIDs stay
 * strings (17-digit values exceed JS number precision).
 */
export function parseRosterImport(text: string): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((r) => {
      const out: Record<string, string> = {};
      if (r && typeof r === "object") {
        for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
          const key = HEADER_ALIASES[k.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null;
          if (key && v !== null && v !== undefined && String(v).trim() !== "") out[key] = String(v).trim();
        }
      }
      return out;
    });
  }
  const rows = parseCsv(trimmed);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => HEADER_ALIASES[h.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null);
  return body.map((cells) => {
    const out: Record<string, string> = {};
    keys.forEach((k, i) => {
      const v = (cells[i] ?? "").trim();
      if (k && v) out[k] = v;
    });
    return out;
  });
}
