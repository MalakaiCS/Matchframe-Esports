import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CrashDetails, CrashProcess } from "@matchframe/cloud-contracts";

/**
 * Crash reports kept on this computer until they are sent (ADR-077), in
 * `<userData>/crash-reports/`: one JSON file per report, and `state.json` with the reports sent
 * lately (their ids, for Settings) and the minidumps already looked at. Pure Node; writes are atomic
 * (temporary file + rename).
 *
 * A report waits for the operator's answer ("awaiting-consent": crash reports were off when it
 * happened; the next start asks once) or to be sent ("queued": crash reports on, or Send). Sending
 * that fails is tried again later, with growing waits. The queue keeps at most `maxItems` reports and
 * `maxBytes` in all, dropping the oldest; the same crash again within `foldMs` is counted on the
 * report already there (or the one just sent) instead of making another.
 */

export type CrashItemStatus = "awaiting-consent" | "queued";

export interface CrashItem {
  /** Also the report's id for the website (`crash.reportId`), which recognises a report sent twice. */
  localId: string;
  status: CrashItemStatus;
  /** Order of recording (two crashes can share a millisecond). */
  seq: number;
  createdAt: string;
  /** The program start that recorded it ("" when found at a later start, e.g. a minidump). */
  session: string;
  crash: CrashDetails;
  supportFile: Record<string, unknown> | null;
  /** When the support file was taken (at the crash, or later from the restarted engine). */
  supportFileAt: string | null;
  /** The support file is still to be fetched from the engine before sending. */
  wantsSupportFile: boolean;
  minidump: { path: string; name: string; size: number } | null;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  /** The same crash again while this report waited. */
  repeats: number;
}

export interface SentRecord {
  id: string;
  localId: string;
  process: CrashProcess;
  sentAt: string;
  signature: string;
  /** The same crash again within the fold window after it was sent (not sent again). */
  repeatsAfter: number;
}

interface StateFile {
  sent: SentRecord[];
  seenDumps: string[];
}

export interface NewCrash {
  crash: CrashDetails;
  supportFile?: Record<string, unknown> | null;
  wantsSupportFile?: boolean;
  minidump?: CrashItem["minidump"];
}

/** Waits before sending again after a failure: 1 min, 5 min, 15 min, 1 h, then every 6 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
/** A report not sent within 30 days is dropped. */
const GIVE_UP_MS = 30 * 86_400_000;
const SENT_KEPT = 10;
const DUMPS_KEPT = 200;

export const signatureOf = (c: CrashDetails) => `${c.process}|${c.reason}|${(c.error ?? "").split("\n")[0]!.slice(0, 200)}${typeof c.detail.hudId === "string" ? `|${c.detail.hudId}` : ""}`;

export const newReportId = () => randomBytes(16).toString("base64url");

export class CrashQueue {
  private readonly list = new Map<string, CrashItem>();
  private state: StateFile = { sent: [], seenDumps: [] };
  private stateExisted = false;
  private readonly now: () => number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxItemBytes: number;
  readonly foldMs: number;

  constructor(
    private readonly opts: { dir: string; session: string; now?: () => number; maxItems?: number; maxBytes?: number; maxItemBytes?: number; foldMs?: number; log?: (msg: string) => void },
  ) {
    this.now = opts.now ?? Date.now;
    this.maxItems = opts.maxItems ?? 20;
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.maxItemBytes = opts.maxItemBytes ?? 10 * 1024 * 1024;
    this.foldMs = opts.foldMs ?? 30 * 60_000;
  }

  /** Reads what is on disk; unreadable files are removed. */
  load(): this {
    mkdirSync(this.opts.dir, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<StateFile>;
      this.state = { sent: Array.isArray(raw.sent) ? raw.sent.slice(-SENT_KEPT) : [], seenDumps: Array.isArray(raw.seenDumps) ? raw.seenDumps.filter((x) => typeof x === "string") : [] };
      this.stateExisted = true;
    } catch {
      this.state = { sent: [], seenDumps: [] };
    }
    for (const name of readdirSync(this.opts.dir)) {
      if (!/^[A-Za-z0-9_-]{16,64}\.json$/.test(name)) continue;
      const file = join(this.opts.dir, name);
      try {
        const it = JSON.parse(readFileSync(file, "utf8")) as CrashItem;
        if (!it || typeof it.localId !== "string" || !it.crash || `${it.localId}.json` !== name) throw new Error("not a crash report");
        this.list.set(it.localId, it);
      } catch {
        this.opts.log?.(`[crash] removing unreadable ${name}`);
        rmSync(file, { force: true });
      }
    }
    return this;
  }

