// The engine's support-file pass (services/local-engine/src/support-redact.ts), shared so the
// program and the engine redact the same way.
import { REDACTED, redactSupport, textScrubber } from "../../../../services/local-engine/src/support-redact.ts";
import type { RedactOptions } from "../../../../services/local-engine/src/support-redact.ts";

export { REDACTED, redactSupport, textScrubber };
export type { RedactOptions };

/**
 * A minidump is memory, so it can hold a secret the crashed process had (the operator token, the
 * website credential). Every secret the program knows is overwritten where it appears, as one-byte
 * text and as UTF-16 (how V8 and Windows keep strings). Returns a copy; the file is left as it is.
 */
export function scrubBinary(data: Buffer, secrets: readonly (string | null | undefined)[]): { data: Buffer; replaced: number } {
  const out = Buffer.from(data);
  let replaced = 0;
  for (const s of new Set(secrets)) {
    if (typeof s !== "string" || s.length < 6) continue;
    for (const needle of [Buffer.from(s, "latin1"), Buffer.from(s, "utf16le")]) {
      for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + needle.length)) {
        out.fill(0x58, at, at + needle.length); // "X"
        replaced++;
      }
    }
  }
  return { data: out, replaced };
}
