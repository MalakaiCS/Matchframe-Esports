import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { RetentionPolicy } from "@matchframe/contracts";
import type { DemoJob, DemoJobRepo, SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";

export interface DemoLibraryConfig {
  datasetRoot: string;
  quarantineDir: string;
  /** Raw demos are only ever deleted from inside these roots. */
  ingestRoots: string[];
  watch: boolean;
  retention: { policy: RetentionPolicy; quarantineDays: number; auditSampleRate: number };
  concurrency: number;
  pauseDuringLive: boolean;
  minFreeBytes: number;
  quotas: Record<string, { softBytes: number; hardBytes: number }>;
}

export function defaultDemoConfig(dataDir: string): DemoLibraryConfig {
  return {
    datasetRoot: join(dataDir, "datasets"),
    quarantineDir: join(dataDir, "demo-quarantine"),
    ingestRoots: [join(dataDir, "demo-ingest")],
    watch: true,
    retention: { policy: "quarantine_then_remove", quarantineDays: 7, auditSampleRate: 0.05 },
    concurrency: 1,
    pauseDuringLive: true,
    minFreeBytes: 20 * 1024 ** 3,
    // Proposed planning allocation for a ~2 TB server (decimal GB), configurable.
    quotas: {
      sampled_state: { softBytes: 540e9, hardBytes: 600e9 },
      events_features: { softBytes: 270e9, hardBytes: 300e9 },
      raw_ingest: { softBytes: 180e9, hardBytes: 200e9 },
      curated_raw: { softBytes: 135e9, hardBytes: 150e9 },
      models: { softBytes: 90e9, hardBytes: 100e9 },
    },
  };
}

export interface WorkerRunner {
  /** Runs a worker command and returns the final JSON result (or throws with the worker error). */
  run(args: string[], onProgress?: (p: Record<string, unknown>) => void): Promise<Record<string, unknown>>;
  available(): boolean;
}

/** Spawns `python -m mf_common.cli ...` and parses JSON-lines progress/result/error output. */
export class PythonWorkerRunner implements WorkerRunner {
  constructor(
    private readonly python: string | null,
    private readonly workersDir: string | null,
  ) {}

  available(): boolean {
    // A bare command name (e.g. "python3") is resolved through PATH when spawned.
    const pythonOk = !!this.python && (/[\\/]/.test(this.python) ? existsSync(this.python) : true);
    return pythonOk && !!this.workersDir && existsSync(this.workersDir);
  }

  run(args: string[], onProgress?: (p: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    if (!this.available()) return Promise.reject(new Error("Python workers are not configured (set the Python interpreter and workers directory)"));
    return new Promise((resolvePromise, reject) => {
      const paths = ["common", "demo-parser", "features", "training", "evaluation"].map((d) => join(this.workersDir!, d));
      const child = spawn(this.python!, ["-m", "mf_common.cli", ...args], {
        cwd: this.workersDir!,
        env: { ...process.env, PYTHONPATH: paths.join(process.platform === "win32" ? ";" : ":"), PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buf = "";
      let result: Record<string, unknown> | null = null;
      let error: Record<string, unknown> | null = null;
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.type === "progress") onProgress?.(msg);
            else if (msg.type === "result") result = msg;
            else if (msg.type === "error") error = msg;
          } catch {
            // non-JSON output is ignored
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString("utf8")).slice(-4000);
      });
      // Offline work must never compete with the live broadcast for CPU (spec A46).
      if (child.pid !== undefined) {
        try {
          setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // not permitted on this platform/user; the live-broadcast guard still applies
        }
      }
      child.on("close", (code) => {
        // Exit 3 = the command completed with a negative verdict (quarantine, verify mismatch,
        // leakage…); the result line carries the details.
        if ((code === 0 || code === 3) && result) return resolvePromise({ ...result, exitCode: code });
        const msg = error ? `${error.code ?? "error"}: ${error.message ?? ""}` : `worker exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`;
        reject(Object.assign(new Error(msg), { workerError: error }));
      });
      child.on("error", reject);
    });
  }
}

export function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    let size = 0;
    createReadStream(path)
      .on("data", (c) => {
        h.update(c);
        size += (c as Buffer).length;
      })
      .on("end", () => res({ sha256: h.digest("hex"), size }))
      .on("error", rej);
  });
}

