import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { RETIRED_SAMPLE_HUDS } from "../src/hud/library.ts";
import { readDirectory } from "../src/hud/packages.ts";

/**
 * The Pro CS2 HUD and the MatchFrame Sample CS2 HUD left the program (ADR-085): a computer that
 * has them from an earlier version loses them on the next start; what the user imported stays,
 * and broadcast outputs that used one move to the built-in HUD.
 */

function pkg(dir: string, id: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const manifest = { manifestVersion: 1, id, name, version: "1.3.0", author: "Tests", licence: "MIT", game: "cs2", schemaVersions: [1], entryPoints: { live: "index.html" }, permissions: ["match.public"], thumbnail: "thumb.svg", category: "Broadcast", tags: ["test"] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>${name}</title>`);
  writeFileSync(join(dir, "thumb.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function start(dataDir: string, sampleHudsDirs: string[]): Promise<Engine> {
  process.env.MATCHFRAME_LOG_STDOUT = "0";
  const engine = new Engine(loadConfig({ dataDir, gsiPort: await freePort(), apiPort: await freePort(), overlayPort: await freePort(), host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs }));
  await engine.init();
  return engine;
}

describe("bundled HUDs the program no longer brings", () => {
  it("are the Pro CS2 HUD and the MatchFrame Sample CS2 HUD", () => {
    expect([...RETIRED_SAMPLE_HUDS]).toEqual(["matchframe.pro-cs2", "matchframe.sample-cs2"]);
  });

  it("are removed on the next start, with their outputs moved to the built-in HUD; the user's own HUDs stay", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mf-retired-"));
    const bundled = mkdtempSync(join(tmpdir(), "mf-retired-bundled-"));
    pkg(join(bundled, "matchframe-stage"), "test.stage", "Stage stand-in");

    // An earlier version installed the Pro CS2 HUD as a bundled HUD, and the main output used it.
    let engine = await start(dataDir, [bundled]);
    const old = mkdtempSync(join(tmpdir(), "mf-retired-old-"));
    pkg(join(old, "matchframe-pro-cs2"), "matchframe.pro-cs2", "Pro CS2 HUD");
    engine.hudLibrary.installSamples([old]);
    // The user imported their own HUD under the sample HUD's id.
    engine.hudLibrary.importFiles(readDirectory(pkg(join(mkdtempSync(join(tmpdir(), "mf-retired-own-")), "own"), "matchframe.sample-cs2", "My own HUD")));
    engine.outputs.drafts.update("main", { packageId: "matchframe.pro-cs2" });
    engine.outputs.publish("main", "operator");
    const before = engine.hudLibrary.list().huds.map((h) => `${h.id}:${h.kind}`);
    expect(before).toEqual(expect.arrayContaining(["matchframe.pro-cs2:sample", "matchframe.sample-cs2:imported", "test.stage:sample"]));
    const proFolder = engine.hudLibrary.entry("matchframe.pro-cs2").folder!;
    expect(existsSync(proFolder)).toBe(true);
    await engine.shutdown();

    // The new version starts.
    engine = await start(dataDir, [bundled]);
    const ids = engine.hudLibrary.list().huds.map((h) => h.id);
    expect(ids).not.toContain("matchframe.pro-cs2");
    expect(existsSync(proFolder)).toBe(false);
    expect(ids).toContain("matchframe.sample-cs2");
    expect(engine.hudLibrary.entry("matchframe.sample-cs2").name).toBe("My own HUD");
    expect(ids).toContain("test.stage");
    expect(ids).toContain("matchframe-default");
    expect(engine.outputs.published("main")?.data.packageId).toBe("matchframe-default");
    expect(engine.outputs.drafts.require("main").data.packageId).toBe("matchframe-default");
    await engine.shutdown();

    // And it stays gone after that.
    engine = await start(dataDir, [bundled]);
    expect(engine.hudLibrary.list().huds.map((h) => h.id)).not.toContain("matchframe.pro-cs2");
    await engine.shutdown();
  });
});
