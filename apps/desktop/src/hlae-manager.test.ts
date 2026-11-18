import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { LaunchResult } from "./game-launch.ts";
import { CHECK_EVERY_MS, compareVersions, createHlaeManager, FORCED_CHECK_MS, HLAE_RELEASES_API, launchWithHlae, parseHlaeVersion, pickHlaeRelease, unpackHlae, type HlaeSettings, type HlaeUpdate } from "./hlae-manager.ts";

/**
 * The program's own HLAE (ADR-084) against a stand-in GitHub (no network): which release asset is
 * taken, the SHA-256 check, the unpacking, updates and their timing, and Start CS2 with a retry.
 */

const BASE = "https://github.com/advancedfx/advancedfx/releases/download";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function hlaeZip(opts: { top?: string; hook?: boolean; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const top = opts.top ?? "";
  return zipSync({
    [`${top}HLAE.exe`]: strToU8("hlae exe"),
    [`${top}injector.exe`]: strToU8("injector"),
    ...(opts.hook === false ? {} : { [`${top}x64/AfxHookSource2.dll`]: strToU8("hook") }),
    [`${top}resources/afx-cefhud-interop.txt`]: strToU8("res"),
    ...opts.extra,
  });
}

function release(version: string, zip: Uint8Array, opts: { digest?: string | null; prerelease?: boolean; url?: string; name?: string } = {}) {
  const tag = `v${version}`;
  const name = opts.name ?? `hlae_${version.replace(/\./g, "_")}.zip`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: opts.prerelease ?? false,
    published_at: "2026-11-06T23:30:00Z",
    assets: [
      { name: "HLAE_Setup.exe", browser_download_url: `${BASE}/${tag}/HLAE_Setup.exe`, size: 10, digest: `sha256:${"0".repeat(64)}` },
      { name, browser_download_url: opts.url ?? `${BASE}/${tag}/${name}`, size: zip.length, ...(opts.digest === null ? {} : { digest: opts.digest ?? `sha256:${sha(zip)}` }) },
    ],
  };
}

/** A stand-in GitHub: the latest release and its files; counts the release checks. */
function github(initial: { json: unknown; files: Record<string, Uint8Array> }) {
  const state = { ...initial, apiCalls: 0, status: 200 };
  const fetch = async (url: string): Promise<Response> => {
    if (url === HLAE_RELEASES_API) {
      state.apiCalls++;
      return state.status === 200 ? new Response(JSON.stringify(state.json), { status: 200 }) : new Response("{}", { status: state.status });
    }
    const body = state.files[url];
    return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } }) : new Response("missing", { status: 404 });
  };
  return { state, fetch };
}

function setup(gh: ReturnType<typeof github>, settings: Partial<HlaeSettings> = {}) {
  const root = join(mkdtempSync(join(tmpdir(), "mf-hlae-")), "hlae-program");
  let s: HlaeSettings = { hlaePath: null, hlaeManaged: null, hlaeAutoUpdate: true, ...settings };
  const clock = { now: Date.parse("2026-11-18T12:00:00Z") };
  const cs2 = { running: false };
  const m = createHlaeManager({
    root,
    fetch: gh.fetch,
    now: () => clock.now,
    read: () => s,
    write: (patch) => (s = { ...s, ...patch }),
    cs2Running: async () => cs2.running,
  });
  return { m, root, clock, cs2, settings: () => s };
}

function ghWith(version: string, zip = hlaeZip({ top: `hlae_${version.replace(/\./g, "_")}/` })) {
  const rel = release(version, zip);
  return github({ json: rel, files: { [rel.assets[1]!.browser_download_url]: zip } });
}

