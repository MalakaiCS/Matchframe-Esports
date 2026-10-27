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
    item("cs2", "CS2 installation detected", !!s.cs2Install, s.cs2Install ? s.cs2Install.installDir : "Run detection or enter the CS2 folder manually.", "step-detect"),
    item("payload", "Real GSI payload received", s.realPayloadReceived, s.realPayloadReceived ? `${s.packets} packets · build ${s.gameBuild ?? "?"}` : s.simulated ? "Simulation running — real packets are ignored until it stops." : "Write the GSI config, then restart CS2 and join as spectator/observer.", "step-payload"),
    item("allplayers", "All-player telemetry", s.telemetry.allPlayerState === "supported", `allplayers: ${s.telemetry.allPlayerState}, positions: ${s.telemetry.playerPositions}`, "step-capabilities", s.simulated),
    item("adapter", "Observer control adapter configured", s.control.adapter !== "none", `adapter: ${s.control.adapter}`, "step-adapter", s.control.adapter === "simulation"),
    item("selection", "Player selection verified on a real client", !!vc.playerSelectionControl, vc.playerSelectionControl ? `verified ${vc.playerSelectionControl.at} (build ${vc.playerSelectionControl.build ?? "?"})` : "Run the player-selection test with live telemetry.", "step-selection"),
    item("camera", "Static camera confirmed by an operator", !!vc.staticCameraControl, vc.staticCameraControl ? `confirmed ${vc.staticCameraControl.at}` : "Optional: run the static camera test and confirm the view.", "step-camera"),
    item("obs", "OBS connected", s.obs.connected, s.obs.connected ? `${s.obs.scenes} scenes` : "Connect obs-websocket (v5).", "step-obs"),
    item("scenes", "Program scenes mapped", scenesMapped >= 1, `${scenesMapped}/4 program modes mapped to OBS scenes`, "step-scenes"),
    item("hud", "Main HUD URL available", !!s.hudUrl, "Add it to OBS as a 1920×1080 browser source.", "step-hud"),
  ];
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}
