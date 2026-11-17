import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CRASH_REPORT_MAX_BYTES, CrashReportUpload } from "@matchframe/cloud-contracts";
import type { CrashDetails } from "@matchframe/cloud-contracts";
import type { CrashItem } from "./queue.ts";
import { newReportId } from "./queue.ts";
import { scrubBinary } from "./redact.ts";
import { buildReport, engineErrorFrom, MINIDUMP_ATTACH_MAX_BYTES, OutputTail, REPORT_MAX_BYTES } from "./report.ts";

const OPERATOR = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6";
const DEVICE = "mfd_SignedInComputerCredential_0123456789abcdef";
const HOME = "C:\\Users\\Riley";

function item(over: Partial<CrashItem> = {}, crash: Partial<CrashDetails> = {}): CrashItem {
  return {
    localId: "local",
    status: "queued",
    seq: 1,
    createdAt: "2026-11-17T10:00:00.000Z",
    session: "s",
    crash: {
      reportId: newReportId(),
      occurredAt: "2026-11-17T10:00:00.000Z",
      appVersion: "0.12.4",
      os: { platform: "win32", release: "10.0.22631", arch: "x64" },
      process: "engine",
      reason: "exit code 3",
      error: `Error: request failed with Bearer ${OPERATOR}`,
      stack: `Error: request failed\n    at send (${HOME}\\AppData\\Local\\Programs\\MatchFrame Esports\\resources\\engine\\engine.mjs:10:5)`,
      uptimeSeconds: 12,
      programUptimeSeconds: 40,
      detail: { engineOutput: [`{"level":"info","msg":"overlay http://127.0.0.1:37212/hud/x/live?t=hudtoken123 ready"}`, `signed in as ${DEVICE}`] },
      ...crash,
    },
    supportFile: { app: { version: "0.12.4" }, cloud: { apiKey: "sk_live_1", url: "https://matchframe.example" }, logs: [{ msg: `password=${"hunter2"}x and ${OPERATOR}` }], dataDir: `${HOME}\\AppData\\Roaming\\MatchFrame Esports` },
    supportFileAt: "2026-11-17T10:00:01.000Z",
    wantsSupportFile: false,
    minidump: null,
    attempts: 0,
    nextAttemptAt: "2026-11-17T10:00:00.000Z",
    lastError: null,
    repeats: 0,
    ...over,
  };
}

