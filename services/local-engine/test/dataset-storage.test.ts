import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/auth.ts";
import { Database } from "../src/db/database.ts";
import { DemoJobRepo, SettingsRepo } from "../src/db/store.ts";
import type { WorkerRunner } from "../src/demos/library.ts";
import { DemoLibrary } from "../src/demos/library.ts";
import { PythonSetup, type CommandRunner } from "../src/demos/python-setup.ts";
import { DatasetStorage } from "../src/demos/storage.ts";
import { Logger } from "../src/logger.ts";

/** Fake pipeline: extract/validate/verify as the library needs, plus features, uploads and unpacking. */
class FakeWorker implements WorkerRunner {
  calls: { args: string[]; env?: Record<string, string> }[] = [];
  failUpload = false;
  constructor(private readonly root: string) {}
  available() {
    return true;
  }
  async run(args: string[], _p?: unknown, env?: Record<string, string>) {
    this.calls.push({ args, ...(env ? { env } : {}) });
    const cmd = args[0];
    if (cmd === "extract") {
      const dir = join(this.root, "map=de_mirage", "build=1", `demo=${this.calls.length}`);
      mkdirSync(dir, { recursive: true });
      return { status: "committed", dataset: dir, map: "de_mirage", build: "1", output_bytes: 10 };
    }
    if (cmd === "validate") return { verdict: "usable" };
    if (cmd === "verify") return { ok: true };
    if (cmd === "build-features") return { status: "built" };
    if (cmd === "upload-dataset") {
      if (this.failUpload) throw Object.assign(new Error("STORAGE_UNREACHABLE: could not connect"), { workerError: { code: "STORAGE_UNREACHABLE", message: "could not connect" } });
      return { status: "uploaded", remote: `/matchframe/datasets/${args[2]!.split(/[\\/]/).slice(-3).join("/")}`, bytes: 1234, files: 9 };
    }
    if (cmd === "storage-test") return { ok: true, secure: true, fingerprint: "ab".repeat(32) };
    if (cmd === "unpack") {
      const out = args[args.indexOf("--out-dir") + 1]!;
      mkdirSync(out, { recursive: true });
      const files = ["m1.dem", "m2.dem"].map((n) => join(out, n));
      for (const f of files) writeFileSync(f, `demo ${f}`);
      return { status: "unpacked", files };
    }
    throw new Error(`unexpected ${cmd}`);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mf-store-"));
  const db = new Database(":memory:");
  db.migrate();
  const repo = new DemoJobRepo(db);
  const settings = new SettingsRepo(db);
  const secrets = new SecretStore(join(dir, "secrets.json"), "11".repeat(32));
  const worker = new FakeWorker(join(dir, "datasets"));
  const logger = new Logger("error", null);
  const lib = new DemoLibrary(repo, settings, worker, logger, dir, () => false);
  const ingest = join(dir, "ingest");
  mkdirSync(ingest, { recursive: true });
  lib.setConfig({ ingestRoots: [ingest], datasetRoot: join(dir, "datasets"), minFreeBytes: 0, watch: false, retention: { policy: "remove_after_upload", quarantineDays: 0, auditSampleRate: 0 } });
  let now = 1_000_000;
  const storage = new DatasetStorage({ settings, secrets, repo, runner: worker, library: lib, logger, isLive: () => false, now: () => now });
  return { dir, repo, lib, worker, ingest, storage, secrets, advance: (ms: number) => (now += ms) };
}

const settle = async (lib: DemoLibrary) => {
  for (let i = 0; i < 20; i++) {
    await lib.processQueue();
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("dataset storage", () => {
  it("builds the POV labels, uploads the dataset, and only then deletes the demo", async () => {
    const { repo, lib, worker, ingest, storage } = setup();
    storage.setSettings({ enabled: true, host: "174.0.0.9", username: "box", password: "pw-123" });
    const file = join(ingest, "a.dem");
    writeFileSync(file, "demo-a");
    lib.importPaths([file]);
    await settle(lib);
    expect(repo.list(undefined, 10)[0]!.state).toBe("COMMITTED");
    // Not uploaded yet: the demo stays.
    await lib.applyRetention();
    expect(existsSync(file)).toBe(true);

    await storage.tick();
    const cmds = worker.calls.map((c) => c.args[0]);
    expect(cmds.slice(-2)).toEqual(["build-features", "upload-dataset"]);
    const upload = worker.calls.at(-1)!;
    // The password goes in the environment, never the command line.
    expect(upload.env).toMatchObject({ MF_STORAGE_HOST: "174.0.0.9", MF_STORAGE_USER: "box", MF_STORAGE_PASSWORD: "pw-123", MF_STORAGE_SECURE: "ftps" });
    expect(upload.args.join(" ")).not.toContain("pw-123");
    expect(storage.status()).toMatchObject({ uploaded: 1, pending: 0, lastError: null });

    await lib.applyRetention();
    expect(existsSync(file)).toBe(false);
    expect(repo.list(undefined, 10)[0]!.state).toBe("RAW_REMOVED");
    // Nothing left to upload.
    const n = worker.calls.length;
    await storage.tick();
    expect(worker.calls.length).toBe(n);
  });

  it("does nothing while turned off, and waits 10 minutes after a failed upload", async () => {
    const { lib, worker, ingest, storage, advance } = setup();
    writeFileSync(join(ingest, "a.dem"), "demo-a");
    lib.importPaths([join(ingest, "a.dem")]);
    await settle(lib);
    storage.setSettings({ host: "h", username: "u", password: "p" });
    await storage.tick();
    expect(worker.calls.some((c) => c.args[0] === "upload-dataset")).toBe(false);

    storage.setSettings({ enabled: true });
    worker.failUpload = true;
    await storage.tick();
    expect(storage.status().lastError).toMatchObject({ message: expect.stringContaining("could not connect") });
    const n = worker.calls.length;
    await storage.tick();
    expect(worker.calls.length).toBe(n);
    worker.failUpload = false;
    advance(10 * 60_000 + 1);
    await storage.tick();
    expect(storage.status()).toMatchObject({ uploaded: 1, lastError: null });
  });

  it("trusts the server's certificate at the first good test, and forgets it for a new server", async () => {
    const { storage, secrets } = setup();
    storage.setSettings({ host: "h", username: "u", password: "p" });
    expect(secrets.getSecret("demos.storagePassword")).toBe("p");
    await storage.test();
    expect(storage.settings().fingerprint).toBe("ab".repeat(32));
    storage.setSettings({ username: "u2" });
    expect(storage.settings().fingerprint).toBe("ab".repeat(32));
    storage.setSettings({ host: "other" });
    expect(storage.settings().fingerprint).toBe(null);
    // Leaving the password out keeps it; null removes it.
    expect(storage.hasPassword()).toBe(true);
    storage.setSettings({ password: null });
    expect(storage.hasPassword()).toBe(false);
  });

  it("takes the demos out of an archive dropped in the ingest folder, then deletes the archive", async () => {
    const { repo, lib, ingest, dir } = setup();
    const arc = join(ingest, "match.rar");
    writeFileSync(arc, "rar");
    const files = await lib.unpackArchive(arc);
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(["m1.dem", "m2.dem"]);
    expect(dirname(files[0]!)).toBe(join(ingest, "unpacked", "match"));
    expect(repo.list(undefined, 10)).toHaveLength(2);
    expect(existsSync(arc)).toBe(false);
    // An archive from elsewhere is never deleted.
    const outside = join(dir, "elsewhere.zip");
    writeFileSync(outside, "zip");
    await lib.unpackArchive(outside);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("Python setup", () => {
  const workersDir = join(__dirname, "..", "..", "..", "workers");

  it("makes an environment with the pipeline's packages and uses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-py-"));
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const calls: string[][] = [];
    const setupRef: { s: PythonSetup | null } = { s: null };
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("-c")) return cmd === "python3" || (cmd === "py" && args[0] === "-3") ? { code: 0, output: "ok 3.12.4" } : { code: 1, output: "not found" };
      if (args.includes("venv")) {
        mkdirSync(dirname(setupRef.s!.envPython), { recursive: true });
        writeFileSync(setupRef.s!.envPython, "");
        return { code: 0, output: "" };
      }
      return { code: 0, output: "Successfully installed" };
    };
    const setup = new PythonSetup({ settings, logger: new Logger("error", null), dataDir: dir, workersDir, fromEnv: null, run });
    setupRef.s = setup;
    expect(setup.interpreter()).toBe(null);
    expect(setup.requirements()).toEqual(expect.arrayContaining(["demoparser2>=0.42", "polars>=1.0", "lightgbm>=4.0"]));
    setup.start();
    for (let i = 0; i < 50 && setup.status().state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(setup.status()).toMatchObject({ state: "done", error: null });
    const pip = calls.find((c) => c.includes("pip"))!;
    expect(pip[0]).toBe(setup.envPython);
    expect(pip).toEqual(expect.arrayContaining(["install", "demoparser2>=0.42"]));
    expect(setup.interpreter()).toBe(setup.envPython);
    // A Python chosen by hand wins.
    setup.choose("C:/Python312/python.exe");
    expect(setup.interpreter()).toBe("C:/Python312/python.exe");
  });

  it("says how to get Python when there is none, or only an old one", async () => {
    const db = new Database(":memory:");
    db.migrate();
    const run: CommandRunner = async (cmd, args) => (args.includes("-c") && cmd === "python" ? { code: 0, output: "old 3.9.1" } : { code: 1, output: "" });
    const setup = new PythonSetup({ settings: new SettingsRepo(db), logger: new Logger("error", null), dataDir: mkdtempSync(join(tmpdir(), "mf-py-")), workersDir, fromEnv: null, run });
    setup.start();
    for (let i = 0; i < 50 && setup.status().state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(setup.status().state).toBe("failed");
    expect(setup.status().error).toMatch(/python\.org/);
    expect(setup.status().log.join(" ")).toMatch(/3\.9\.1/);
  });
});