  /** No state file before this start: the first start with crash reports (minidumps already there are not reported). */
  get firstRun(): boolean {
    return !this.stateExisted;
  }

  items(): CrashItem[] {
    return [...this.list.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt.localeCompare(b.createdAt));
  }

  get(localId: string): CrashItem | undefined {
    return this.list.get(localId);
  }

  /**
   * Keeps a crash: queued when crash reports are on (`consent`), else waiting for the next start's
   * question. The same crash again within the fold window is counted instead (returns null).
   */
  record(input: NewCrash, consent: boolean, opts: { earlierRun?: boolean; sendAfterMs?: number } = {}): CrashItem | null {
    const now = this.now();
    const sig = signatureOf(input.crash);
    const same = this.items().find((i) => signatureOf(i.crash) === sig && now - Date.parse(i.createdAt) < this.foldMs);
    if (same) {
      this.save({ ...same, repeats: same.repeats + 1 });
      return null;
    }
    const sent = this.state.sent.findLast((s) => s.signature === sig && now - Date.parse(s.sentAt) < this.foldMs);
    if (sent) {
      sent.repeatsAfter++;
      this.saveState();
      return null;
    }
    const item: CrashItem = {
      localId: input.crash.reportId,
      status: consent ? "queued" : "awaiting-consent",
      seq: Math.max(0, ...[...this.list.values()].map((i) => i.seq ?? 0)) + 1,
      createdAt: new Date(now).toISOString(),
      session: opts.earlierRun ? "" : this.opts.session,
      crash: input.crash,
      supportFile: input.supportFile ?? null,
      supportFileAt: input.supportFile ? new Date(now).toISOString() : null,
      wantsSupportFile: !input.supportFile && (input.wantsSupportFile ?? false),
      minidump: input.minidump ?? null,
      attempts: 0,
      nextAttemptAt: new Date(now + (opts.sendAfterMs ?? 0)).toISOString(),
      lastError: null,
      repeats: 0,
    };
    this.save(item);
    this.enforceCaps(item.localId);
    return this.list.get(item.localId) ?? null;
  }

  /** Changes a report (a support file or minidump found later). */
  update(localId: string, patch: Partial<Omit<CrashItem, "localId">>): CrashItem | null {
    const it = this.list.get(localId);
    if (!it) return null;
    const next = { ...it, ...patch };
    this.save(next);
    return this.list.get(localId) ?? null;
  }

  /** Reports waiting for an answer from an earlier start: the ones the next-start question is about. */
  awaitingFromEarlier(): CrashItem[] {
    return this.items().filter((i) => i.status === "awaiting-consent" && i.session !== this.opts.session);
  }

  /** The operator's answer: Send (or Always send) queues them now, Don't send deletes them. */
  resolve(localIds: readonly string[], answer: "send" | "discard"): void {
    for (const id of localIds) {
      const it = this.list.get(id);
      if (!it) continue;
      if (answer === "discard") this.remove(id);
      else this.save({ ...it, status: "queued", nextAttemptAt: new Date(this.now()).toISOString() });
    }
  }

  /** Crash reports turned on: every waiting report is queued. Turned off: queued reports wait again (the next start asks about them). */
  setConsent(on: boolean): void {
    for (const it of this.items()) {
      if (on && it.status === "awaiting-consent") this.save({ ...it, status: "queued", nextAttemptAt: new Date(this.now()).toISOString() });
      else if (!on && it.status === "queued") this.save({ ...it, status: "awaiting-consent", session: "" });
    }
  }

  /** Queued reports whose time to send has come (reports older than 30 days are dropped here). */
  due(): CrashItem[] {
    const now = this.now();
    for (const it of this.items()) if (now - Date.parse(it.createdAt) > GIVE_UP_MS) this.remove(it.localId);
    return this.items().filter((i) => i.status === "queued" && Date.parse(i.nextAttemptAt) <= now);
  }

