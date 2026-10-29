import { existsSync } from "node:fs";
import { z } from "zod";
import type { SecretStore } from "../auth.ts";
import type { DemoJobRepo, SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import type { DemoLibrary, WorkerRunner } from "./library.ts";

/** Where datasets go: an FTP server (a storage box). The password is in the secret store. */
export const StorageSettings = z.object({
  enabled: z.boolean().default(false),
  host: z.string().max(255).default(""),
  port: z.number().int().min(1).max(65535).default(21),
  username: z.string().max(255).default(""),
  remoteDir: z.string().max(500).default("/matchframe"),
  /** `ftps`: the login and every file encrypted (explicit TLS); `plain`: unencrypted FTP. */
  secure: z.enum(["ftps", "plain"]).default("ftps"),
  /** SHA-256 of the server's TLS certificate, trusted at the first successful test. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});
export type StorageSettings = z.infer<typeof StorageSettings>;

export interface UploadRecord {
  remote: string;
  at: string;
  bytes: number;
  /** Features and POV labels were built before the upload. */
  features: boolean;
}

const SETTINGS_KEY = "demos.storage";
const UPLOADS_KEY = "demos.uploads";
const PASSWORD_KEY = "demos.storagePassword";
/** After a failed upload, the next try waits this long (a server down, a wrong password). */
const RETRY_MS = 10 * 60_000;
/** Datasets that can go up: committed, whatever has happened to the raw demo since. */
const UPLOADABLE = ["COMMITTED", "RETENTION_ELIGIBLE", "QUARANTINED_RAW", "RAW_REMOVED"] as const;

/**
 * Uploads each committed dataset to the storage, after building its features and POV labels
 * (`build-features`), one at a time, never during a live broadcast. A demo with the retention
 * policy `remove_after_upload` is deleted (after its quarantine) only once its upload is recorded.
 */
export class DatasetStorage {
  private busy = false;
  private nextTryAt = 0;
  current: { jobId: string; step: "features" | "upload"; progress: number } | null = null;
  lastError: { at: string; jobId: string | null; message: string } | null = null;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      secrets: SecretStore;
      repo: DemoJobRepo;
      runner: WorkerRunner;
      library: DemoLibrary;
      logger: Logger;
      isLive: () => boolean;
      now?: () => number;
    },
  ) {
    deps.library.isUploaded = (sha) => sha in this.uploads();
    deps.library.afterProcess = () => void this.tick();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  settings(): StorageSettings {
    const r = StorageSettings.safeParse(this.deps.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : StorageSettings.parse({});
  }

  /** Saves settings; a new host or port forgets the trusted certificate. `password` undefined keeps it, null removes it. */
  setSettings(patch: Partial<Omit<StorageSettings, "fingerprint">> & { password?: string | null }): StorageSettings {
    const { password, ...rest } = patch;
    const cur = this.settings();
    const next = StorageSettings.parse({ ...cur, ...rest });
    if (next.host !== cur.host || next.port !== cur.port) next.fingerprint = null;
    this.deps.settings.set(SETTINGS_KEY, next);
    if (password !== undefined) this.deps.secrets.setSecret(PASSWORD_KEY, password ? password : null);
    this.nextTryAt = 0;
    this.lastError = null;
    return next;
  }

  /** Forgets the trusted certificate (after the server's certificate was changed on purpose). */
  forgetCertificate(): void {
    this.deps.settings.set(SETTINGS_KEY, { ...this.settings(), fingerprint: null });
    this.nextTryAt = 0;
  }

  hasPassword(): boolean {
    return !!this.deps.secrets.getSecret(PASSWORD_KEY);
  }

  uploads(): Record<string, UploadRecord> {
    return this.deps.settings.get<Record<string, UploadRecord>>(UPLOADS_KEY, {});
  }

  private env(s: StorageSettings): Record<string, string> {
    return {
      MF_STORAGE_HOST: s.host,
      MF_STORAGE_PORT: String(s.port),
      MF_STORAGE_USER: s.username,
      MF_STORAGE_PASSWORD: this.deps.secrets.getSecret(PASSWORD_KEY) ?? "",
      MF_STORAGE_SECURE: s.secure,
      MF_STORAGE_FINGERPRINT: s.fingerprint ?? "",
    };
  }

  /** Logs in and writes, checks and deletes a test file. The first good FTPS test trusts the server's certificate. */
  async test(): Promise<Record<string, unknown>> {
    const s = this.settings();
    if (!s.host || !s.username) throw Object.assign(new Error("enter the storage server's address and user name first"), { status: 400 });
    const out = await this.deps.runner.run(["storage-test", "--remote-dir", s.remoteDir], undefined, this.env(s));
    if (typeof out.fingerprint === "string" && !s.fingerprint) this.deps.settings.set(SETTINGS_KEY, { ...s, fingerprint: out.fingerprint });
    this.nextTryAt = 0;
    this.lastError = null;
    return out;
  }

  /** The next dataset to upload, if any. */
  private next(): { id: string; datasetDir: string; sha256: string } | null {
    const done = this.uploads();
    for (const state of UPLOADABLE) {
      for (const j of this.deps.repo.list(state, 1000)) {
        if (j.sha256 && j.datasetDir && !(j.sha256 in done) && existsSync(j.datasetDir)) return { id: j.id, datasetDir: j.datasetDir, sha256: j.sha256 };
      }
    }
    return null;
  }

  pending(): number {
    const done = this.uploads();
    let n = 0;
    for (const state of UPLOADABLE) for (const j of this.deps.repo.list(state, 100000)) if (j.sha256 && j.datasetDir && !(j.sha256 in done)) n++;
    return n;
  }

  /** Uploads the next dataset (one at a time; returns at once while one is going). */
  async tick(): Promise<void> {
    const s = this.settings();
    if (this.busy || !s.enabled || !s.host || !s.username || this.now() < this.nextTryAt || this.deps.library.isPaused || this.deps.isLive()) return;
    const job = this.next();
    if (!job) return;
    this.busy = true;
    try {
      this.current = { jobId: job.id, step: "features", progress: 0 };
      let features = true;
      try {
        await this.deps.runner.run(["build-features", "--dataset", job.datasetDir], (p) => {
          if (this.current) this.current.progress = Number(p.fraction ?? 0) || 0;
        });
      } catch (e) {
        // The tables are uploaded anyway: features and labels can be built from them later.
        features = false;
        this.deps.logger.warn("features not built before upload", { jobId: job.id, error: String(e).slice(0, 300) });
      }
      this.current = { jobId: job.id, step: "upload", progress: 0 };
      const out = await this.deps.runner.run(
        ["upload-dataset", "--dataset", job.datasetDir, "--remote-dir", s.remoteDir],
        (p) => {
          if (this.current) this.current.progress = Number(p.fraction ?? 0) || 0;
        },
        this.env(s),
      );
      const record: UploadRecord = { remote: String(out.remote ?? ""), at: new Date(this.now()).toISOString(), bytes: Number(out.bytes ?? 0), features };
      this.deps.settings.set(UPLOADS_KEY, { ...this.uploads(), [job.sha256]: record });
      this.lastError = null;
      this.deps.logger.info("dataset uploaded to storage", { jobId: job.id, remote: record.remote, bytes: record.bytes, status: out.status });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.lastError = { at: new Date(this.now()).toISOString(), jobId: job.id, message: message.slice(0, 500) };
      this.nextTryAt = this.now() + RETRY_MS;
      this.deps.logger.warn("dataset upload failed", { jobId: job.id, error: message.slice(0, 500) });
    } finally {
      this.current = null;
      this.busy = false;
    }
  }

  status(): Record<string, unknown> {
    const s = this.settings();
    const uploads = this.uploads();
    const list = Object.values(uploads);
    return {
      settings: s,
      hasPassword: this.hasPassword(),
      uploaded: list.length,
      uploadedBytes: list.reduce((n, u) => n + u.bytes, 0),
      pending: this.pending(),
      current: this.current,
      lastError: this.lastError,
      nextTryAt: this.nextTryAt > this.now() ? new Date(this.nextTryAt).toISOString() : null,
    };
  }
}
