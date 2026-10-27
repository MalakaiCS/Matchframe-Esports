import type { Capability } from "@matchframe/contracts";

export interface IntegrationReport {
  gameId: string;
  installed: boolean;
  installPath: string | null;
  configPath: string | null;
  notes: string[];
  problems: string[];
}

export interface SessionContext {
  sessionId: string;
}

export interface NormalizedGameEvent {
  gameId: string;
  kind: string;
  receivedAtMonotonicMs: number;
  payload: unknown;
}

/**
 * Generic game adapter (spec §24). Game-specific data and controls stay out of the generic event
 * and HUD manager. A game is "supported" only when its adapter proves real telemetry.
 */
export interface GameAdapter {
  gameId: string;
  displayName: string;
  discover(): Promise<IntegrationReport>;
  capabilities(): Promise<Capability[]>;
  start(context: SessionContext): Promise<void>;
  subscribe(handler: (event: NormalizedGameEvent) => void): () => void;
  stop(): Promise<void>;
}

/** Expansion roadmap entries — explicitly NOT implemented; shown as unsupported in the UI. */
export const EXPANSION_GAMES = [
  { gameId: "dota2", displayName: "Dota 2", status: "planned" },
  { gameId: "lol", displayName: "League of Legends", status: "planned" },
  { gameId: "valorant", displayName: "Valorant", status: "planned" },
  { gameId: "rocketleague", displayName: "Rocket League", status: "planned" },
  { gameId: "pubgm", displayName: "PUBG Mobile", status: "planned" },
  { gameId: "apex", displayName: "Apex Legends", status: "planned" },
] as const;
