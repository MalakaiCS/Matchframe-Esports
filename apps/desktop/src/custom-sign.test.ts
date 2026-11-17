import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- a plain JavaScript module (electron-builder loads it), no type declarations
import signHook from "../custom-sign.mjs";

/** The custom code signing hook (custom-sign.mjs): a CA's signing tool plugs in through WIN_SIGN_COMMAND. */
const sign = signHook as (c: { path: string; isNest?: boolean }) => Promise<void>;

describe("custom signing command", () => {
  const saved = process.env.WIN_SIGN_COMMAND;
  afterEach(() => {
    if (saved === undefined) delete process.env.WIN_SIGN_COMMAND;
    else process.env.WIN_SIGN_COMMAND = saved;
  });

  it("runs the command once per file with the file's path in place of {file}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-sign-"));
    const target = join(dir, "MatchFrame Esports.exe");
    const log = join(dir, "signed.log");
    writeFileSync(join(dir, "tool.cjs"), `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");`);
    process.env.WIN_SIGN_COMMAND = `node ${JSON.stringify(join(dir, "tool.cjs"))} {file}`;
    await sign({ path: target });
    await sign({ path: target, isNest: true });
    expect(readFileSync(log, "utf8")).toBe(`${target}\n`);
  });

  it("fails without showing the command, which may hold credentials", async () => {
    process.env.WIN_SIGN_COMMAND = `node -e "process.exit(3)" hunter2`;
    const error = await sign({ path: "/tmp/x.exe" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exit code 3");
    expect((error as Error).message).not.toContain("hunter2");
  });
});