describe("which HLAE release is used", () => {
  it("reads plain version tags and orders versions", () => {
    expect(parseHlaeVersion("v2.193.0")).toBe("2.193.0");
    expect(parseHlaeVersion("2.192.10")).toBe("2.192.10");
    expect(parseHlaeVersion("v2.193.0-rc1")).toBeNull();
    expect(compareVersions("2.192.10", "2.192.9")).toBe(1);
    expect(compareVersions("2.193.0", "2.193")).toBe(0);
    expect(compareVersions("2.190.2", "2.193.0")).toBe(-1);
  });

  it("takes the release's HLAE ZIP and GitHub's SHA-256 for it, not the setup program", () => {
    const zip = hlaeZip();
    const r = pickHlaeRelease(release("2.193.0", zip));
    expect("release" in r && r.release).toMatchObject({ version: "2.193.0", tag: "v2.193.0", zip: { name: "hlae_2_193_0.zip", sha256: sha(zip), url: `${BASE}/v2.193.0/hlae_2_193_0.zip` } });
  });

  it("refuses a release it can't check or that isn't advancedfx's own", () => {
    const zip = hlaeZip();
    expect(pickHlaeRelease(release("2.193.0", zip, { digest: null }))).toEqual({ problem: expect.stringContaining("no checksum") });
    expect(pickHlaeRelease(release("2.193.0", zip, { prerelease: true }))).toHaveProperty("problem");
    expect(pickHlaeRelease(release("2.193.0", zip, { url: "https://example.com/hlae_2_193_0.zip" }))).toEqual({ problem: expect.stringContaining("no HLAE ZIP") });
    expect(pickHlaeRelease(release("2.193.0", zip, { name: "sources.zip" }))).toHaveProperty("problem");
    expect(pickHlaeRelease({ message: "Not Found" })).toHaveProperty("problem");
  });
});

