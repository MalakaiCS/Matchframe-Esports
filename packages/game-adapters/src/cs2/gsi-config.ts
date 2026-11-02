import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVdf } from "../vdf.ts";

/** Dedicated file name so other applications' GSI configs are never overwritten. */
export const GSI_CONFIG_FILE = "gamestate_integration_matchframe.cfg";

/**
 * GSI data components requested by MatchFrame. A requested component is not proof that it
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

/**
 * How often CS2 sends game data. CS2 sends one update at a time and waits for the answer (the
 * engine answers before reading the update); `throttle` caps it at 50 updates a second (a POV switch
 * reaches the engine within 20 ms instead of up to 100 ms). An update not answered within `timeout`
 * counts as lost, and CS2 sends the full state again at the next heartbeat: a heartbeat of a second
 * keeps that to a second or two (at 10 s every HUD went without data for up to 10 s).
 */
export const GSI_TIMING = { timeout: 1, buffer: 0, throttle: 0.02, heartbeat: 1 } as const;

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** The name of the config's root block (CS2 ignores it). */
export const GSI_CONFIG_NAME = "MatchFrame Esports";
/** The name 0.11.0 and earlier wrote: a config file of theirs is still read (and rewritten under the new name). */
export const LEGACY_GSI_CONFIG_NAME = "Matchframe Esports";

export function renderGsiConfig(o: GsiConfigOptions): string {
  if (!/^[0-9a-f]{8,64}$/i.test(o.token)) throw new Error("GSI token must be hex");
  if (!/^https?:\/\/[^\s"]+$/.test(o.uri)) throw new Error("invalid GSI uri");
  const comps = (o.components ?? GSI_COMPONENTS).map((c) => `    "${c}" "1"`).join("\n");
  return `"${GSI_CONFIG_NAME}"
{
  "uri" "${o.uri}"
  "timeout" "${num(o.timeout ?? GSI_TIMING.timeout)}"
  "buffer" "${num(o.buffer ?? GSI_TIMING.buffer)}"
  "throttle" "${num(o.throttle ?? GSI_TIMING.throttle)}"
  "heartbeat" "${num(o.heartbeat ?? GSI_TIMING.heartbeat)}"
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

/** Writes the MatchFrame GSI config atomically; an existing different version is backed up. */
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

/**
 * Brings MatchFrame's existing config file up to date (e.g. new timing) with the address and token
 * it already has. Only touches a file that is there and carries this computer's token; CS2 reads it
 * the next time it starts.
 */
export function refreshGsiConfig(cfgDir: string, token: string): WriteResult | null {
  const path = join(cfgDir, GSI_CONFIG_FILE);
  if (!existsSync(path)) return null;
  const vdf = parseVdf(readFileSync(path, "utf8"));
  const root = (vdf[GSI_CONFIG_NAME] ?? vdf[LEGACY_GSI_CONFIG_NAME]) as Record<string, unknown> | undefined;
  const uri = typeof root?.uri === "string" ? root.uri : null;
  const fileToken = (root?.auth as Record<string, unknown> | undefined)?.token;
  if (!uri || fileToken !== token) return null;
  return writeGsiConfig(cfgDir, renderGsiConfig({ uri, token }));
}
