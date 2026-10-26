import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { DemoJob } from "../src/db/store.ts";

/**
 * Real integration: engine DemoLibrary + TrainingService driving the Python workers on real CS2
 * demos. Opt-in — set MF_TEST_DEMOS (folder with the cs-demos-2 files) and MATCHFRAME_PYTHON
 * (interpreter with demoparser2, polars, pyarrow, duckdb, lightgbm). Demos are copied into a temp
 * ingest folder; nothing from them is written into the repository.
 */
const demos = process.env.MF_TEST_DEMOS;
const python = process.env.MATCHFRAME_PYTHON;
const enabled = !!demos && !!python && existsSync(demos) && existsSync(python);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const GOOD = ["Anubis_ShortMatch_2023-08-04.dem", "cs2_valve_mm_8thAug23_ancient.dem", "arsham_infernocs2_1stSept23.dem", "1_2v2_6thAug23_64cf951f9b4ce6b86c73b089.dem"];
const BUSY = new Set(["DISCOVERED", "HASHED", "QUEUED", "PARSING", "EXTRACTED", "VALIDATING"]);

describe.skipIf(!enabled)("demo pipeline with real demos and Python workers", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-demo-int-"));
  const ingest = join(dataDir, "demo-ingest");
  let e: Engine;

  const drain = async (timeoutMs = 240000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await e.demos.processQueue();
      const jobs = e.demoJobs.list(undefined, 1000);
      if (!jobs.some((j) => BUSY.has(j.state))) return jobs;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("demo jobs did not finish in time");
  };
  const byFile = (jobs: DemoJob[], name: string) => jobs.find((j) => j.sourcePath.endsWith(name));

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    e = new Engine(loadConfig({ dataDir, gsiPort: 47410, apiPort: 47411, overlayPort: 47412, operatorUiDir: null, hudRendererDir: null, mapPackDir: join(repo, "assets", "map-packs"), workersDir: join(repo, "workers"), pythonPath: python! }));
    await e.init();
    e.demos.stop(); // the test drives the queue itself
    e.demos.setConfig({ ingestRoots: [ingest], watch: false, minFreeBytes: 0, retention: { policy: "remove_after_validation", quarantineDays: 0, auditSampleRate: 0 } });
    mkdirSync(ingest, { recursive: true });
  });

  afterAll(async () => {
    await e?.shutdown();
  });

  it("A39/A40: imports real demos; corrupt, truncated and partial demos are quarantined; a crashed run's dataset is adopted once", async () => {
    for (const f of GOOD) copyFileSync(join(demos!, f), join(ingest, f));
    copyFileSync(join(demos!, "pov.dem"), join(ingest, "pov.dem"));
    writeFileSync(join(ingest, "garbage.dem"), Buffer.from("this is not a demo file".repeat(64)));
    copyFileSync(join(demos!, GOOD[0]!), join(ingest, "truncated.dem"));
    truncateSync(join(ingest, "truncated.dem"), 2 * 1024 * 1024);
    copyFileSync(join(demos!, GOOD[0]!), join(ingest, "anubis-copy.dem"));

    // Simulated crash: the worker committed Ancient's dataset but the engine never recorded it.
    const pre = await e.workers.run(["extract", "--input", join(ingest, GOOD[1]!), "--dataset-root", e.demos.config().datasetRoot]);
    expect(pre.status).toBe("committed");

    e.demos.importPaths([ingest]);
    const jobs = await drain();
    for (const f of GOOD) {
      const j = byFile(jobs, f)!;
      expect(j.state, `${f}: ${j.failureReason}`).toBe("COMMITTED");
      expect((j.validation as { verdict: string }).verdict).toBe("usable");
      expect(j.parser).toMatch(/^demoparser2 /);
    }
    expect(byFile(jobs, GOOD[1]!)!.datasetDir).toBe(pre.dataset);
    const ancientDirs = readdirSync(join(e.demos.config().datasetRoot, "map=de_ancient"), { recursive: true }).filter((p) => String(p).match(/demo=[0-9a-f]+$/));
    expect(ancientDirs).toHaveLength(1);
    expect(byFile(jobs, "anubis-copy.dem")!.state).toBe("DUPLICATE");
    for (const f of ["pov.dem", "garbage.dem", "truncated.dem"]) expect(byFile(jobs, f)!.state, f).toBe("QUARANTINED");
  }, 300000);

  it("A41: retention removes only verified raw demos; a tampered dataset keeps its raw demo", async () => {
    const jobs = e.demoJobs.list("COMMITTED", 100);
    const tampered = jobs.find((j) => j.sourcePath.endsWith(GOOD[3]!))!;
    const victim = join(tampered.datasetDir!, readdirSync(tampered.datasetDir!).find((f) => f.endsWith(".parquet"))!);
    const originalSize = statSync(victim).size;
    appendFileSync(victim, Buffer.from([0]));
    const res = await e.demos.applyRetention();
    truncateSync(victim, originalSize); // restore for the training test
    expect(res.removed).toBe(3);
    expect(res.blocked.some((b) => b.startsWith(tampered.id))).toBe(true);
    const after = e.demoJobs.list(undefined, 100);
    for (const f of GOOD.slice(0, 3)) {
      const j = byFile(after, f)!;
      expect(j.state).toBe("RAW_REMOVED");
      expect(existsSync(j.sourcePath)).toBe(false);
    }
    const kept = after.find((j) => j.id === tampered.id)!;
    expect(kept.state).toBe("QUARANTINED_RAW");
    expect(existsSync(kept.lastCheckpoint!)).toBe(true);
    for (const f of ["pov.dem", "garbage.dem", "truncated.dem"]) expect(existsSync(join(ingest, f)), f).toBe(true);
  }, 120000);

  it("trains, evaluates on the frozen held-out split and exports; the registry refuses an approval jump", async () => {
    const run = await e.training.wait(e.training.start("contact_2s", null));
    expect(run.state, run.error ?? "").toBe("completed");
    expect(run.steps.map((s) => s.name)).toEqual([...run.datasets.map(() => "build-features"), "freeze-dataset", "audit-split", "train", "evaluate", "export-model"]);
    expect(run.steps.every((s) => s.status === "completed")).toBe(true);
    const evaluation = run.steps.find((s) => s.name === "evaluate")!.summary as { overall: { model_auc: number | null; n: number } };
    expect(evaluation.overall.n).toBeGreaterThan(1000);
    const entry = e.training.registry().find((m) => m.modelId === run.modelId)!;
    expect(entry.status).toBe("experimental");
    expect(entry.exportAvailable).toBe(true);
    await expect(e.training.promote(run.modelId!, "approved", "skip the gates")).rejects.toThrow(/PROMOTION_REFUSED/);
    await e.training.promote(run.modelId!, "shadow", "integration test");
    expect(e.training.registry().find((m) => m.modelId === run.modelId)!.status).toBe("shadow");
  }, 300000);

  it("runs the exported model locally in shadow; corrupt or live-incompatible models are rejected and the baseline continues (A44/A45)", async () => {
    const model = e.training.registry().find((m) => m.status === "shadow")!;
    const loaded = e.training.loadShadow(model.modelId);
    expect(loaded.ok).toBe(true);
    await e.startSimulation({ startOffsetSec: 30 });
    await new Promise((r) => setTimeout(r, 3000));
    const summary = e.session.shadow.summary();
    expect(summary.samples).toBeGreaterThan(0);
    expect(summary.meanAbsDiffVsBaseline).not.toBeNull();
    const decisionsBefore = e.session.decisionLog.length;

    const exportDir = join(dataDir, "models", model.modelId, "export");
    const cardPath = join(exportDir, "model_card.json");
    const card = readFileSync(cardPath, "utf8");
    const parsed = JSON.parse(card) as { feature_schema: { capability: string }[] };
    parsed.feature_schema[0]!.capability = "demo_rich";
    writeFileSync(cardPath, JSON.stringify(parsed));
    const incompatible = e.training.loadShadow(model.modelId);
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) expect(incompatible.reason).toMatch(/unavailable live/);
    writeFileSync(cardPath, card);

    appendFileSync(join(exportDir, "model.json"), " ");
    const corrupt = e.training.loadShadow(model.modelId);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toMatch(/checksum/);
    expect(e.session.shadowModelId).toBe(model.modelId); // the previously validated model stays; a bad file never replaces it

    await new Promise((r) => setTimeout(r, 800));
    expect(e.session.decisionLog.length).toBeGreaterThan(decisionsBefore);
    await e.stopSimulation();
  }, 60000);
});
