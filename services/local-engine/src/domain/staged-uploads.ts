import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageInfo } from "./image-check.ts";
import { inspectImage } from "./image-check.ts";

/** Staged files older than this are removed by the sweeper (a form left open for hours re-uploads). */
export const STAGED_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface StagedImage extends ImageInfo {
  stagedId: string;
  previewUrl: string;
}

const ID = /^stg_[0-9a-f]{32}$/;

export class StagedNotFoundError extends Error {
  readonly status = 410;
  readonly code = "staged_gone";
}

/**
 * Images uploaded by an editor before Save and Exit. The bytes are checked and kept under
 * `<dataDir>/staging`; Save promotes them into the content-hashed asset store, Cancel discards them,
 * and the sweeper removes any that were left behind.
 */
export class StagedUploads {
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(id: string, ext: string): string {
    return join(this.dir, `${id}${ext}`);
  }

  /** The staged file of an id (null when unknown, discarded or swept). */
  find(id: string): { path: string; ext: string } | null {
    if (!ID.test(id) || !existsSync(this.dir)) return null;
    for (const ext of [".png", ".jpg", ".webp"]) {
      const p = this.file(id, ext);
      if (existsSync(p)) return { path: p, ext };
    }
    return null;
  }

  /** Checks and stores an upload; throws ImageCheckError for anything that is not a usable image. */
  stage(body: Buffer): StagedImage {
    const info = inspectImage(body);
    mkdirSync(this.dir, { recursive: true });
    const stagedId = `stg_${randomBytes(16).toString("hex")}`;
    writeFileSync(this.file(stagedId, info.ext), body);
    return { ...info, stagedId, previewUrl: `/assets/staged/${stagedId}${info.ext}` };
  }

  /** Reads a staged image for promotion (checked again: the file sat on disk). */
  read(id: string): { body: Buffer; ext: string } {
    const f = this.find(id);
    if (!f) throw new StagedNotFoundError("The uploaded image is no longer available (it expired or was cancelled); upload it again.");
    const body = readFileSync(f.path);
    inspectImage(body);
    return { body, ext: f.ext };
  }

  /** Removes a staged file (Cancel, Remove, or after promotion). Returns whether one was removed. */
  discard(id: string): boolean {
    const f = this.find(id);
    if (!f) return false;
    try {
      unlinkSync(f.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Removes staged files older than maxAgeMs. Returns how many were removed. */
  sweep(maxAgeMs = STAGED_MAX_AGE_MS): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    const cutoff = this.now() - maxAgeMs;
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile() || st.mtimeMs > cutoff) continue;
        unlinkSync(p);
        n++;
      } catch {
        // Removed meanwhile: nothing to do.
      }
    }
    return n;
  }

  /** Staged files present (for tests and diagnostics). */
  list(): string[] {
    return existsSync(this.dir) ? readdirSync(this.dir) : [];
  }
}
