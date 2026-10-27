import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCs2, GSI_CONFIG_FILE, parseVdf, renderGsiConfig, writeGsiConfig } from "../src/index.ts";

describe("VDF", () => {
  it("parses nested KeyValues with comments and escapes", () => {
    const v = parseVdf(`// comment\n"libraryfolders"\n{\n "0"\n {\n  "path" "C:\\\\Program Files (x86)\\\\Steam"\n  "apps" { "730" "123" }\n }\n}`);
    expect((v.libraryfolders as Record<string, Record<string, string>>)["0"]!.path).toBe("C:\\Program Files (x86)\\Steam");
  });
});

describe("CS2 discovery", () => {
  it("finds CS2 in a secondary Steam library", () => {
    const files: Record<string, string> = {
      "/home/u/.steam/steam/steamapps/libraryfolders.vdf": `"libraryfolders" { "0" { "path" "/home/u/.steam/steam" } "1" { "path" "/games/lib2" } }`,
      "/games/lib2/steamapps/appmanifest_730.acf": `"AppState" { "appid" "730" "installdir" "Counter-Strike Global Offensive" "buildid" "20000000" }`,
    };
    const dirs = new Set(["/home/u/.steam/steam", "/games/lib2/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg"]);
    const r = discoverCs2({ platform: "linux", exists: (p) => p in files || dirs.has(p), read: (p) => files[p]!, home: "/home/u", env: {} });
    expect(r.install?.cfgDir).toBe("/games/lib2/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg");
    expect(r.install?.gameBuildFromManifest).toBe("20000000");
  });

  it("reports a clear problem when Steam is missing", () => {
    const r = discoverCs2({ platform: "linux", exists: () => false, read: () => "", home: "/x", env: {} });
    expect(r.install).toBeNull();
    expect(r.problems.join(" ")).toMatch(/Steam installation not found/);
  });
});

describe("GSI config", () => {
  it("renders a parseable config with the token and requested components", () => {
    const text = renderGsiConfig({ uri: "http://127.0.0.1:37210/gsi", token: "abcdef0123456789" });
    const v = parseVdf(text);
    const root = v["Matchframe Esports"] as Record<string, Record<string, string>>;
    expect(root.auth!.token).toBe("abcdef0123456789");
    expect(root.data!.allgrenades).toBe("1");
  });

  it("writes its own file only, backs up a changed version, and leaves other configs untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-gsi-"));
    writeFileSync(join(dir, "gamestate_integration_other.cfg"), "other app");
    const a = writeGsiConfig(dir, renderGsiConfig({ uri: "http://127.0.0.1:37210/gsi", token: "aaaaaaaa" }));
    expect(a.written).toBe(true);
    const same = writeGsiConfig(dir, renderGsiConfig({ uri: "http://127.0.0.1:37210/gsi", token: "aaaaaaaa" }));
    expect(same.unchanged).toBe(true);
    const b = writeGsiConfig(dir, renderGsiConfig({ uri: "http://127.0.0.1:37210/gsi", token: "bbbbbbbb" }));
    expect(b.backup).not.toBeNull();
    expect(readFileSync(join(dir, "gamestate_integration_other.cfg"), "utf8")).toBe("other app");
    expect(readdirSync(dir).filter((f) => f === GSI_CONFIG_FILE)).toHaveLength(1);
  });

  it("rejects values that could break the config", () => {
    expect(() => renderGsiConfig({ uri: 'http://x" }', token: "aaaaaaaa" })).toThrow();
    expect(() => renderGsiConfig({ uri: "http://x", token: "not hex!" })).toThrow();
  });
});
