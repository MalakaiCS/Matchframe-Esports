import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Database } from "../../../services/local-engine/src/db/database.ts";
import { MIGRATIONS, type Migration } from "../../../services/local-engine/src/db/migrations.ts";
import { AuditRepo } from "../../../services/local-engine/src/db/store.ts";
import * as dataSafety from "../../../services/local-engine/src/db/version-backups.ts";
import { confirmation, createRollback, downloadVerified, parseChecksums, RELEASES_API, selectRollbackReleases, type Confirmation, type RollbackDeps, type RollbackProgress } from "./rollback.ts";

/**
 * Go back to a previous version against a stand-in GitHub release feed (no network): which releases
 * are offered, the SHA-256 check of the download, and the whole flow on a real data folder (made by
 * the 0.11.0 engine, fixtures/upgrade-0.11.0, then updated as the program would).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = join(here, "..", "..", "..", "fixtures", "upgrade-0.11.0", "appdata", "Matchframe Esports", "matchframe.sqlite");
const BASE = "https://github.com/MalakaiCS/Matchframe-Esports/releases/download";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function release(version: string, opts: { prerelease?: boolean; draft?: boolean; installer?: string | null; sums?: boolean } = {}) {
  const tag = `v${version}`;
  const installer = opts.installer === undefined ? `MatchFrameEsports-Setup-${version}.exe` : opts.installer;
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: "2026-11-01T00:00:00Z",
    html_url: `https://github.com/MalakaiCS/Matchframe-Esports/releases/tag/${tag}`,
    assets: [
      ...(installer ? [{ name: installer, browser_download_url: `${BASE}/${tag}/${installer}`, size: 100 }] : []),
      ...(opts.sums === false ? [] : [{ name: "SHA256SUMS.txt", browser_download_url: `${BASE}/${tag}/SHA256SUMS.txt`, size: 200 }]),
      { name: "latest.yml", browser_download_url: `${BASE}/${tag}/latest.yml`, size: 300 },
    ],
  };
}

/** A stand-in for GitHub: the releases API and each release's files. */
function standInGitHub(releases: unknown[], files: Record<string, Buffer | string>) {
  const requested: string[] = [];
  const fetch: RollbackDeps["fetch"] = async (url) => {
    requested.push(url);
    if (url === RELEASES_API) return Response.json(releases);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { "content-length": String(Buffer.byteLength(body)) } });
  };
  return { fetch, requested };
}

describe("which earlier versions are offered", () => {
  it("earlier Stable releases with an installer and checksums, newest first", () => {
    const feed = [
      release("0.13.0"),
      release("0.13.0-beta.1", { prerelease: true }),
      release("0.12.5", { prerelease: true }),
      release("0.12.4"),
      release("0.12.3", { draft: true }),
      release("0.12.2", { sums: false }),
      release("0.12.1", { installer: null }),
      release("0.12.10"),
      release("0.2.0", { installer: "MatchframeEsports-Setup-0.2.0.exe" }),
      { tag_name: "not-a-version", assets: [] },
    ];
    const out = selectRollbackReleases(feed, "0.13.0");
    expect(out.map((r) => r.version)).toEqual(["0.12.10", "0.12.4", "0.2.0"]);
    expect(out[1]).toMatchObject({ tag: "v0.12.4", installer: { name: "MatchFrameEsports-Setup-0.12.4.exe", url: `${BASE}/v0.12.4/MatchFrameEsports-Setup-0.12.4.exe` }, checksumsUrl: `${BASE}/v0.12.4/SHA256SUMS.txt` });
    // From a beta, the Stable releases before it (its own Stable release isn't out yet).
    expect(selectRollbackReleases(feed, "0.13.0-beta.2").map((r) => r.version)).toEqual(["0.12.10", "0.12.4", "0.2.0"]);
    expect(selectRollbackReleases(feed, "0.13.0", 1)).toHaveLength(1);
    expect(() => selectRollbackReleases({ message: "rate limited" }, "0.13.0")).toThrow();
  });
});

