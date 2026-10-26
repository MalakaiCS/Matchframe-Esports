import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVdf } from "../vdf.ts";

/** Dedicated file name so other applications' GSI configs are never overwritten. */
export const GSI_CONFIG_FILE = "gamestate_integration_matchframe.cfg";

/**
 * GSI data components requested by Matchframe. A requested component is not proof that it
 * arrives: the capability sampler reports what the tested build actually sends.
 */
export const GSI_COMPONENTS = [
  "provider",
  "map",
  "round",
  "player_id",
  "player_state",
  "player_weapons",
  "player_match_stats",
  "player_position",
  "allplayers_id",
  "allplayers_state",
  "allplayers_match_stats",
  "allplayers_weapons",
  "allplayers_position",
  "phase_countdowns",
  "allgrenades",
  "bomb",
  "map_round_wins",
] as const;

export interface GsiConfigOptions {
  uri: string;
  token: string;
  timeout?: number;
  buffer?: number;
  throttle?: number;
  heartbeat?: number;
  components?: readonly string[];
}

export function renderGsiConfig(o: GsiConfigOptions): string {
  if (!/^[0-9a-f]{8,64}$/i.test(o.token)) throw new Error("GSI token must be hex");
  if (!/^https?:\/\/[^\s"]+$/.test(o.uri)) throw new Error("invalid GSI uri");
  const comps = (o.components ?? GSI_COMPONENTS).map((c) => `    "${c}" "1"`).join("\n");
  return `"Matchframe Esports"
{
  "uri" "${o.uri}"
  "timeout" "${(o.timeout ?? 1.1).toFixed(1)}"
  "buffer" "${(o.buffer ?? 0).toFixed(1)}"
  "throttle" "${(o.throttle ?? 0.1).toFixed(1)}"
  "heartbeat" "${(o.heartbeat ?? 10).toFixed(1)}"
  "auth"
  {
    "token" "${o.token}"
  }
  "data"
  {
${comps}
  }
}
`;
}

export interface WriteResult {
  path: string;
  written: boolean;
  backup: string | null;
  unchanged: boolean;
}

/** Writes the Matchframe GSI config atomically; an existing different version is backed up. */
export function writeGsiConfig(cfgDir: string, content: string): WriteResult {
  parseVdf(content); // never write something the game cannot parse
  mkdirSync(cfgDir, { recursive: true });
  const path = join(cfgDir, GSI_CONFIG_FILE);
  let backup: string | null = null;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (cur === content) return { path, written: false, backup: null, unchanged: true };
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(backup, cur);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return { path, written: true, backup, unchanged: false };
}