describe("what a crash report sends (ADR-077)", () => {
  it("redacts the crash, the engine's output and the support file with every secret the program knows, and the home folder", () => {
    const it0 = item({ repeats: 2 });
    const { report, json, body } = buildReport(it0, { secrets: [OPERATOR, DEVICE, null], home: HOME, minidump: null });
    const text = json.toString("utf8");
    for (const secret of [OPERATOR, DEVICE, "hudtoken123", "sk_live_1", "hunter2", "Riley"]) expect(text).not.toContain(secret);
    expect(report.crash.reportId).toBe(it0.crash.reportId);
    expect(report.crash.error).toBe("Error: request failed with Bearer [redacted]");
    expect(report.crash.stack).toContain("at send (~\\AppData\\Local\\Programs\\MatchFrame Esports");
    expect(report.crash.detail).toMatchObject({ repeats: 2, supportFileAt: "2026-11-17T10:00:01.000Z", engineOutput: [expect.stringContaining("?t=[redacted]"), "signed in as [redacted]"] });
    expect(report.supportFile).toEqual({ app: { version: "0.12.4" }, cloud: { apiKey: "[redacted]", url: "https://matchframe.example" }, logs: [{ msg: "password=[redacted] and [redacted]" }], dataDir: "~\\AppData\\Roaming\\MatchFrame Esports" });
    // What the website validates, gzip-compressed.
    expect(CrashReportUpload.parse(JSON.parse(gunzipSync(body).toString("utf8")))).toEqual(report);
  });

  it("keeps a report within the website's 10 MB: the minidump goes first, then the older half of the longest lists, then the support file", () => {
    expect(REPORT_MAX_BYTES).toBe(CRASH_REPORT_MAX_BYTES);
    const max = 64 * 1024;
    const logs = Array.from({ length: 400 }, (_, i) => ({ msg: `log line ${i} ${"x".repeat(200)}` }));
    const dump = Buffer.alloc(30 * 1024, 1);
    const withDump = buildReport(item({ supportFile: { logs }, minidump: { path: "x.dmp", name: "x.dmp", size: dump.length } }), { secrets: [], home: null, minidump: dump, maxBytes: max });
    expect(withDump.trimmed).toEqual(["minidump", "support file lists"]);
    expect(withDump.json.length).toBeLessThanOrEqual(max);
    expect(withDump.report.minidump).toBeNull();
    expect(withDump.report.crash.detail.minidump).toEqual({ name: "x.dmp", size: dump.length, attached: false });
    // The newest log lines are the ones kept.
    const kept = (withDump.report.supportFile!.logs as { msg: string }[]).map((l) => l.msg);
    expect(kept.at(-1)).toMatch(/^log line 399 /);
    expect(kept.length).toBeLessThan(400);

    const oneBigValue = buildReport(item({ supportFile: { blob: "y".repeat(100 * 1024) } }), { secrets: [], home: null, minidump: null, maxBytes: max });
    expect(oneBigValue.trimmed).toEqual(["support file lists", "support file"]);
    expect(oneBigValue.report.supportFile).toBeNull();
    expect(oneBigValue.report.crash.detail.supportFileOmitted).toBe("larger than 0 MB");
    expect(oneBigValue.json.length).toBeLessThanOrEqual(max);
  });

  it("attaches a small minidump with the program's secrets overwritten, and only names a large one", () => {
    const memory = Buffer.concat([Buffer.from("MDMP header "), Buffer.from(OPERATOR, "latin1"), Buffer.from(" stack "), Buffer.from(DEVICE, "utf16le"), Buffer.from(" end")]);
    const { data, replaced } = scrubBinary(memory, [OPERATOR, DEVICE, "", null]);
    expect(replaced).toBe(2);
    expect(data.length).toBe(memory.length);
    expect(data.includes(Buffer.from(OPERATOR, "latin1"))).toBe(false);
    expect(data.includes(Buffer.from(DEVICE, "utf16le"))).toBe(false);
    expect(data.subarray(0, 12).toString()).toBe("MDMP header ");
    // The file itself is left alone.
    expect(memory.includes(Buffer.from(OPERATOR, "latin1"))).toBe(true);

    const small = buildReport(item({ minidump: { path: "a.dmp", name: "a.dmp", size: memory.length } }, { process: "native", reason: "minidump" }), { secrets: [OPERATOR, DEVICE], home: null, minidump: memory });
    expect(small.report.minidump).toEqual({ name: "a.dmp", size: memory.length, base64: data.toString("base64") });
    expect(small.report.crash.detail.minidump).toEqual({ name: "a.dmp", size: memory.length, attached: true });

    const big = Buffer.alloc(MINIDUMP_ATTACH_MAX_BYTES + 1);
    const large = buildReport(item({ minidump: { path: "b.dmp", name: "b.dmp", size: big.length } }), { secrets: [], home: null, minidump: big });
    expect(large.report.minidump).toBeNull();
    expect(large.report.crash.detail.minidump).toEqual({ name: "b.dmp", size: big.length, attached: false });
  });

  it("keeps the engine's last lines and finds its last error in them", () => {
    const tail = new OutputTail(3);
    tail.push("line 1\nline 2\n");
    tail.push('{"level":"error","msg":"uncaught exception","data":{"error":"TypeError: x is undefined\\n    at f (engine.mjs:1:1)"}}\nline');
    tail.push(" 4 continued\r\n");
    expect(tail.snapshot()).toEqual(["line 2", '{"level":"error","msg":"uncaught exception","data":{"error":"TypeError: x is undefined\\n    at f (engine.mjs:1:1)"}}', "line 4 continued"]);
    expect(engineErrorFrom(tail.snapshot())).toEqual({ error: "uncaught exception: TypeError: x is undefined", stack: "TypeError: x is undefined\n    at f (engine.mjs:1:1)" });
    expect(engineErrorFrom(["starting", "MatchFrame engine failed to start: port 37211 is in use", '{"level":"info","msg":"x"}'])).toEqual({ error: "MatchFrame engine failed to start: port 37211 is in use", stack: null });
    expect(engineErrorFrom(['{"level":"info","msg":"all good"}'])).toBeNull();
  });
});
