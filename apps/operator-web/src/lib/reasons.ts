import type { ReasonCode } from "@matchframe/contracts";
import { perLocale, t } from "../i18n/index.ts";

export type ReasonTone = "neutral" | "info" | "warn" | "danger" | "ok";

interface ReasonInfo {
  label: string;
  tone: ReasonTone;
  /** One-line explanation for tooltips and the hold-vs-cut panel. */
  hint: string;
}

/**
 * Human-readable labels for every director reason code. The Record type makes the compiler reject
 * a missing code when the contracts gain a new one.
 */
export const REASON_INFO: Record<ReasonCode, ReasonInfo> = perLocale(() => ({
  CURRENT_SHOT_VALID: { label: t("reasons.currentShotStillValid"), tone: "neutral", hint: t("reasons.theShotOnAirStill") },
  CURRENT_SHOT_LOW_ACTION: { label: t("reasons.currentShotLowAction"), tone: "info", hint: t("reasons.littleIsHappeningOnThe") },
  CURRENT_SHOT_INVALID: { label: t("reasons.currentShotInvalid"), tone: "warn", hint: t("reasons.theCurrentShotCanNo") },
  CURRENT_POV_DEAD: { label: t("reasons.currentPovDead"), tone: "warn", hint: t("reasons.theSpectatedPlayerDied") },
  MIN_SHOT_DURATION: { label: t("reasons.minimumShotDuration"), tone: "neutral", hint: t("reasons.holdingUntilTheMinimumShot") },
  ADVANTAGE_BELOW_THRESHOLD: { label: t("reasons.advantageBelowThreshold"), tone: "neutral", hint: t("reasons.theBestAlternativeIsNot") },
  ADVANTAGE_NOT_PERSISTENT: { label: t("reasons.advantageNotYetPersistent"), tone: "neutral", hint: t("reasons.theAlternativeMustStayBetter") },
  CONTACT_LIKELY_SOON: { label: t("reasons.contactLikelySoon"), tone: "info", hint: t("reasons.playersAreConvergingAFight") },
  CONTACT_IMMINENT: { label: t("reasons.contactImminent"), tone: "info", hint: t("reasons.aFightIsExpectedWithin") },
  CT_PUSH_BEFORE_T_EXECUTE: { label: t("reasons.ctPushBeforeTExecute"), tone: "info", hint: t("reasons.ctsArePushingBeforeThe") },
  T_GROUP_DEVELOPING: { label: t("reasons.tGroupDeveloping"), tone: "info", hint: t("reasons.terroristsAreGroupingForA") },
  EXECUTE_DEVELOPING: { label: t("reasons.executeDeveloping"), tone: "info", hint: t("reasons.aSiteExecuteIsForming") },
  CROSSFIRE_SETUP: { label: t("reasons.crossfireSetup"), tone: "info", hint: t("reasons.defendersAreSetUpIn") },
  TRADE_OPPORTUNITY: { label: t("reasons.tradeOpportunity"), tone: "info", hint: t("reasons.aTeammateIsInPosition") },
  POST_EVENT_HOLD: { label: t("reasons.postEventHold"), tone: "neutral", hint: t("reasons.holdingBrieflyAfterAKill") },
  SECOND_CONTACT_LIKELY: { label: t("reasons.secondContactLikely"), tone: "info", hint: t("reasons.anotherFightIsLikelyRight") },
  BOMB_PLANT_PRESSURE: { label: t("reasons.bombPlantPressure"), tone: "info", hint: t("reasons.theBombPlantIsIn") },
  BOMB_DEFUSE_PRESSURE: { label: t("reasons.bombDefusePressure"), tone: "info", hint: t("reasons.aDefuseIsInProgress") },
  BOMB_CRITICAL: { label: t("reasons.bombCritical"), tone: "warn", hint: t("reasons.bombTimerIsInIts") },
  CLUTCH: { label: t("reasons.clutch"), tone: "info", hint: t("reasons.aClutchSituation1vx") },
  RETAKE: { label: t("reasons.retake"), tone: "info", hint: t("reasons.defendersAreRetakingASite") },
  PLAYER_FLASHED: { label: t("reasons.playerFlashed"), tone: "warn", hint: t("reasons.theTargetIsFlashedTheir") },
  PLAYER_RELOADING: { label: t("reasons.playerReloading"), tone: "neutral", hint: t("reasons.theTargetIsReloading") },
  PLAYER_READY: { label: t("reasons.playerReady"), tone: "neutral", hint: t("reasons.theTargetIsReadyTo") },
  ISOLATED_AGGRESSOR: { label: t("reasons.isolatedAggressor"), tone: "info", hint: t("reasons.aLonePlayerIsPushing") },
  UTILITY_INCOMING: { label: t("reasons.utilityIncoming"), tone: "info", hint: t("reasons.grenadeSAboutToTake") },
  UTILITY_CLUSTER_TARGET: { label: t("reasons.utilityHitsAGroup"), tone: "info", hint: t("reasons.utilityIsLandingOnA") },
  UTILITY_VOLLEY: { label: t("reasons.utilityVolley"), tone: "info", hint: t("reasons.severalGrenadesLandTogether") },
  UTILITY_LOW_VALUE: { label: t("reasons.utilityLowValue"), tone: "neutral", hint: t("reasons.theUtilityIsUnlikelyTo") },
  UTILITY_NO_CAMERA: { label: t("reasons.noCameraForUtility"), tone: "warn", hint: t("reasons.noValidatedStaticCameraCovers") },
  CINEMATIC_BUDGET_EXHAUSTED: { label: t("reasons.cinematicBudgetUsed"), tone: "neutral", hint: t("reasons.thePerRoundCinematicBudget") },
  CINEMATIC_DISABLED: { label: t("reasons.cinematicsDisabled"), tone: "neutral", hint: t("reasons.cinematicsAreDisabledForThis") },
  CINEMATIC_ELIGIBLE: { label: t("reasons.cinematicEligible"), tone: "info", hint: t("reasons.aCinematicCameraShotIs") },
  CINEMATIC_INTERRUPTED: { label: t("reasons.cinematicInterrupted"), tone: "warn", hint: t("reasons.aCinematicWasCutShort") },
  OBSERVER_MODE_EXCLUDES: { label: t("reasons.notInThisObserverMode"), tone: "neutral", hint: t("reasons.thisShotTypeIsNot") },
  CAMERA_UNVERIFIED: { label: t("reasons.cameraUnverified"), tone: "warn", hint: t("reasons.theCameraHasNotBeen") },
  COOLDOWN_ACTIVE: { label: t("reasons.cooldownActive"), tone: "neutral", hint: t("reasons.aRecentlyAbandonedShotIs") },
  STALE_DATA: { label: t("reasons.staleData"), tone: "danger", hint: t("reasons.telemetryIsStaleAutomatedDecisions") },
  LOW_CONFIDENCE: { label: t("reasons.lowConfidence"), tone: "warn", hint: t("reasons.theDecisionConfidenceIsLow") },
  MANUAL_OWNERSHIP: { label: t("reasons.manualOwnership"), tone: "warn", hint: t("reasons.theOperatorOwnsTheCamera") },
  EMERGENCY_STOP: { label: t("reasons.emergencyStop"), tone: "danger", hint: t("reasons.automationIsEmergencyStopped") },
  PINNED: { label: t("reasons.pinned"), tone: "info", hint: t("reasons.theOperatorPinnedAPlayer") },
  HOLD_REQUESTED: { label: t("reasons.holdRequested"), tone: "info", hint: t("reasons.theOperatorAskedTheDirector") },
  WALL_SEPARATED: { label: t("reasons.wallSeparated"), tone: "neutral", hint: t("reasons.playersAreSeparatedByGeometry") },
  DISTANCE_CLOSING: { label: t("reasons.distanceClosing"), tone: "info", hint: t("reasons.opponentsAreClosingDistance") },
  MAIN_STORY: { label: t("reasons.mainStory"), tone: "info", hint: t("reasons.partOfTheRoundS") },
  ESTABLISHING: { label: t("reasons.establishingShot"), tone: "neutral", hint: t("reasons.anEstablishingShotToOrient") },
  PAUSE: { label: t("reasons.pauseShot"), tone: "neutral", hint: t("reasons.aTacticalOrTechnicalPause") },
  NO_VALID_CANDIDATE: { label: t("reasons.noValidCandidate"), tone: "warn", hint: t("reasons.noUsableShotWasFound") },
  MAIN_OBSERVER_ON_IT: { label: t("reasons.mainCameraHasThem"), tone: "neutral", hint: t("reasons.replayPcTheMainPc") },
  FOLLOW_CAM: { label: t("reasons.followCam"), tone: "info", hint: t("reasons.aPlayerIsRunningSomewhere") },
  MULTI_FRAG_CHANCE: { label: t("reasons.multiFragChance"), tone: "info", hint: t("reasons.justGotAKillStill") },
  ROUND_WINNERS: { label: t("reasons.roundWinners"), tone: "info", hint: t("reasons.aShortShotOfThe") },
  PISTOL_ROUND: { label: t("reasons.pistolRound"), tone: "info", hint: t("reasons.freezeTimeBeforeAPistol") },
  MATCH_POINT: { label: t("reasons.matchPoint"), tone: "info", hint: t("reasons.aTeamIsOneRound") },
  HALF_TIME: { label: t("reasons.halfTime"), tone: "info", hint: t("reasons.slowShotsOfTheMap") },
  MAP_END: { label: t("reasons.mapEnd"), tone: "info", hint: t("reasons.theEndOfTheMap") },
  CLUTCH_HUNTER_CLOSING: { label: t("reasons.hunterClosingIn"), tone: "info", hint: t("reasons.clutchAShortLook2") },
  CLUTCH_HUNTER_ON_SITE: { label: t("reasons.hunterOnTheClutcherS"), tone: "info", hint: t("reasons.clutchAShortLookAt3") },
  CLUTCH_HUNTER_PLANTING: { label: t("reasons.hunterPlanting"), tone: "info", hint: t("reasons.clutchAShortLookAt2") },
  CLUTCH_HUNTER_DEFUSING: { label: t("reasons.hunterDefusing"), tone: "info", hint: t("reasons.clutchAShortLookAt") },
  CLUTCH_BACK_BEFORE_CONTACT: { label: t("reasons.backToTheClutcher"), tone: "info", hint: t("reasons.clutchAnOpponentIsAbout") },
  CLUTCH_LOOK_OVER: { label: t("reasons.lookOver"), tone: "neutral", hint: t("reasons.clutchTheShortLookAt") },
  FORCE_BUY: { label: t("reasons.forceBuy"), tone: "info", hint: t("reasons.freezeTimeATeamSpent") },
  ECO_VS_FULL_BUY: { label: t("reasons.ecoAgainstAFullBuy"), tone: "info", hint: t("reasons.freezeTimeOneTeamSaves") },
}));

export function reasonInfo(code: string): ReasonInfo {
  return (REASON_INFO as Record<string, ReasonInfo | undefined>)[code] ?? { label: t("reasons.unrecognisedReasonCode", { code }), tone: "neutral", hint: t("reasons.thisReasonCodeIsNewer") };
}

export function reasonLabel(code: string): string {
  return reasonInfo(code).label;
}