export function isInside(root: string, path: string): boolean {
  try {
    const r = realpathSync(resolve(root));
    const p = realpathSync(resolve(path));
    const rel = relative(r, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

export function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) total += dirSize(join(path, name));
  return total;
}

function readManifest(datasetDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readManifestParser(datasetDir: string): string | null {
  const p = readManifest(datasetDir)?.parser as { name?: string; version?: string } | undefined;
  return p?.name ? `${p.name} ${p.version ?? ""}`.trim() : null;
}

function readManifestSchemaVersion(datasetDir: string): number | null {
  const v = readManifest(datasetDir)?.schema_version;
  return typeof v === "number" ? v : null;
}

const DEMO_RE = /\.(dem|dem\.gz|dem\.bz2|dem\.zst)$/i;

/**
 * Demo Library (spec §15): extraction rather than video watching. The worker writes datasets
 * atomically; this class owns job state, admission, crash recovery and the raw-retention policy.
 */
export class DemoLibrary {
  private running = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenSizes = new Map<string, number>();
  private paused = false;
  readonly progress = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly repo: DemoJobRepo,
    private readonly settings: SettingsRepo,
    private readonly runner: WorkerRunner,
    private readonly logger: Logger,
    private readonly dataDir: string,
    private readonly isLive: () => boolean,
  ) {}

  config(): DemoLibraryConfig {
    return { ...defaultDemoConfig(this.dataDir), ...this.settings.get<Partial<DemoLibraryConfig>>("demos.config", {}) };
  }

  setConfig(patch: Partial<DemoLibraryConfig>): DemoLibraryConfig {
    const next = { ...this.config(), ...patch };
    this.settings.set("demos.config", next);
    return next;
  }

  /** Crash recovery: interrupted jobs go back to the queue; nothing half-done stays "complete". */
  recover(): number {
    let n = 0;
    for (const state of ["PARSING", "EXTRACTED", "VALIDATING"] as const) {
      for (const j of this.repo.list(state)) {
        this.repo.transition(j.id, "RECOVERABLE", { lastCheckpoint: `interrupted in ${state}` });
        this.repo.transition(j.id, "QUEUED", {});
        n++;
      }
    }
    const root = this.config().datasetRoot;
    if (existsSync(root)) this.removeTempDirs(root, 0);
    return n;
  }

  private removeTempDirs(dir: string, depth: number): void {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (/\.(tmp|staging)[-.]/.test(name) || name.startsWith(".tmp")) {
        rmSync(full, { recursive: true, force: true });
        this.logger.info("removed interrupted temporary dataset directory", { dir: full });
      } else this.removeTempDirs(full, depth + 1);
    }
  }

  start(): void {
    if (this.timer) return;
    for (const r of this.config().ingestRoots) mkdirSync(r, { recursive: true });
    this.recover();
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Registers demo files (or folders) for import. Files outside ingest roots are never deleted. */
  importPaths(paths: string[], opts: { retentionPolicy?: RetentionPolicy; provenance?: Record<string, unknown> } = {}): DemoJob[] {
    const cfg = this.config();
    const out: DemoJob[] = [];
    const add = (file: string) => {
      const root = cfg.ingestRoots.find((r) => isInside(r, file)) ?? null;
      const policy: RetentionPolicy = root ? (opts.retentionPolicy ?? cfg.retention.policy) : "keep_originals";
      out.push(this.repo.create(file, root, policy, { ...(opts.provenance ?? {}), importedFrom: file, importedAt: new Date().toISOString() }));
    };
    const walk = (p: string, depth: number) => {
      if (depth > 6 || !existsSync(p)) return;
      const st = statSync(p);
      if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n), depth + 1);
      else if (st.isFile() && DEMO_RE.test(p)) add(p);
    };
    for (const p of paths) walk(resolve(p), 0);
    return out;
  }

  /** Watched ingest folders: a file is picked up once its size is stable across two scans. */
  scanIngest(): number {
    const cfg = this.config();
    if (!cfg.watch) return 0;
    const known = new Set(this.repo.list(undefined, 100000).map((j) => j.sourcePath));
    let added = 0;
    for (const root of cfg.ingestRoots) {
      if (!existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        for (const n of readdirSync(d)) {
          const full = join(d, n);
          const st = statSync(full);
          if (st.isDirectory()) stack.push(full);
          else if (DEMO_RE.test(full) && !known.has(full)) {
            const prev = this.seenSizes.get(full);
            this.seenSizes.set(full, st.size);
            if (prev === st.size) {
              this.importPaths([full]);
              this.seenSizes.delete(full);
              added++;
            }
          }
        }
      }
    }
    return added;
  }

  admission(sizeBytes: number): { ok: boolean; reason: string | null } {
    const cfg = this.config();
    mkdirSync(cfg.datasetRoot, { recursive: true });
    const fs = statfsSync(cfg.datasetRoot);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const need = Math.max(cfg.minFreeBytes, sizeBytes * 3);
    if (free < need) return { ok: false, reason: `insufficient free space (${(free / 1e9).toFixed(1)} GB free, need ${(need / 1e9).toFixed(1)} GB)` };
    const used = dirSize(cfg.datasetRoot);
    const q = cfg.quotas.sampled_state;
    if (q && used + sizeBytes * 0.5 > q.hardBytes) return { ok: false, reason: "dataset hard quota reached" };
    return { ok: true, reason: null };
  }

  async tick(): Promise<void> {
    try {
      this.scanIngest();
      await this.processQueue();
      await this.applyRetention();
    } catch (e) {
      this.logger.error("demo library tick failed", { error: String(e) });
    }
  }

  async processQueue(): Promise<void> {
    const cfg = this.config();
    if (this.paused || (cfg.pauseDuringLive && this.isLive())) return;
    for (const j of this.repo.list("DISCOVERED", 50)) await this.hashJob(j);
    while (this.running < cfg.concurrency) {
      const next = this.repo.list("QUEUED", 1)[0];
      if (!next) return;
      const adm = this.admission(next.sizeBytes ?? 0);
      if (!adm.ok) {
        this.progress.set(next.id, { message: `waiting: ${adm.reason}` });
        return;
      }
      this.running++;
      void this.runJob(next).finally(() => this.running--);
    }
  }

  private async hashJob(j: DemoJob): Promise<void> {
    if (!existsSync(j.sourcePath)) {
      this.repo.transition(j.id, "FAILED", { failureReason: "source file missing" });
      return;
    }
    try {
      const { sha256, size } = await sha256File(j.sourcePath);
      const dup = this.repo.findBySha(sha256);
      this.repo.transition(j.id, "HASHED", { sha256: dup ? null : sha256, sizeBytes: size });
      if (dup && dup.id !== j.id) {
        this.repo.transition(j.id, "DUPLICATE", { failureReason: `duplicate of ${dup.id}` });
        return;
      }
      this.repo.transition(j.id, "QUEUED", {});
    } catch (e) {
      this.repo.transition(j.id, "FAILED", { failureReason: `hash failed: ${String(e)}` });
    }
  }

  private async runJob(j: DemoJob): Promise<void> {
    const cfg = this.config();
    const attempts = j.attempts + 1;
    try {
      this.repo.transition(j.id, "PARSING", { attempts, lastCheckpoint: "extract" });
      const extract = await this.runner.run(["extract", "--input", j.sourcePath, "--dataset-root", cfg.datasetRoot], (p) => this.progress.set(j.id, p));
      // "duplicate" means a committed dataset with this content hash already exists — e.g. a
      // previous attempt committed it and crashed before the engine recorded it. Adopt it (after
      // validation) instead of extracting twice.
      const datasetDir = String(extract.dataset ?? extract.dataset_dir ?? "");
      if (!datasetDir || !existsSync(datasetDir)) throw new Error("worker reported success without a dataset directory");
      const owner = this.repo.findByDataset(datasetDir);
      if (extract.status === "duplicate" && owner && owner.id !== j.id) {
        this.repo.transition(j.id, "FAILED", { failureReason: `dataset already committed by ${owner.id}` });
        return;
      }
      this.repo.transition(j.id, "EXTRACTED", {
        datasetDir,
        mapName: (extract.map as string | undefined) ?? null,
        gameBuild: extract.build !== undefined && extract.build !== null ? String(extract.build) : null,
        parser: readManifestParser(datasetDir),
        schemaVersion: readManifestSchemaVersion(datasetDir),
        bytesRead: j.sizeBytes,
        bytesWritten: typeof extract.output_bytes === "number" ? extract.output_bytes : dirSize(datasetDir),
        lastCheckpoint: extract.status === "duplicate" ? "validate (adopted existing dataset)" : "validate",
      });
      this.repo.transition(j.id, "VALIDATING", {});
      const validation = await this.runner.run(["validate", "--dataset", datasetDir], (p) => this.progress.set(j.id, p));
      const verdict = String(validation.verdict ?? "");
      if (verdict === "usable") {
        this.repo.transition(j.id, "COMMITTED", { validation, lastCheckpoint: "committed" });
      } else {
        // Quarantined extractions are never eligible for raw deletion.
        this.repo.transition(j.id, "QUARANTINED", { validation, failureReason: `validation verdict: ${verdict || "unknown"}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cur = this.repo.require(j.id);
      if (cur.state === "PARSING" || cur.state === "EXTRACTED" || cur.state === "VALIDATING") {
        // Unreadable, unsupported, partial or empty demos are quarantined (never deletion-eligible);
        // other failures (missing file, internal errors) are retryable.
        const code = String((e as { workerError?: { code?: unknown } }).workerError?.code ?? "");
        const corrupt = ["UNSUPPORTED_FORMAT", "PARSER_FAILED", "EMPTY_PARSE", "INPUT_UNREADABLE"].includes(code) || /corrupt|unexpected end/i.test(msg);
        this.repo.transition(j.id, corrupt ? "QUARANTINED" : "FAILED", { failureReason: msg.slice(0, 1000) });
      }
      this.logger.warn("demo job failed", { jobId: j.id, error: msg });
    } finally {
      this.progress.delete(j.id);
    }
  }

  /** True when this demo is kept as part of the curated raw audit/holdout sample. */
  inAuditSample(sha256: string | null, rate: number): boolean {
    if (!sha256) return false;
    return parseInt(sha256.slice(0, 4), 16) / 0xffff < rate;
  }

  /**
   * Raw retention executor. Deletion requires ALL of: ingest-root containment, COMMITTED with a
   * usable validation verdict, expired quarantine, and a successful fresh dataset verification.
   */
  async applyRetention(nowMs = Date.now()): Promise<{ quarantined: number; removed: number; blocked: string[] }> {
    const cfg = this.config();
    const blocked: string[] = [];
    let quarantined = 0;
    let removed = 0;
    for (const j of this.repo.list("COMMITTED", 1000)) {
      if (j.retentionPolicy === "keep_originals" || !j.ingestRoot) continue;
      if (j.retentionPolicy === "keep_curated_sample" && this.inAuditSample(j.sha256, cfg.retention.auditSampleRate)) continue;
      if (j.retentionPolicy === "keep_until_backup_confirmed") {
        const backed = this.settings.get<string[]>("demos.backupConfirmed", []);
        if (!j.sha256 || !backed.includes(j.sha256)) continue;
      }
      if ((j.validation as { verdict?: string } | null)?.verdict !== "usable") {
        blocked.push(`${j.id}: validation not usable`);
        continue;
      }
      if (!isInside(j.ingestRoot, j.sourcePath)) {
        blocked.push(`${j.id}: source outside its ingest root`);
        continue;
      }
      this.repo.transition(j.id, "RETENTION_ELIGIBLE", {});
      const days = j.retentionPolicy === "remove_after_validation" ? 0 : cfg.retention.quarantineDays;
      mkdirSync(cfg.quarantineDir, { recursive: true });
      const target = join(cfg.quarantineDir, `${j.sha256 ?? j.id}-${basename(j.sourcePath)}`);
      try {
        renameSync(j.sourcePath, target);
      } catch (e) {
        blocked.push(`${j.id}: could not move to quarantine (${String(e)})`);
        continue;
      }
      this.repo.transition(j.id, "QUARANTINED_RAW", { quarantineUntil: new Date(nowMs + days * 86400_000).toISOString(), lastCheckpoint: target });
      quarantined++;
    }
    for (const j of this.repo.list("QUARANTINED_RAW", 1000)) {
      if (!j.quarantineUntil || Date.parse(j.quarantineUntil) > nowMs) continue;
      const qPath = j.lastCheckpoint;
      if (!qPath || !isInside(cfg.quarantineDir, qPath)) {
        blocked.push(`${j.id}: quarantined file is not inside the quarantine directory`);
        continue;
      }
      if (!j.datasetDir || !existsSync(j.datasetDir)) {
        blocked.push(`${j.id}: dataset missing — raw demo kept`);
        continue;
      }
      try {
        const v = await this.runner.run(["verify", "--dataset", j.datasetDir]);
        if (v.ok !== true) throw new Error(`verify returned ${JSON.stringify(v).slice(0, 200)}`);
      } catch (e) {
        blocked.push(`${j.id}: dataset verification failed — raw demo kept (${String(e).slice(0, 200)})`);
        continue;
      }
      unlinkSync(qPath);
      this.repo.transition(j.id, "RAW_REMOVED", { lastCheckpoint: "raw removed after verified extraction" });
      removed++;
    }
    if (blocked.length) this.logger.warn("retention blocked for some jobs", { blocked: blocked.slice(0, 20) });
    return { quarantined, removed, blocked };
  }

  /** Restores a quarantined raw demo to its original location (reversible quarantine). */
  restoreFromQuarantine(jobId: string): DemoJob {
    const j = this.repo.require(jobId);
    if (j.state !== "QUARANTINED_RAW" || !j.lastCheckpoint) throw Object.assign(new Error("job is not in raw quarantine"), { status: 409 });
    renameSync(j.lastCheckpoint, j.sourcePath);
    return this.repo.transition(j.id, "RETENTION_ELIGIBLE", { quarantineUntil: null, lastCheckpoint: "restored" });
  }

  storageReport(): Record<string, unknown> {
    const cfg = this.config();
    mkdirSync(cfg.datasetRoot, { recursive: true });
    const fs = statfsSync(cfg.datasetRoot);
    const datasets = dirSize(cfg.datasetRoot);
    const raw = cfg.ingestRoots.reduce((s, r) => s + dirSize(r), 0);
    const quarantine = dirSize(cfg.quarantineDir);
    const models = dirSize(join(this.dataDir, "models"));
    return {
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      categories: {
        retained_datasets: { bytes: datasets, quota: cfg.quotas.sampled_state ?? null, kind: "protected" },
        raw_ingest: { bytes: raw, quota: cfg.quotas.raw_ingest ?? null, kind: "raw" },
        raw_quarantine: { bytes: quarantine, quota: null, kind: "raw (reversible)" },
        models: { bytes: models, quota: cfg.quotas.models ?? null, kind: "regenerable/protected" },
      },
      jobs: this.repo.counts(),
      note: "Backups are separate from raw deletion: a deleted raw demo is not a backup.",
    };
  }
}