describe("unpacking HLAE", () => {
  it("keeps the folder holding HLAE.exe, with or without a top folder in the ZIP", () => {
    for (const top of ["", "hlae_2_193_0/"]) {
      const dest = mkdtempSync(join(tmpdir(), "mf-hlae-unpack-"));
      const exe = unpackHlae(hlaeZip({ top }), dest, "2.193.0");
      expect(exe).toBe(join(dest, "HLAE.exe"));
      expect(readFileSync(join(dest, "x64", "AfxHookSource2.dll"), "utf8")).toBe("hook");
      expect(existsSync(join(dest, "resources", "afx-cefhud-interop.txt"))).toBe(true);
    }
  });

  it("refuses a ZIP without the CS2 hook, a broken ZIP, and names that leave the folder", () => {
    const dest = mkdtempSync(join(tmpdir(), "mf-hlae-unpack-"));
    expect(() => unpackHlae(hlaeZip({ hook: false }), dest, "2.193.0")).toThrow(/AfxHookSource2\.dll/);
    expect(() => unpackHlae(strToU8("not a zip"), dest, "2.193.0")).toThrow(/couldn't be opened/);
    expect(() => unpackHlae(hlaeZip({ extra: { "../evil.dll": strToU8("x") } }), dest, "2.193.0")).toThrow(/outside its folder/);
    expect(existsSync(join(dest, "..", "evil.dll"))).toBe(false);
  });
});

describe("Get HLAE", () => {
  it("downloads, checks and selects the latest HLAE", async () => {
    const gh = ghWith("2.193.0");
    const { m, root, settings } = setup(gh, { hlaePath: "C:\\old\\HLAE.exe" });
    const got = await m.get();
    expect(got.version).toBe("2.193.0");
    expect(got.exe).toBe(join(root, "2.193.0", "HLAE.exe"));
    expect(settings().hlaePath).toBe(got.exe);
    expect(settings().hlaeManaged).toEqual(got);
    expect(readFileSync(join(root, "2.193.0", "x64", "AfxHookSource2.dll"), "utf8")).toBe("hook");
    expect(m.status()).toMatchObject({ inUse: true, busy: null, latest: "2.193.0", error: null });
  });

  it("installs nothing when the download doesn't match GitHub's checksum", async () => {
    const zip = hlaeZip();
    const rel = release("2.193.0", zip, { digest: `sha256:${sha(strToU8("something else"))}` });
    const gh = github({ json: rel, files: { [rel.assets[1]!.browser_download_url]: zip } });
    const { m, root, settings } = setup(gh);
    await expect(m.get()).rejects.toThrow(/doesn't match GitHub's checksum/);
    expect(existsSync(join(root, "2.193.0"))).toBe(false);
    expect(settings().hlaeManaged).toBeNull();
    expect(m.status().error).toMatch(/checksum/);
  });

  it("waits for CS2 to close, and says when GitHub limits requests", async () => {
    const gh = ghWith("2.193.0");
    const a = setup(gh);
    a.cs2.running = true;
    await expect(a.m.get()).rejects.toThrow(/Close CS2 first/);
    gh.state.status = 403;
    const b = setup(gh);
    await expect(b.m.get()).rejects.toThrow(/limiting requests/);
  });

  it("selects the HLAE already installed again instead of downloading it twice", async () => {
    const gh = ghWith("2.193.0");
    const { m, settings, clock } = setup(gh);
    const first = await m.get();
    // The operator chose another HLAE.exe in between.
    const other = settings();
    Object.assign(other, { hlaePath: "D:\\HLAE\\HLAE.exe" });
    clock.now += FORCED_CHECK_MS + 1;
    gh.state.files = {};
    expect(await m.get()).toEqual(first);
    expect(settings().hlaePath).toBe(first.exe);
  });
});

describe("keeping HLAE up to date", () => {
  async function installed(version: string) {
    const gh = ghWith(version);
    const env = setup(gh);
    await env.m.get();
    return { gh, ...env };
  }

  function publish(gh: ReturnType<typeof github>, version: string) {
    const zip = hlaeZip({ top: `hlae_${version.replace(/\./g, "_")}/` });
    const rel = release(version, zip);
    gh.state.json = rel;
    gh.state.files[rel.assets[1]!.browser_download_url] = zip;
  }

  it("does nothing for an HLAE the operator chose", async () => {
    const { m } = setup(ghWith("2.193.0"), { hlaePath: "D:\\HLAE\\HLAE.exe" });
    expect(await m.update()).toEqual({ updated: false, reason: "not_in_use", version: null });
  });

  it("installs a newer release, keeps the one before, and drops older ones", async () => {
    const { gh, m, root, clock, settings } = await installed("2.192.10");
    publish(gh, "2.193.0");
    clock.now += CHECK_EVERY_MS + 1;
    expect(await m.update()).toEqual({ updated: true, from: "2.192.10", to: "2.193.0" });
    expect(settings().hlaePath).toBe(join(root, "2.193.0", "HLAE.exe"));
    publish(gh, "2.193.1");
    clock.now += CHECK_EVERY_MS + 1;
    expect(await m.update()).toMatchObject({ updated: true, to: "2.193.1" });
    expect(existsSync(join(root, "2.193.1"))).toBe(true);
    expect(existsSync(join(root, "2.193.0"))).toBe(true);
    expect(existsSync(join(root, "2.192.10"))).toBe(false);
  });

  it("asks GitHub at most every 30 minutes, and every minute when forced", async () => {
    const { gh, m, clock } = await installed("2.193.0");
    const calls = gh.state.apiCalls;
    expect(await m.update()).toMatchObject({ updated: false, reason: "latest" });
    expect(gh.state.apiCalls).toBe(calls);
    clock.now += FORCED_CHECK_MS + 1;
    await m.update({ force: true });
    expect(gh.state.apiCalls).toBe(calls + 1);
    await m.update({ force: true });
    expect(gh.state.apiCalls).toBe(calls + 1);
    clock.now += CHECK_EVERY_MS + 1;
    await m.update();
    expect(gh.state.apiCalls).toBe(calls + 2);
  });

  it("never updates while CS2 runs, respects the setting, and keeps the HLAE it has when GitHub fails", async () => {
    const { gh, m, cs2, clock, settings } = await installed("2.193.0");
    publish(gh, "2.193.1");
    clock.now += CHECK_EVERY_MS + 1;
    cs2.running = true;
    expect(await m.update()).toMatchObject({ updated: false, reason: "cs2_running" });
    cs2.running = false;
    m.setAutoUpdate(false);
    expect(await m.update()).toMatchObject({ updated: false, reason: "off" });
    m.setAutoUpdate(true);
    gh.state.status = 500;
    expect(await m.update()).toMatchObject({ updated: false, reason: "error", error: expect.stringContaining("500"), version: "2.193.0" });
    expect(settings().hlaeManaged?.version).toBe("2.193.0");
  });

  it("clears half-written folders from earlier attempts", async () => {
    const { gh, m, root, clock } = await installed("2.193.0");
    for (const v of ["2.193.1", "2.190.0"]) {
      mkdirSync(join(root, `${v}.part`), { recursive: true });
      writeFileSync(join(root, `${v}.part`, "junk"), "x");
    }
    publish(gh, "2.193.1");
    clock.now += CHECK_EVERY_MS + 1;
    await m.update();
    expect(existsSync(join(root, "2.193.1.part"))).toBe(false);
    expect(existsSync(join(root, "2.190.0.part"))).toBe(false);
    expect(existsSync(join(root, "2.193.1", "HLAE.exe"))).toBe(true);
  });
});

describe("Start CS2 with the program's HLAE", () => {
  const ok: LaunchResult = { ok: true, message: "Starting CS2 with HLAE." };
  const failed: LaunchResult = { ok: false, hlaeFailed: true, message: "HLAE 2.193.0 couldn't start CS2 (exit code 5)." };

  function manager(results: HlaeUpdate[], inUse = true) {
    const calls: { force?: boolean; manual?: boolean }[] = [];
    return {
      calls,
      inUse: () => inUse,
      update: async (o: { force?: boolean; manual?: boolean } = {}) => {
        calls.push(o);
        return results.shift() ?? { updated: false as const, reason: "latest" as const, version: "2.193.0" };
      },
    };
  }

  it("just starts in another mode or with a chosen HLAE", async () => {
    const m = manager([]);
    expect(await launchWithHlae({ hlaeMode: false, manager: m, start: async () => ok })).toEqual(ok);
    const chosen = manager([], false);
    expect(await launchWithHlae({ hlaeMode: true, manager: chosen, start: async () => ok })).toEqual(ok);
    expect(m.calls.length + chosen.calls.length).toBe(0);
  });

  it("installs a newer HLAE first and says so", async () => {
    const m = manager([{ updated: true, from: "2.192.10", to: "2.193.0" }]);
    const r = await launchWithHlae({ hlaeMode: true, manager: m, start: async () => ok });
    expect(r).toEqual({ ok: true, message: `HLAE updated from 2.192.10 to 2.193.0. ${ok.message}` });
  });

  it("after a failure, checks straight away and starts once more with the newer HLAE", async () => {
    const m = manager([{ updated: false, reason: "latest", version: "2.193.0" }, { updated: true, from: "2.193.0", to: "2.193.1" }]);
    const starts: LaunchResult[] = [failed, ok];
    const r = await launchWithHlae({ hlaeMode: true, manager: m, start: async () => starts.shift()! });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^HLAE 2\.193\.0 couldn't start CS2, so MatchFrame installed HLAE 2\.193\.1/);
    expect(m.calls).toEqual([{}, { force: true, manual: true }]);
  });

  it("says when no newer HLAE is out yet, or why it couldn't look", async () => {
    const none = await launchWithHlae({ hlaeMode: true, manager: manager([{ updated: false, reason: "latest", version: "2.193.0" }, { updated: false, reason: "latest", version: "2.193.0" }]), start: async () => failed });
    expect(none.ok).toBe(false);
    expect(none.message).toContain("No HLAE newer than 2.193.0 is out yet");
    expect(none.message).toContain("Standard mode");
    const offline = await launchWithHlae({ hlaeMode: true, manager: manager([{ updated: false, reason: "latest", version: "2.193.0" }, { updated: false, reason: "error", error: "offline", version: "2.193.0" }]), start: async () => failed });
    expect(offline.message).toContain("couldn't look for a newer HLAE: offline");
  });

  it("doesn't retry when CS2 didn't start for another reason", async () => {
    const m = manager([]);
    const steam: LaunchResult = { ok: false, message: "Start Steam first." };
    expect(await launchWithHlae({ hlaeMode: true, manager: m, start: async () => steam })).toEqual(steam);
    expect(m.calls).toEqual([{}]);
  });
});
