import { describe, expect, it } from "vitest";
import type { CameraRecord } from "@matchframe/contracts";
import { MapRegistry } from "@matchframe/map-runtime";
import { syntheticMapPack } from "../../../packages/map-runtime/src/testing.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { CameraCapture } from "../src/live/camera-capture.ts";

function setup(adapter: unknown, mapName: string | null = "de_test") {
  const db = new Database(":memory:");
  db.migrate();
  const settings = new SettingsRepo(db);
  const maps = new MapRegistry();
  maps.register(syntheticMapPack({ withValidatedCamera: true, mapName: "de_test" }));
  const applied: string[] = [];
  const capture = new CameraCapture({ session: { state: () => ({ mapName }), arbiter: { getAdapter: () => adapter } }, maps, settings, applyOverrides: (m) => applied.push(m) });
  return { capture, settings, applied };
}

describe("save the CS2 view as a camera", () => {
  it("saves where the camera is in CS2 as one of your cameras, checked, for freeze time and fights", async () => {
    const pose = { position: { x: 100, y: 200, z: 300 }, pitch: 20, yaw: 45 };
    const { capture, settings, applied } = setup({ readPose: async () => pose });
    const cam = await capture.capture();
    expect(cam).toMatchObject({ id: "mine-1", mapName: "de_test", position: pose.position, pitch: 20, yaw: 45, validation: "validated", capturedFrom: "netcon_readback" });
    expect(cam.displayName).toMatch(/^My camera 1/);
    expect(cam.actionClasses.sort()).toEqual(["establishing", "tactical"]);
    expect(cam.allowedPhases.sort()).toEqual(["freezetime", "live"]);
    // Its focus is straight ahead of the lens (down and to +x/+y here).
    expect(cam.coverage.center.x).toBeGreaterThan(100);
    expect(cam.coverage.center.y).toBeGreaterThan(200);
    expect(cam.coverage.center.z).toBeLessThan(300);
    expect(applied).toEqual(["de_test"]);
    const second = await capture.capture({ displayName: "Long corner" });
    expect(second).toMatchObject({ id: "mine-2", displayName: "Long corner" });
    expect(settings.get<CameraRecord[]>("cameras.de_test", []).map((c) => c.id)).toEqual(["mine-1", "mine-2"]);
  });

  it("says what is missing: the CS2 console, a map, or an answer from CS2", async () => {
    await expect(setup(null).capture.capture()).rejects.toThrow(/CS2 console/);
    await expect(setup({ readPose: async () => null }, null).capture.capture()).rejects.toThrow(/no map/);
    await expect(setup({ readPose: async () => null }).capture.capture()).rejects.toThrow(/did not answer getpos/);
  });
});
