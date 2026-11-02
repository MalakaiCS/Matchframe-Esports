import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentHudId as engineRule } from "../../../../packages/contracts/src/hud.ts";
import { OverlayStore, parseStore } from "./store.ts";
import { currentHudId } from "./validate.ts";

const placement = (x: number) => ({ displayId: 1, bounds: { x, y: 0, width: 1920, height: 1080 }, scale: 1, locked: true, variant: "live" });

describe("desktop HUD settings from 0.11.0 (imported HUDs' old ids)", () => {
  it("follows the engine's rule for an imported HUD's id", () => {
    for (const id of ["lhm.kaihud", "lhm.kaihud-copy-2", `lhm.${"a".repeat(58)}`, `lhm.${"a".repeat(55)}`, "matchframe-default", "imported.kaihud", "team.hud"]) expect(currentHudId(id), id).toBe(engineRule(id));
  });

  it("moves a placement saved under the old id to the HUD's id now; one saved under the new id wins", () => {
    const s = parseStore({ version: 1, overlays: { "lhm.kaihud": placement(10), "matchframe-default": placement(20), "lhm.other": placement(30), "imported.other": placement(40) } });
    expect(Object.keys(s.overlays).sort()).toEqual(["imported.kaihud", "imported.other", "matchframe-default"]);
    expect(s.overlays["imported.kaihud"]!.bounds.x).toBe(10);
    expect(s.overlays["imported.other"]!.bounds.x).toBe(40);
  });

  it("writes the file back with the new ids", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mf-overlays-")), "hud-overlays.json");
    writeFileSync(file, JSON.stringify({ version: 1, overlays: { "lhm.kaihud": placement(10) }, hotkeys: { toggle: "F9", emergencyHide: "F10" } }));
    const store = new OverlayStore(file);
    expect(store.placement("imported.kaihud")!.bounds.x).toBe(10);
    expect(store.placement("lhm.kaihud")).toBeNull();
    store.flush();
    const saved = JSON.parse(readFileSync(file, "utf8")) as { overlays: Record<string, unknown>; hotkeys: Record<string, string> };
    expect(Object.keys(saved.overlays)).toEqual(["imported.kaihud"]);
    expect(saved.hotkeys).toEqual({ toggle: "F9", emergencyHide: "F10" });
  });
});