  /** The earliest time a queued report is due, or null. */
  nextDueAt(): number | null {
    const times = this.items()
      .filter((i) => i.status === "queued")
      .map((i) => Date.parse(i.nextAttemptAt));
    return times.length ? Math.min(...times) : null;
  }

  markSent(localId: string, id: string): SentRecord | null {
    const it = this.list.get(localId);
    if (!it) return null;
    const rec: SentRecord = { id, localId, process: it.crash.process, sentAt: new Date(this.now()).toISOString(), signature: signatureOf(it.crash), repeatsAfter: 0 };
    this.state.sent = [...this.state.sent, rec].slice(-SENT_KEPT);
    this.saveState();
    this.remove(localId);
    return rec;
  }

  /** A failed send: tried again later (`retry`), or dropped (the website refused the report itself). */
  markFailed(localId: string, error: string, retry: boolean): void {
    const it = this.list.get(localId);
    if (!it) return;
    if (!retry) {
      this.opts.log?.(`[crash] dropping report ${localId}: ${error}`);
      this.remove(localId);
      return;
    }
    const wait = BACKOFF_MS[Math.min(it.attempts, BACKOFF_MS.length - 1)]!;
    this.save({ ...it, attempts: it.attempts + 1, lastError: error.slice(0, 300), nextAttemptAt: new Date(this.now() + wait).toISOString() });
  }

  /** Sent lately, newest first. */
  sent(): SentRecord[] {
    return [...this.state.sent].reverse();
  }

  isDumpSeen(name: string): boolean {
    return this.state.seenDumps.includes(name);
  }

  markDumpsSeen(names: readonly string[]): void {
    const add = names.filter((n) => !this.state.seenDumps.includes(n));
    if (!add.length && this.stateExisted) return;
    this.state.seenDumps = [...this.state.seenDumps, ...add].slice(-DUMPS_KEPT);
    this.saveState();
  }

  /** For Settings: how many wait, the reports sent lately, and the last error while sending. */
  summary(): { queued: number; waiting: number; recent: { id: string; process: CrashProcess; sentAt: string }[]; lastError: string | null } {
    const items = this.items();
    return {
      queued: items.filter((i) => i.status === "queued").length,
      waiting: items.filter((i) => i.status === "awaiting-consent").length,
      recent: this.sent().map(({ id, process, sentAt }) => ({ id, process, sentAt })),
      lastError: items.findLast((i) => i.lastError)?.lastError ?? null,
    };
  }

  // ------------------------------------------------------------------ storage

  private get stateFile(): string {
    return join(this.opts.dir, "state.json");
  }

  private fileOf(localId: string): string {
    return join(this.opts.dir, `${localId}.json`);
  }

  private write(file: string, text: string): void {
    mkdirSync(this.opts.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Writes a report; one larger than a report may be is kept without its support file. */
  private save(item: CrashItem): void {
    let text = JSON.stringify(item);
    if (Buffer.byteLength(text) > this.maxItemBytes && item.supportFile) {
      item = { ...item, supportFile: null, wantsSupportFile: false, crash: { ...item.crash, detail: { ...item.crash.detail, supportFileOmitted: `larger than ${Math.round(this.maxItemBytes / 1024 / 1024)} MB` } } };
      text = JSON.stringify(item);
    }
    this.write(this.fileOf(item.localId), text);
    this.list.set(item.localId, item);
  }

  private saveState(): void {
    this.write(this.stateFile, JSON.stringify(this.state));
    this.stateExisted = true;
  }

  private remove(localId: string): void {
    this.list.delete(localId);
    rmSync(this.fileOf(localId), { force: true });
  }

  /** Oldest reports go first; `keep` (the one just recorded) stays. */
  private enforceCaps(keep: string): void {
    const sizeOf = (id: string) => {
      try {
        return statSync(this.fileOf(id)).size;
      } catch {
        return 0;
      }
    };
    let items = this.items();
    let bytes = items.reduce((n, i) => n + sizeOf(i.localId), 0);
    while (items.length > 1 && (items.length > this.maxItems || bytes > this.maxBytes)) {
      const oldest = items.find((i) => i.localId !== keep)!;
      bytes -= sizeOf(oldest.localId);
      this.opts.log?.(`[crash] queue full: dropping the oldest report (${oldest.crash.process}, ${oldest.createdAt})`);
      this.remove(oldest.localId);
      items = this.items();
    }
  }
}
