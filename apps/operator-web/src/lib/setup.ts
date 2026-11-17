import type { SetupStatus } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** "warn" when done only in a limited way (e.g. simulation). */
  state: "done" | "todo" | "warn";
  detail: string;
  anchor: string;
}

/** Setup checklist derived only from engine-reported facts (nothing is assumed complete). */
export function setupChecklist(s: SetupStatus): ChecklistItem[] {
  const item = (id: string, label: string, done: boolean, detail: string, anchor: string, warn = false): ChecklistItem => ({ id, label, done, state: done ? (warn ? "warn" : "done") : "todo", detail, anchor });
  const vc = s.verifiedControl;
  const scenesMapped = Object.values(s.obs.programScenes ?? {}).filter(Boolean).length;
  return [
    item("cs2", t("lib.cs2Found"), !!s.cs2Install, s.cs2Install ? s.cs2Install.installDir : t("lib.detectItOrEnterThe"), "step-detect"),
    item("payload", t("lib.realGameDataReceived"), s.realPayloadReceived, s.realPayloadReceived ? t("lib.packetsPacketsBuildV", { packets: s.packets, v: s.gameBuild ?? "?" }) : s.simulated ? t("lib.ignoredWhileTheSimulationRuns") : t("lib.writeTheGsiConfigThen"), "step-payload"),
    item("allplayers", t("lib.allPlayerTelemetry"), s.telemetry.allPlayerState === "supported", t("lib.allplayersAllplayerstatePositionsPlayerp", { allPlayerState: s.telemetry.allPlayerState, playerPositions: s.telemetry.playerPositions }), "step-capabilities", s.simulated),
    item("adapter", t("lib.cameraControlAdapterSet"), s.control.adapter !== "none", t("lib.adapterV", { v: s.control.adapter }), "step-adapter", s.control.adapter === "simulation"),
    item("selection", t("lib.playerSelectionVerified"), !!vc.playerSelectionControl, vc.playerSelectionControl ? t("lib.verifiedAtBuildV", { at: vc.playerSelectionControl.at, v: vc.playerSelectionControl.build ?? "?" }) : t("lib.runTheTestWithLive"), "step-selection"),
    item("camera", t("lib.staticCameraConfirmed"), !!vc.staticCameraControl, vc.staticCameraControl ? t("lib.confirmedAt", { at: vc.staticCameraControl.at }) : t("lib.optionalRunTheCameraTest"), "step-camera"),
    item("obs", t("lib.obsConnected"), s.obs.connected, s.obs.connected ? t("lib.sceneCount", { count: s.obs.scenes }) : t("lib.connectObsWebsocketV5"), "step-obs"),
    item("scenes", t("lib.programScenesMapped"), scenesMapped >= 1, t("lib.scenesmappedOf4Mapped", { scenesMapped }), "step-scenes"),
    item("hud", t("lib.hudUrlReady"), !!s.hudUrl, t("lib.addItToObsAs"), "step-hud"),
  ];
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}
