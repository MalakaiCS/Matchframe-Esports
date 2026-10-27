import type { SetupStatus } from "../api/types.ts";

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
    item("cs2", "CS2 found", !!s.cs2Install, s.cs2Install ? s.cs2Install.installDir : "Detect it or enter the folder.", "step-detect"),
    item("payload", "Real game data received", s.realPayloadReceived, s.realPayloadReceived ? `${s.packets} packets · build ${s.gameBuild ?? "?"}` : s.simulated ? "Ignored while the simulation runs." : "Write the GSI config, then restart CS2.", "step-payload"),
    item("allplayers", "All-player telemetry", s.telemetry.allPlayerState === "supported", `allplayers: ${s.telemetry.allPlayerState}, positions: ${s.telemetry.playerPositions}`, "step-capabilities", s.simulated),
    item("adapter", "Camera control adapter set", s.control.adapter !== "none", `adapter: ${s.control.adapter}`, "step-adapter", s.control.adapter === "simulation"),
    item("selection", "Player selection verified", !!vc.playerSelectionControl, vc.playerSelectionControl ? `verified ${vc.playerSelectionControl.at} (build ${vc.playerSelectionControl.build ?? "?"})` : "Run the test with live game data.", "step-selection"),
    item("camera", "Static camera confirmed", !!vc.staticCameraControl, vc.staticCameraControl ? `confirmed ${vc.staticCameraControl.at}` : "Optional: run the camera test.", "step-camera"),
    item("obs", "OBS connected", s.obs.connected, s.obs.connected ? `${s.obs.scenes} scenes` : "Connect obs-websocket (v5).", "step-obs"),
    item("scenes", "Program scenes mapped", scenesMapped >= 1, `${scenesMapped} of 4 mapped`, "step-scenes"),
    item("hud", "HUD URL ready", !!s.hudUrl, "Add it to OBS as a browser source.", "step-hud"),
  ];
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}
