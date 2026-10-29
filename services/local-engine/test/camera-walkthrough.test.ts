import { describe, expect, it } from "vitest";
import { MapRegistry } from "@matchframe/map-runtime";
import { syntheticMapPack } from "../../../packages/map-runtime/src/testing.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { CameraWalkthrough } from "../src/live/camera-walkthrough.ts";

function setup(failIds: string[] = []) {
  const db = new Database(":memory:");
  db.migrate();
  const settings = new SettingsRepo(db);
  const maps = new MapRegistry();
  const pack = syntheticMapPack({ withValidatedCamera: true, mapName: "de_test" });
  maps.register(pack);
  const shown: string[] = [];
  let back = 0;
  const session = {
    state: () => ({ mapName: "de_test" }) as never,
    manualCamera: async (id: string) => {
      shown.push(id);
      return (failIds.includes(id) ? { status: "failed", failureReason: "confirmation_timeout", detail: "the camera did not move" } : { status: "confirmed", failureReason: null }) as never;
    },
    returnToPov: async () => {
      back++;
      return null;
    },
  };
  const walk = new CameraWalkthrough({ settings, maps, session });
  return { walk, maps, shown, settings, back: () => back, pack };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("camera walkthrough", () => {
  it("shows the map's cameras one after another, and stops on a player", async () => {
    const { walk, shown, back, pack } = setup();
    const st = walk.start({ secondsPer: 2 });
    expect(st.running).toBe(true);
    expect(st.cameras.map((c) => c.id)).toEqual(pack.cameras.map((c) => c.id));
    await tick(20);
    expect(shown).toEqual([pack.cameras[0]!.id]);
    walk.next();
    await tick(20);
    expect(shown.at(-1)).toBe(pack.cameras[1]?.id ?? pack.cameras[0]!.id);
    await walk.stop();
    expect(walk.status().running).toBe(false);
    expect(back()).toBe(1);
  });

  it("marks a camera that didn't move", async () => {
    const { walk, pack } = setup([syntheticMapPack({ withValidatedCamera: true, mapName: "de_test" }).cameras[0]!.id]);
    walk.start();
    await tick(20);
    expect(walk.status().cameras[0]).toMatchObject({ id: pack.cameras[0]!.id, result: "failed", detail: "the camera did not move" });
    await walk.stop();
  });

  it("hides a camera from the director, keeps the verdict, and shows it again when forgotten", () => {
    const { walk, maps, pack, settings } = setup();
    const cam = pack.cameras.find((c) => c.validation === "validated")!;
    const rt = maps.get("de_test")!;
    expect(rt.cameraUsable(cam)).toBe(true);
    walk.review("de_test", cam.id, "hide");
    expect(rt.cameraUsable(cam)).toBe(false);
    // Remembered: a new walkthrough service (program restart) hides it again, also after the pack is reloaded.
    const again = new CameraWalkthrough({ settings, maps, session: { state: () => null, manualCamera: async () => ({}) as never, returnToPov: async () => null } });
    maps.register(pack);
    expect(maps.get("de_test")!.cameraUsable(cam)).toBe(false);
    expect(again.reviews()).toEqual({ de_test: { [cam.id]: "hide" } });
    again.review("de_test", cam.id, null);
    expect(maps.get("de_test")!.cameraUsable(cam)).toBe(true);
  });

  it("needs a map being played", () => {
    const { settings, maps } = setup();
    const walk = new CameraWalkthrough({ settings, maps, session: { state: () => null, manualCamera: async () => ({}) as never, returnToPov: async () => null } });
    expect(() => walk.start()).toThrow(/no map is being played/);
  });
});
