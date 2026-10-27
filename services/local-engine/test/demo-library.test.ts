import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/db/database.ts";
import { DemoJobRepo, SettingsRepo } from "../src/db/store.ts";
import type { WorkerRunner } from "../src/demos/library.ts";
import { DemoLibrary } from "../src/demos/library.ts";
import { Logger } from "../src/logger.ts";

/** Fake worker: commits a dataset directory per input, validates as usable, verifies ok. */
class FakeWorker implements WorkerRunner {
  calls: string[][] = [];
  constructor(private readonly root: string) {}
  available() {
    return true;
  }
  async run(args: string[]) {
    this.calls.push(args);
    if (args[0] === "extract") {
      const dir = join(this.root, `demo-${this.calls.length}`);
      mkdirSync(dir, { recursive: true });
      return { status: "committed", dataset: dir, map: "de_inferno", build: "1", output_bytes: 10 };
    }
    if (args[0] === "validate") return { verdict: "usable" };
    if (args[0] === "verify") return { ok: true };
    throw new Error(`unexpected ${args[0]}`);
  }
}

function setup(minFreeBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "mf-lib-"));
  const db = new Database(":memory:");
  db.migrate();
  const repo = new DemoJobRepo(db);
  const settings = new SettingsRepo(db);
  const worker = new FakeWorker(join(dir, "datasets"));
  const lib = new DemoLibrary(repo, settings, worker, new Logger("error", null), dir, () => false);
  const ingest = join(dir, "ingest");
  mkdirSync(ingest, { recursive: true });
  lib.setConfig({ ingestRoots: [ingest], datasetRoot: join(dir, "datasets"), minFreeBytes, watch: false, retention: { policy: "remove_after_validation", quarantineDays: 0, auditSampleRate: 0 } });
  return { dir, repo, lib, worker, ingest };
}

const settle = async (lib: DemoLibrary) => {
  for (let i = 0; i < 20; i++) {
    await lib.processQueue();
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("DemoLibrary", () => {
  it("A42: pauses safely when storage admission fails and deletes nothing", async () => {
    const { repo, lib, worker, ingest } = setup(Number.MAX_SAFE_INTEGER);
    const file = join(ingest, "a.dem");
    writeFileSync(file, "demo-a");
    lib.importPaths([file]);
    await settle(lib);
    const [job] = repo.list(undefined, 10);
    expect(job!.state).toBe("QUEUED");
    expect(String(lib.progress.get(job!.id)?.message)).toMatch(/insufficient free space/);
    expect(worker.calls).toHaveLength(0);
    const ret = await lib.applyRetention();
    expect(ret.removed).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("A40: jobs interrupted mid-extraction are requeued on restart", async () => {
    const { repo, lib, ingest } = setup(0);
    const file = join(ingest, "b.dem");
    writeFileSync(file, "demo-b");
    const [job] = lib.importPaths([file]);
    repo.transition(job!.id, "HASHED", { sha256: "b".repeat(64), sizeBytes: 6 });
    repo.transition(job!.id, "QUEUED", {});
    repo.transition(job!.id, "PARSING", { attempts: 1 });
    expect(lib.recover()).toBe(1);
    expect(repo.get(job!.id)!.state).toBe("QUEUED");
    expect(repo.transitions(job!.id).some((t) => t.to === "RECOVERABLE")).toBe(true);
  });

  it("never deletes a demo imported from outside the ingest roots", async () => {
    const { dir, repo, lib } = setup(0);
    const outside = join(dir, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const file = join(outside, "c.dem");
    writeFileSync(file, "demo-c");
    lib.importPaths([file]);
    await settle(lib);
    const [job] = repo.list(undefined, 10);
    expect(job!.state).toBe("COMMITTED");
    expect(job!.retentionPolicy).toBe("keep_originals");
    await lib.applyRetention();
    expect(existsSync(file)).toBe(true);
    expect(repo.get(job!.id)!.state).toBe("COMMITTED");
  });
});
