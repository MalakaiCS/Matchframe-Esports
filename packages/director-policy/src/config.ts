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
  /**
   * Multi-frag awareness: a player who got a kill in the last `windowMs`, still alive with enemies
   * within `rangeUnits`, is worth staying on (or cutting to): more kills often follow. A cut to them
   * only happens while the POV on air has imminence below `leaveBelowImminence`. Off: no boost.
   */
  multiFrag: { enabled: boolean; windowMs: number; rangeUnits: number; leaveBelowImminence: number };
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
    /** Camera paths in freeze time, half time and map end (the Auto Director turns this on while HLAE plays the camera; over the console they judder). */
    freezeTimePaths: boolean;
    /**
     * Freeze times differ from round to round: sometimes one longer shot of one team, no team shot of
     * a team on an eco, team shots from high up, low or from the side. Off: both teams every round.
     */
    variety: boolean;
    /** A short shot of the winners after the round (2 s after it ends): after every round, big rounds only, or never. */
    winnerShots: "every_round" | "big_rounds" | "off";
    /** Shots for big moments: the pistol-round opener, the team on match point first, half time and the map's end. */
    bigMoments: boolean;
    /**
     * Freeze-time shots that tell the buy story (see BuyTracker): a team on a force buy last, close
     * enough to see its pistols or SMGs; an eco against a full buy, both teams with the full buy last.
     */
    buyStories: boolean;
    /** Rounds in regulation (MR12: 24) and in each overtime (6), for match point and half time. */
    regulationRounds: number;
    overtimeRounds: number;
    /** No cinematic in the first this-many ms of a live round: first person from the start. */
    liveStartPovMs: number;
    /** Nade cameras: the least utility value for a camera (coordinated utility needs 80 % of it). */
    utilityMinValue: number;
    /**
     * A nade camera, once on air, stays at least this long (ms), however soon the grenade goes off
     * (only bomb urgency cuts away sooner), and runs until about `utilityAfterEffectMs` after it.
     */
    utilityHoldMs: number;
    utilityAfterEffectMs: number;
    minValue: number;
    leadMarginMs: number;
    maxUtilityAgeMs: number;
  };
  /**
   * Clutch direction, with clutch mode on (see ClutchDirector): the clutcher's view is the default; a
   * short look at a hunter who is about to matter, back to the clutcher before contact.
   */
  clutch: {
    /** Off: the clutcher only, as before. */
    hunterLooks: boolean;
    /** Time on the clutcher before a look at a hunter walking in or onto their site, and before a plant or defuse. */
    clutcherMinMs: number;
    objectiveMinMs: number;
    /** A look lasts this long at least and at most (contact, or the clutcher's own plant or defuse, end it sooner). */
    lookMinMs: number;
    lookMaxMs: number;
    /** The same hunter is looked at again only after this long. */
    hunterCooldownMs: number;
    /** A hunter walking in: within this walking distance (units on the map's grid), closing at least this fast (units a second). */
    closingRange: number;
    closingSpeed: number;
    /** ...and reaching contact range in this many seconds. */
    etaMinSec: number;
    etaMaxSec: number;
    /** Contact range: a hunter this close (walking) is about to meet the clutcher. */
    contactRange: number;
    /** With less time than this left (round clock, or the bomb once planted), only a plant or defuse gets a look. */
    lowTimeSec: number;
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
  multiFrag: { enabled: true, windowMs: 4000, rangeUnits: 1600, leaveBelowImminence: 0.5 },
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
    variety: true,
    winnerShots: "every_round",
    bigMoments: true,
    buyStories: true,
    regulationRounds: 24,
    overtimeRounds: 6,
    liveStartPovMs: 10000,
    utilityMinValue: 0.28,
    utilityHoldMs: 2500,
    utilityAfterEffectMs: 2000,
    minValue: 0.35,
    leadMarginMs: 250,
    maxUtilityAgeMs: 400,
  },
  clutch: {
    hunterLooks: true,
    clutcherMinMs: 4000,
    objectiveMinMs: 2000,
    lookMinMs: 2000,
    lookMaxMs: 4000,
    hunterCooldownMs: 10000,
    closingRange: 1800,
    closingSpeed: 120,
    etaMinSec: 2.5,
    etaMaxSec: 7,
    contactRange: 450,
    lowTimeSec: 8,
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
    clutch: { ...DEFAULT_DIRECTOR_CONFIG.clutch, ...(partial.clutch ?? {}) },
    contact: { ...DEFAULT_DIRECTOR_CONFIG.contact, ...(partial.contact ?? {}) },
    grouping: { ...DEFAULT_DIRECTOR_CONFIG.grouping, ...(partial.grouping ?? {}) },
  };
}