describe("checksums", () => {
  it("reads SHA256SUMS.txt as the release workflow writes it", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseChecksums(`\uFEFF${a}  MatchFrameEsports-Setup-0.12.4.exe\r\n${b} *MatchFrameEsports-0.12.4-win.zip\r\nnonsense\n`);
    expect(sums.get("matchframeesports-setup-0.12.4.exe")).toBe(a);
    expect(sums.get("matchframeesports-0.12.4-win.zip")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  it("keeps a download that matches and deletes one that doesn't", async () => {
    const [r] = selectRollbackReleases([release("0.12.4")], "0.13.0");
    const good = Buffer.from("the 0.12.4 installer");
    const progress: RollbackProgress[] = [];
    const dir = join(mkdtempSync(join(tmpdir(), "mf-goback-dl-")), "download");
    const sums = `${sha(good)}  MatchFrameEsports-Setup-0.12.4.exe\n`;

    const ok = standInGitHub([], { [r!.installer.url]: good, [r!.checksumsUrl]: sums });
    const file = await downloadVerified(r!, { fetch: ok.fetch, downloadDir: dir, progress: (p) => progress.push(p) });
    expect(readFileSync(file)).toEqual(good);
    expect(progress.map((p) => p.stage)).toContain("verifying");
    expect(progress.filter((p) => p.stage === "downloading").at(-1)).toMatchObject({ percent: 100 });

    const tampered = standInGitHub([], { [r!.installer.url]: Buffer.from("something else"), [r!.checksumsUrl]: sums });
    await expect(downloadVerified(r!, { fetch: tampered.fetch, downloadDir: dir, progress: () => undefined })).rejects.toThrow(/doesn't match its SHA-256/);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);

    const unlisted = standInGitHub([], { [r!.installer.url]: good, [r!.checksumsUrl]: `${sha(good)}  something-else.exe\n` });
    await expect(downloadVerified(r!, { fetch: unlisted.fetch, downloadDir: dir, progress: () => undefined })).rejects.toThrow(/doesn't list MatchFrameEsports-Setup-0.12.4.exe/);
  });
});

describe("going back, end to end", () => {
  const FUTURE: Migration[] = [...MIGRATIONS, { version: MIGRATIONS.at(-1)!.version + 1, name: "a later format", sql: "CREATE TABLE later_things (id TEXT PRIMARY KEY)" }];

  /** This computer: 0.11.0's data, updated to 0.12.4 (format 5), then to 0.13.0 (a later format), with a team added in 0.13.0. */
  function computer() {
    const dataDir = mkdtempSync(join(tmpdir(), "mf-goback-"));
    copyFileSync(FIXTURE_DB, join(dataDir, "matchframe.sqlite"));
    for (const [version, migrations] of [["0.12.4", MIGRATIONS], ["0.13.0", FUTURE]] as const) {
      const db = new Database(join(dataDir, "matchframe.sqlite"));
      new AuditRepo(db).record("system", "engine.start", null, { version, migration: db.migrate(join(dataDir, "backups"), migrations) });
      if (version === "0.13.0") db.run("INSERT INTO documents (kind, id, data, created_at, updated_at) VALUES ('team', 'made-in-0.13', '{}', '', '')");
      db.close();
    }
    return dataDir;
  }

  function setup(opts: { tamper?: boolean; answer?: boolean } = {}) {
    const dataDir = computer();
    const installers: Record<string, Buffer> = { "0.12.4": Buffer.from("installer 0.12.4"), "0.11.0": Buffer.from("installer 0.11.0"), "0.10.13": Buffer.from("installer 0.10.13") };
    const feed = [release("0.13.0"), release("0.13.0-beta.1", { prerelease: true }), release("0.12.4"), release("0.11.0"), release("0.10.13")];
    const files: Record<string, Buffer | string> = {};
    for (const [v, bytes] of Object.entries(installers)) {
      files[`${BASE}/v${v}/MatchFrameEsports-Setup-${v}.exe`] = opts.tamper ? Buffer.from("tampered") : bytes;
      files[`${BASE}/v${v}/SHA256SUMS.txt`] = `${sha(bytes)}  MatchFrameEsports-Setup-${v}.exe\n`;
    }
    const gh = standInGitHub(feed, files);
    const calls: string[] = [];
    const asked: Confirmation[] = [];
    let installed: string | null = null;
    const deps: RollbackDeps = {
      currentVersion: "0.13.0",
      dataDir,
      downloadDir: join(dataDir, "..", `${dataDir.split(/[\\/]/).pop()}-download`),
      fetch: gh.fetch,
      data: async () => dataSafety,
      confirm: async (c) => {
        asked.push(c);
        return opts.answer ?? true;
      },
      stopEngine: async () => void calls.push("stop"),
      startEngine: () => void calls.push("start"),
      install: (file) => {
        calls.push("install");
        installed = file;
      },
      progress: () => undefined,
      log: () => undefined,
    };
    return { dataDir, deps, gh, calls, asked, installed: () => installed, rollback: createRollback(deps) };
  }

  const schemaOf = (dataDir: string) => {
    const db = new DatabaseSync(join(dataDir, "matchframe.sqlite"), { readOnly: true });
    try {
      return (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    } finally {
      db.close();
    }
  };

  it("lists earlier Stable versions with what each does to the data", async () => {
    const { rollback } = setup();
    const list = await rollback.list();
    expect(list.map((o) => [o.version, o.data.kind])).toEqual([
      ["0.12.4", "restore"],
      ["0.11.0", "restore"],
      ["0.10.13", "refuse"],
    ]);
    expect(list[0]!.data.text).toContain("when version 0.12.4 was updated");
    expect(list[2]!.data.text).toContain("never been used by version 0.10.13");
  });

  it("downloads and checks the installer, asks, stops the engine, restores that version's data and installs", async () => {
    const { rollback, dataDir, calls, asked, installed } = setup();
    const result = await rollback.start("0.12.4");
    expect(result).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toBe("Go back to MatchFrame 0.12.4?");
    expect(asked[0]!.detail).toContain("matches the release's SHA256SUMS.txt");
    expect(asked[0]!.detail).toContain("Changes made since then");
    expect(calls).toEqual(["stop", "install"]);
    expect(readFileSync(installed()!).toString()).toBe("installer 0.12.4");
    expect(schemaOf(dataDir)).toBe(MIGRATIONS.at(-1)!.version);
    // The data from before going back (with the team made in 0.13.0) is kept as a copy.
    const copies = dataSafety.listBackups(join(dataDir, "backups"));
    expect(copies.find((b) => b.fromVersion === "0.13.0" && b.schema === FUTURE.at(-1)!.version)).toBeTruthy();
  });

  it("refuses before downloading when there's no copy of the data that version can read", async () => {
    const { rollback, gh, calls, asked } = setup();
    const result = await rollback.start("0.10.13");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("never been used by version 0.10.13");
    expect(gh.requested.some((u) => u.endsWith(".exe"))).toBe(false);
    expect(asked).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("changes nothing when the download doesn't match its checksum", async () => {
    const { rollback, dataDir, calls, asked } = setup({ tamper: true });
    const before = schemaOf(dataDir);
    const result = await rollback.start("0.12.4");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/doesn't match its SHA-256/);
    expect(asked).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(schemaOf(dataDir)).toBe(before);
  });

  it("changes nothing when the operator says no", async () => {
    const { rollback, dataDir, calls } = setup({ answer: false });
    const before = schemaOf(dataDir);
    expect(await rollback.start("0.11.0")).toMatchObject({ ok: false, cancelled: true });
    expect(calls).toEqual([]);
    expect(schemaOf(dataDir)).toBe(before);
  });

  it("offers only versions from the list (not the current one or a beta)", async () => {
    const { rollback } = setup();
    expect((await rollback.start("0.13.0-beta.1")).ok).toBe(false);
    expect((await rollback.start("0.13.0")).ok).toBe(false);
  });

  it("words the switch back to Stable", () => {
    const c = confirmation("0.12.4", "0.13.0-beta.2", { kind: "keep", schema: 5 }, true);
    expect(c.detail).toContain("0.12.4 is the latest Stable version. It's older than the beta you have (0.13.0-beta.2).");
    expect(c.detail).toContain("nothing is restored and nothing is lost");
    expect(c.ok).toBe("Go back to 0.12.4");
  });
});
