import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CrashDetails } from "@matchframe/cloud-contracts";
import { CrashQueue, newReportId } from "./queue.ts";
import { uploadReport } from "./report.ts";

const MIN = 60_000;

function crash(over: Partial<CrashDetails> = {}): CrashDetails {
  return {
    reportId: newReportId(),
    occurredAt: "2026-11-17T10:00:00.000Z",
    appVersion: "0.12.4",
    os: { platform: "win32", release: "10.0.22631", arch: "x64" },
    process: "engine",
    reason: "exit code 3",
    error: "Error: boom",
    stack: null,
    uptimeSeconds: 10,
    programUptimeSeconds: 20,
    detail: {},
    ...over,
  };
}

function setup(opts: { session?: string; maxItems?: number; maxBytes?: number; maxItemBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mf-crash-queue-"));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const open = (session = opts.session ?? "run-1") => new CrashQueue({ dir, session, now: clock.now, maxItems: opts.maxItems, maxBytes: opts.maxBytes, maxItemBytes: opts.maxItemBytes }).load();
  return { dir, clock, open };
}

describe("crash report queue (ADR-077)", () => {
  it("keeps crashes on disk: queued when crash reports are on, waiting for the next start's question when off", () => {
    const { open, dir } = setup();
    const q = open("run-1");
    const sent = q.record({ crash: crash({ process: "main", reason: "uncaughtException" }) }, true)!;
    const asked = q.record({ crash: crash({ process: "renderer", reason: "crashed" }), wantsSupportFile: true }, false)!;
    expect([sent.status, asked.status]).toEqual(["queued", "awaiting-consent"]);
    expect(asked.wantsSupportFile).toBe(true);
    // Asked at the next start, not during the run that recorded it.
    expect(q.awaitingFromEarlier()).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([`${asked.localId}.json`, `${sent.localId}.json`].sort());

    const next = open("run-2");
    expect(next.items().map((i) => i.localId)).toEqual([sent.localId, asked.localId]);
    expect(next.awaitingFromEarlier().map((i) => i.localId)).toEqual([asked.localId]);
    expect(next.summary()).toEqual({ queued: 1, waiting: 1, recent: [], lastError: null });
  });

  it("Send queues the waiting reports, Don't send deletes them; turning crash reports on or off moves them", () => {
    const { open } = setup();
    const q = open();
    const a = q.record({ crash: crash({ reason: "exit code 1" }) }, false)!;
    const b = q.record({ crash: crash({ reason: "exit code 2" }) }, false)!;
    q.resolve([a.localId], "send");
    q.resolve([b.localId], "discard");
    expect(q.items().map((i) => [i.localId, i.status])).toEqual([[a.localId, "queued"]]);

    q.setConsent(false);
    expect(q.get(a.localId)!.status).toBe("awaiting-consent");
    // A report put back is asked about at the next start.
    expect(open("run-2").awaitingFromEarlier().map((i) => i.localId)).toEqual([a.localId]);
    q.setConsent(true);
    expect(q.get(a.localId)!.status).toBe("queued");
  });

  it("counts the same crash again instead of keeping another report, also after it was sent", () => {
    const { open, clock } = setup();
    const q = open();
    const first = q.record({ crash: crash() }, true)!;
    expect(q.record({ crash: crash() }, true)).toBeNull();
    expect(q.record({ crash: crash() }, true)).toBeNull();
    expect(q.get(first.localId)!.repeats).toBe(2);
    // Another reason, process or HUD is another crash.
    expect(q.record({ crash: crash({ reason: "signal SIGKILL" }) }, true)).not.toBeNull();
    expect(q.record({ crash: crash({ process: "hud", reason: "crashed", detail: { hudId: "a" } }) }, true)).not.toBeNull();
    expect(q.record({ crash: crash({ process: "hud", reason: "crashed", detail: { hudId: "b" } }) }, true)).not.toBeNull();

    q.markSent(first.localId, "CR-ABCD-EFGH");
    expect(q.record({ crash: crash() }, true)).toBeNull();
    expect(q.sent()[0]).toMatchObject({ id: "CR-ABCD-EFGH", repeatsAfter: 1 });
    clock.advance(31 * MIN);
    expect(q.record({ crash: crash() }, true)).not.toBeNull();
  });

  it("keeps at most 20 reports and 50 MB, dropping the oldest; a report too big is kept without its support file", () => {
    const { open, clock } = setup({ maxItems: 3, maxBytes: 64 * 1024, maxItemBytes: 40 * 1024 });
    const q = open();
    const ids = [1, 2, 3, 4].map((n) => {
      clock.advance(1000);
      return q.record({ crash: crash({ reason: `exit code ${n}` }) }, true)!.localId;
    });
    expect(q.items().map((i) => i.localId)).toEqual(ids.slice(1));

    // Reports of about 31 KB each: a third one takes the queue over 64 KB, so the oldest go.
    const big = (n: number) => {
      clock.advance(1000);
      return q.record({ crash: crash({ reason: `big ${n}` }), supportFile: { logs: "x".repeat(30 * 1024) } }, true)!.localId;
    };
    const b1 = big(1);
    const b2 = big(2);
    expect(q.items().map((i) => i.localId)).toEqual([ids[3], b1, b2]);
    const b3 = big(3);
    expect(q.items().map((i) => i.localId)).toEqual([b2, b3]);
    expect(q.items().reduce((n, i) => n + JSON.stringify(i).length, 0)).toBeLessThanOrEqual(64 * 1024);

    clock.advance(1000);
    const huge = q.record({ crash: crash({ reason: "huge" }), supportFile: { logs: "x".repeat(50 * 1024) } }, true)!;
    expect(huge.supportFile).toBeNull();
    expect(huge.crash.detail.supportFileOmitted).toMatch(/^larger than/);
    expect(q.items().at(-1)!.localId).toBe(huge.localId);
  });

  it("sends again later after a failure, with growing waits, and drops what the website refuses or what is a month old", () => {
    const { open, clock } = setup();
    const q = open();
    const a = q.record({ crash: crash({ reason: "a" }) }, true)!;
    clock.advance(1);
    const b = q.record({ crash: crash({ reason: "b" }) }, true)!;
    clock.advance(1);
    const later = q.record({ crash: crash({ reason: "c" }) }, true, { sendAfterMs: 5000 })!;
    expect(q.due().map((i) => i.localId)).toEqual([a.localId, b.localId]);
    expect(q.nextDueAt()).toBe(Date.parse(a.nextAttemptAt));

    q.markFailed(a.localId, "couldn't reach the website: offline", true);
    q.markFailed(b.localId, "crash report validation failed", false);
    expect(q.get(b.localId)).toBeUndefined();
    expect(q.due()).toEqual([]);
    expect(q.summary().lastError).toBe("couldn't reach the website: offline");

    clock.advance(5000);
    expect(q.due().map((i) => i.localId)).toEqual([later.localId]);
    clock.advance(MIN);
    expect(q.due().map((i) => i.localId)).toEqual([a.localId, later.localId]);
    q.markFailed(a.localId, "offline", true);
    clock.advance(MIN);
    expect(q.due().map((i) => i.localId)).toEqual([later.localId]);
    clock.advance(4 * MIN);
    expect(q.due().map((i) => i.localId)).toEqual([a.localId, later.localId]);
    expect(q.get(a.localId)!.attempts).toBe(2);

    q.markSent(later.localId, "CR-WXYZ-BCDF");
    expect(q.summary()).toEqual({ queued: 1, waiting: 0, recent: [{ id: "CR-WXYZ-BCDF", process: "engine", sentAt: new Date(clock.now()).toISOString() }], lastError: "offline" });
    clock.advance(31 * 24 * 60 * MIN);
    expect(q.due()).toEqual([]);
    expect(q.items()).toEqual([]);
  });

  it("remembers the minidumps it has looked at, and removes files it can't read", () => {
    const { open, dir } = setup();
    const q = open();
    expect(q.firstRun).toBe(true);
    q.markDumpsSeen(["a.dmp"]);
    writeFileSync(join(dir, "AAAAAAAAAAAAAAAAAAAAAA.json"), "{ broken");
    const next = open("run-2");
    expect(next.firstRun).toBe(false);
    expect([next.isDumpSeen("a.dmp"), next.isDumpSeen("b.dmp")]).toEqual([true, false]);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("sending a report", () => {
  const body = Buffer.from("gzip bytes");
  const fake = (status: number, json: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("posts the gzip body, with the device token when signed in", async () => {
    const f = fake(201, { id: "CR-ABCD-EFGH", duplicate: false });
    expect(await uploadReport(body, { url: "https://matchframe.example/", token: "mfd_x", appVersion: "0.12.4", fetch: f.fetchImpl })).toEqual({ kind: "sent", id: "CR-ABCD-EFGH" });
    expect(f.calls[0]!.url).toBe("https://matchframe.example/v1/crash-reports");
    expect(f.calls[0]!.init.headers).toEqual({ "content-type": "application/json", "content-encoding": "gzip", "x-matchframe-version": "0.12.4", authorization: "Bearer mfd_x" });
    expect(Buffer.from(f.calls[0]!.init.body as Uint8Array)).toEqual(body);

    const anon = fake(200, { id: "CR-ABCD-EFGH", duplicate: true });
    expect((await uploadReport(body, { url: "https://matchframe.example", token: null, appVersion: "0.12.4", fetch: anon.fetchImpl })).kind).toBe("sent");
    expect(anon.calls[0]!.init.headers).not.toHaveProperty("authorization");
  });

  it("tries again later when offline, limited or the website fails; drops what the website refuses", async () => {
    const send = (status: number, json: unknown = { message: `answer ${status}` }) => uploadReport(body, { url: "https://w", token: null, appVersion: "1", fetch: fake(status, json).fetchImpl });
    expect(await send(429)).toEqual({ kind: "retry", error: "answer 429" });
    expect(await send(503)).toEqual({ kind: "retry", error: "answer 503" });
    expect(await send(500, null)).toEqual({ kind: "retry", error: "the website answered HTTP 500" });
    expect(await send(400)).toEqual({ kind: "drop", error: "answer 400" });
    expect(await send(413)).toEqual({ kind: "drop", error: "answer 413" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await uploadReport(body, { url: "https://w", token: null, appVersion: "1", fetch: offline })).toEqual({ kind: "retry", error: "couldn't reach the website: fetch failed" });
  });
});
