/**
 * Director configuration. All coefficients and thresholds are initial engineering defaults to be
 * measured and tuned (spec §11.2–11.3); they are not learned results.
 */
export interface DirectorWeights {
  actionCoverage: number;
  imminence: number;
  readiness: number;
  significance: number;
  narrative: number;
  framing: number;
  continuity: number;
  mainStory: number;
}

export const BASELINE_WEIGHTS: DirectorWeights = {
  actionCoverage: 0.28,
  imminence: 0.18,
  readiness: 0.12,
  significance: 0.12,
  narrative: 0.1,
  framing: 0.08,
  continuity: 0.07,
  mainStory: 0.05,
};

export interface DirectorConfig {
  policyVersion: string;
  weights: DirectorWeights;
  /** Analysis cadence upper bound (Hz). */
  maxAnalysisHz: number;
  minShotMs: number;
  advantageThreshold: number;
  persistenceMs: number;
  /** Minimum distinct source sequences the advantage must persist across. */
  persistenceSequences: number;
  postEventHoldMs: number;
  abandonCooldownMs: number;
  baseSwitchCost: number;
  /** Input older than this is stale for decisions (ms). */
  maxInputAgeMs: number;
  /** Positional data older than this is penalized. */
  positionStaleMs: number;
  cinematic: {
    enabled: boolean;
    perRoundBudget: number;
    maxDurationMs: number;
    /** A freeze-time shot is at most this long (the time is shared between shots; the last runs until live). */
    establishingMaxMs: number;
    /** Shots per freeze time (each camera at most once a round). */
    establishingPerRound: number;
    /** Camera paths in freeze time (streamed from Matchframe, less smooth than a camera turning in the game). */
    freezeTimePaths: boolean;
    /** Follow cams per map. */
    followPerMap: number;
    /** No cinematic in the first this-many ms of a live round: first person from the start. */
    liveStartPovMs: number;
    /** Nade cameras: the least utility value for a camera (coordinated utility needs 80 % of it). */
    utilityMinValue: number;
    minValue: number;
    leadMarginMs: number;
    maxUtilityAgeMs: number;
  };
  contact: {
    horizonsSec: number[];
    /** Cap on contact probability without verified visibility geometry. */
    noGeometryCap: number;
    engageRangeUnits: number;
  };
  grouping: {
    teamGroupRadius: number;
    tradeRadius: number;
  };
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  policyVersion: "baseline-1",
  weights: BASELINE_WEIGHTS,
  maxAnalysisHz: 10,
  minShotMs: 2000,
  advantageThreshold: 0.08,
  persistenceMs: 350,
  persistenceSequences: 2,
  postEventHoldMs: 1200,
  abandonCooldownMs: 5000,
  baseSwitchCost: 0.06,
  maxInputAgeMs: 1500,
  positionStaleMs: 600,
  cinematic: {
    enabled: true,
    perRoundBudget: 2,
    maxDurationMs: 3000,
    establishingMaxMs: 14000,
    establishingPerRound: 4,
    freezeTimePaths: false,
    followPerMap: 1,
    liveStartPovMs: 10000,
    utilityMinValue: 0.28,
    minValue: 0.35,
    leadMarginMs: 250,
    maxUtilityAgeMs: 400,
  },
  contact: {
    horizonsSec: [0.5, 1, 2, 3],
    noGeometryCap: 0.75,
    engageRangeUnits: 900,
  },
  grouping: {
    teamGroupRadius: 750,
    tradeRadius: 550,
  },
};

export function mergeConfig(partial: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    ...DEFAULT_DIRECTOR_CONFIG,
    ...partial,
    weights: { ...DEFAULT_DIRECTOR_CONFIG.weights, ...(partial.weights ?? {}) },
    cinematic: { ...DEFAULT_DIRECTOR_CONFIG.cinematic, ...(partial.cinematic ?? {}) },
    contact: { ...DEFAULT_DIRECTOR_CONFIG.contact, ...(partial.contact ?? {}) },
    grouping: { ...DEFAULT_DIRECTOR_CONFIG.grouping, ...(partial.grouping ?? {}) },
  };
}
