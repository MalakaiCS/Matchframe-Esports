import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hlaeArgs, hlaeInfo, steamRunUrl } from "./game-launch.ts";

describe("Start CS2 (program side)", () => {
  const hlae = join("C:", "Tools", "HLAE", "HLAE.exe");
  const dll = join("C:", "Tools", "HLAE", "x64", "AfxHookSource2.dll");

  it("accepts HLAE.exe only with its CS2 hook next to it", () => {
    expect(hlaeInfo(null).ok).toBe(false);
    expect(hlaeInfo(join("C:", "Tools", "notepad.exe"), () => true).problem).toMatch(/HLAE\.exe/);
    expect(hlaeInfo(hlae, (p) => p === hlae).problem).toMatch(/AfxHookSource2/);
    expect(hlaeInfo(hlae, (p) => p === hlae || p === dll)).toEqual({ path: hlae, ok: true, problem: null });
  });

  it("starts cs2.exe through HLAE's custom loader with the hook and the launch options", () => {
    const args = hlaeArgs(hlae, { cs2Exe: "C:\\CS2\\game\\bin\\win64\\cs2.exe", args: ["-steam", "-insecure", "-tools", "-netconport", "2121"] });
    expect(args.slice(0, 3)).toEqual(["-customLoader", "-noGui", "-autoStart"]);
    expect(args[args.indexOf("-hookDllPath") + 1]).toBe(dll);
    expect(args[args.indexOf("-programPath") + 1]).toBe("C:\\CS2\\game\\bin\\win64\\cs2.exe");
    expect(args[args.indexOf("-cmdLine") + 1]).toBe("-steam -insecure -tools -netconport 2121");
    expect(args.filter((a, i) => args[i - 1] === "-addEnv")).toEqual(["SteamAppId=730", "SteamGameId=730"]);
  });

  it("falls back to Steam links", () => {
    expect(steamRunUrl([])).toBe("steam://rungameid/730");
    expect(steamRunUrl(["-tools", "-netconport", "2121"])).toBe("steam://run/730//-tools%20-netconport%202121/");
  });
});
